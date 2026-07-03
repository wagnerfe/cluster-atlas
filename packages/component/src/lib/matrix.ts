// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

export type Matrix3 = [number, number, number, number, number, number, number, number, number];
export type Vector2 = [number, number];
export type Vector3 = [number, number, number];
export type Vector4 = [number, number, number, number];

export function matrix3_zero(): Matrix3 {
  return [0, 0, 0, 0, 0, 0, 0, 0, 0];
}

export function matrix3_identity(): Matrix3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function matrix3_matrix_mul_matrix(m1: Matrix3, m2: Matrix3): Matrix3 {
  return [
    m1[0] * m2[0] + m1[3] * m2[1] + m1[6] * m2[2],
    m1[1] * m2[0] + m1[4] * m2[1] + m1[7] * m2[2],
    m1[2] * m2[0] + m1[5] * m2[1] + m1[8] * m2[2],
    m1[0] * m2[3] + m1[3] * m2[4] + m1[6] * m2[5],
    m1[1] * m2[3] + m1[4] * m2[4] + m1[7] * m2[5],
    m1[2] * m2[3] + m1[5] * m2[4] + m1[8] * m2[5],
    m1[0] * m2[6] + m1[3] * m2[7] + m1[6] * m2[8],
    m1[1] * m2[6] + m1[4] * m2[7] + m1[7] * m2[8],
    m1[2] * m2[6] + m1[5] * m2[7] + m1[8] * m2[8],
  ];
}

export function matrix3_matrix_mul_vector(m: Matrix3, v: Vector3): Vector3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function matrix3_vector_mul_matrix(v: Vector3, m: Matrix3): Vector3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

/** Fold a data-space pre-translation into ``m``: returns ``M ∘ T(ox, oy)``,
 *  i.e. a matrix that maps ``p - (ox, oy)`` the way ``m`` maps ``p``. Computed
 *  in f64 so no precision is lost before the f32 GPU upload. */
export function matrix3_fold_translation(m: Matrix3, ox: number, oy: number): Matrix3 {
  return [
    m[0],
    m[1],
    m[2],
    m[3],
    m[4],
    m[5],
    m[0] * ox + m[3] * oy + m[6],
    m[1] * ox + m[4] * oy + m[7],
    m[2] * ox + m[5] * oy + m[8],
  ];
}

/** Rebase ``m`` (data → clip) around the f32-snapped data-space point that
 *  maps to clip (0, 0), for camera-relative GPU rendering.
 *
 *  Uploading ``m`` directly to a f32 uniform breaks down at deep zoom: the
 *  translation column and the per-vertex ``scale * position`` products are
 *  huge (|lon| ~ 117 at street-level scale factors), so their f32 rounding
 *  error reaches many pixels — GPU points visibly drift against the
 *  f64-projected DOM overlays (tooltip ring, highlight). Instead the shader
 *  subtracts ``origin`` from each position *before* the matrix multiply
 *  (exact in f32 for nearby values), and this helper folds the same origin
 *  into the matrix in f64, leaving only small, precisely representable
 *  uniform values. ``origin`` is f32-rounded (Math.fround) so the CPU fold
 *  and the GPU subtraction use the identical value. */
export function matrix3_rebase_f32_origin(m: Matrix3): { matrix: Matrix3; origin: Vector2 } {
  const det = m[0] * m[4] - m[3] * m[1];
  if (!isFinite(det) || det === 0) {
    return { matrix: m, origin: [0, 0] };
  }
  // Solve A·p = -t for the data point at the clip-space center.
  const px = (m[3] * m[7] - m[6] * m[4]) / det;
  const py = (m[6] * m[1] - m[7] * m[0]) / det;
  const ox = Math.fround(px);
  const oy = Math.fround(py);
  if (!isFinite(ox) || !isFinite(oy)) {
    return { matrix: m, origin: [0, 0] };
  }
  return { matrix: matrix3_fold_translation(m, ox, oy), origin: [ox, oy] };
}

export function matrix3_determinant(m: Matrix3): number {
  return (
    m[0] * m[4] * m[8] -
    m[0] * m[5] * m[7] -
    m[1] * m[3] * m[8] +
    m[1] * m[5] * m[6] +
    m[2] * m[3] * m[7] -
    m[2] * m[4] * m[6]
  );
}

export function matrix3_inverse(m: Matrix3): Matrix3 {
  let det = matrix3_determinant(m);
  return [
    (m[4] * m[8] - m[5] * m[7]) / det,
    (m[2] * m[7] - m[1] * m[8]) / det,
    (m[1] * m[5] - m[2] * m[4]) / det,
    (m[5] * m[6] - m[3] * m[8]) / det,
    (m[0] * m[8] - m[2] * m[6]) / det,
    (m[2] * m[3] - m[0] * m[5]) / det,
    (m[3] * m[7] - m[4] * m[6]) / det,
    (m[1] * m[6] - m[0] * m[7]) / det,
    (m[0] * m[4] - m[1] * m[3]) / det,
  ];
}
