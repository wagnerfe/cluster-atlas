// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { Dataflow, Node } from "../dataflow.js";
import type { Matrix3 } from "../matrix.js";
import { webglProgram } from "./utils.js";

function shaderSource(hasCategory: boolean) {
  let vertex: string;
  if (hasCategory) {
    vertex = `#version 300 es
      precision highp float;
      uniform mat3 matrix;
      uniform float point_size;
      uniform float alpha;
      uniform vec4 colorScheme[64];

      uniform float ring_width;

      layout(location=0) in float x;
      layout(location=1) in float y;
      layout(location=2) in int category;

      out vec4 color;
      out float survivor;

      void main() {
        gl_Position = vec4(matrix * vec3(x, y, 1), 1);
        // bit 7 of the category byte = survivor flag, bits 0-6 = category index.
        // The attribute is a signed BYTE, so mask before use (bit 7 => negative).
        int cat = category & 0x7F;
        if (cat < 64) {
          color = colorScheme[cat];
        } else {
          color = vec4(0.5, 0.5, 0.5, 1);
        }
        color *= alpha;
        survivor = float((category >> 7) & 1) * alpha;
        // survivor quads expand by the ring width so the ring sits outside the disc
        gl_PointSize = point_size * (1.0 + ring_width * float((category >> 7) & 1));
      }
    `;
  } else {
    vertex = `#version 300 es
      precision highp float;
      uniform mat3 matrix;
      uniform float point_size;
      uniform vec4 colorScheme;
      uniform float alpha;

      layout(location=0) in float x;
      layout(location=1) in float y;

      out vec4 color;
      out float survivor;

      void main() {
        gl_Position = vec4(matrix * vec3(x, y, 1), 1);
        color = colorScheme;
        color *= alpha;
        survivor = 0.0;
        gl_PointSize = point_size;
      }
    `;
  }
  let fragment = `#version 300 es
    precision highp float;
    uniform float point_size;
    uniform float ring_width;
    in vec4 color;
    in float survivor;
    out vec4 outColor;
    void main() {
      float expand = 1.0 + ring_width * (survivor > 0.0 ? 1.0 : 0.0);
      float r = length(gl_PointCoord.xy - vec2(0.5, 0.5)) * point_size * expand;
      float disc_a = max(0.0, min(1.0, point_size / 2.0 - r));
      vec4 c = color * disc_a;
      if (survivor > 0.0 && ring_width > 0.0) {
        // light-red ring spanning [disc edge, disc edge * (1 + ring_width)]
        float ring_outer = point_size / 2.0 * (1.0 + ring_width);
        float ring_a = max(0.0, min(1.0, min(r - point_size / 2.0 + 1.0, ring_outer - r)));
        c += vec4(1.0, 0.35, 0.35, 1.0) * survivor * ring_a * (1.0 - disc_a);
      }
      outColor = c;
    }
  `;
  return { vertex, fragment };
}

type PaintDiscretePointsCommand = (
  matrix: Matrix3,
  pointSize: number,
  alpha: number,
  colors: number[],
  ringWidth: number,
) => void;

export function paintDiscretePointsCommand(
  df: Dataflow,
  gl: Node<WebGL2RenderingContext>,
  x: Node<WebGLBuffer>,
  y: Node<WebGLBuffer>,
  category: Node<WebGLBuffer> | null,
  count: Node<number>,
): Node<PaintDiscretePointsCommand> {
  let hasCategory = category != null;
  let source = shaderSource(hasCategory);
  let program = df.statefulDerive([gl, source.vertex, source.fragment], webglProgram);
  return df.derive(
    [gl, program, x, y, category, count],
    (gl, program, x, y, category, count) => (matrix, radius, alpha, colors, ringWidth) => {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(program.program);

      gl.enableVertexAttribArray(0);
      gl.bindBuffer(gl.ARRAY_BUFFER, x);
      gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(1);
      gl.bindBuffer(gl.ARRAY_BUFFER, y);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
      if (category != null) {
        gl.enableVertexAttribArray(2);
        gl.bindBuffer(gl.ARRAY_BUFFER, category);
        gl.vertexAttribIPointer(2, 1, gl.BYTE, 0, 0);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      gl.uniformMatrix3fv(program.uniforms.matrix, false, matrix);
      gl.uniform1f(program.uniforms.point_size, radius * 2);
      gl.uniform1f(program.uniforms.alpha, alpha);
      if (program.uniforms.ring_width != null) {
        gl.uniform1f(program.uniforms.ring_width, ringWidth);
      }
      if (hasCategory) {
        gl.uniform4fv(program.uniforms.colorScheme, colors);
      } else {
        gl.uniform4fv(program.uniforms.colorScheme, colors.slice(0, 4));
      }

      gl.drawArrays(gl.POINTS, 0, count);

      gl.disableVertexAttribArray(0);
      gl.disableVertexAttribArray(1);
      if (category != null) {
        gl.disableVertexAttribArray(2);
      }
      gl.useProgram(null);
    },
  );
}
