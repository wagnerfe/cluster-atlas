// Copyright (c) 2025 Apple Inc. Licensed under MIT License.
//
// Wire the u16 → f32 unpack compute pass into the renderer dataflow so
// the JS side never has to allocate ``new Float32Array(N)`` for the
// scatter coordinates. At 322 M rows that single allocation is 1.288 GB
// per axis = 2.576 GB peak heap, which on a stock 4 GB Chrome tab is the
// difference between "renders cleanly" and "blank canvas after pan".

import type { Dataflow, Node } from "../dataflow.js";
import { gpuBuffer } from "./utils.js";

import unpackShaderCode from "./unpack.wgsl?raw";

/** Bounds for u16 → f32 unpack: ``f32 = min + u16 * (max - min) / 65535``. */
export interface CoordsBounds1D {
  min: number;
  max: number;
}

const UNPACK_WG_SIZE = 256;
// 2D-dispatch stride. WebGPU caps a single dispatch dimension at 65535,
// so the kernel walks ``id.y * STRIDE + id.x`` and we dispatch
// ``(STRIDE / wg_size, ceil(count / STRIDE))``. 65536 supports up to
// ~4 B points (65535 * 65536) before workgroups_y overflows. Must stay
// in sync with ``UNPACK_STRIDE`` in ``unpack.wgsl``.
const UNPACK_STRIDE = 65536;

/** Compile the unpack shader module. Cheap (<1 ms) and idempotent — the
 *  dataflow caches the result against ``device``. */
function makeUnpackModule(df: Dataflow, device: Node<GPUDevice>): Node<GPUShaderModule> {
  return df.derive([device], (device) => device.createShaderModule({ code: unpackShaderCode }));
}

/** Compile the unpack compute pipeline + bind group layout. The pipeline
 *  is reused across both axes and across data updates. */
export interface UnpackPipeline {
  pipeline: Node<GPUComputePipeline>;
  bindGroupLayout: Node<GPUBindGroupLayout>;
}

export function makeUnpackPipeline(df: Dataflow, device: Node<GPUDevice>): UnpackPipeline {
  const module = makeUnpackModule(df, device);
  const bindGroupLayout = df.derive([device], (device) =>
    device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ],
    }),
  );
  const pipeline = df.derive([device, module, bindGroupLayout], (device, module, bindGroupLayout) =>
    device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      compute: {
        module,
        entryPoint: "unpack",
        constants: { wg_unpack: UNPACK_WG_SIZE, UNPACK_STRIDE: UNPACK_STRIDE },
      },
    }),
  );
  return { pipeline, bindGroupLayout };
}

/** Per-axis unpack resources. The u16 source buffer is sized to fit
 *  ``ceil(count/2) * 4`` bytes (each u32 holds two adjacent u16). The
 *  uniform buffer is 16 bytes (count u32, min f32, scale f32, padding). */
export interface UnpackAxisResources {
  u16Buffer: Node<GPUBuffer>;
  uniformBuffer: Node<GPUBuffer>;
}

export function makeUnpackAxisResources(
  df: Dataflow,
  device: Node<GPUDevice>,
  count: Node<number>,
): UnpackAxisResources {
  // u32-aligned: 4 bytes per pair of u16 (or one for odd N + 2 bytes pad).
  const u16Bytes = df.derive([count], (c) => Math.max(4, Math.ceil(c / 2) * 4));
  const u16Usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const u16Buffer = df.statefulDerive([device, u16Bytes, u16Usage], gpuBuffer);
  const uniformBuffer = df.statefulDerive(
    [device, df.value(16), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST],
    gpuBuffer,
  );
  return { u16Buffer, uniformBuffer };
}

/** Encode + submit a one-shot compute pass that fills ``f32Dest`` from
 *  ``axis.u16Buffer`` using the linear inverse-map advertised in
 *  ``bounds``. Caller must ensure the u16 buffer was just written via
 *  ``device.queue.writeBuffer`` before invoking this — we issue our own
 *  ``submit`` so the unpack must follow the write in queue order. */
export function runUnpack(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  bindGroupLayout: GPUBindGroupLayout,
  axis: { u16Buffer: GPUBuffer; uniformBuffer: GPUBuffer },
  f32Dest: GPUBuffer,
  count: number,
  bounds: CoordsBounds1D,
): void {
  // Write uniforms (count, min, scale, padding).
  const scratch = new ArrayBuffer(16);
  const view = new DataView(scratch);
  view.setUint32(0, count, /* littleEndian */ true);
  view.setFloat32(4, bounds.min, true);
  // scale = (max - min) / 65535. Encoded once on the host so the shader
  // is a single FMA per invocation.
  const scale = (bounds.max - bounds.min) / 65535;
  view.setFloat32(8, scale, true);
  view.setUint32(12, 0, true);
  device.queue.writeBuffer(axis.uniformBuffer, 0, scratch);

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: axis.u16Buffer } },
      { binding: 1, resource: { buffer: f32Dest } },
      { binding: 2, resource: { buffer: axis.uniformBuffer } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  // 2D dispatch — see ``UNPACK_STRIDE`` comment above. The shader walks
  // ``id.y * STRIDE + id.x`` and bails when ``i >= count``, so it's safe
  // for the y-tiling to over-cover the tail of the buffer.
  const workgroupsX = UNPACK_STRIDE / UNPACK_WG_SIZE;
  const workgroupsY = Math.max(1, Math.ceil(count / UNPACK_STRIDE));
  pass.dispatchWorkgroups(workgroupsX, workgroupsY);
  pass.end();
  device.queue.submit([encoder.finish()]);
}
