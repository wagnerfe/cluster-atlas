// Copyright (c) 2025 Apple Inc. Licensed under MIT License.
//
// One-shot u16 → f32 unpack. Input is packed as ``array<u32>`` where two
// adjacent u16 share each u32 (little-endian: index 2k in the low 16 bits,
// index 2k+1 in the high 16 bits — matches Uint16Array memory layout on
// little-endian hosts, which is every Atlas-supported platform).
//
// The dispatch writes one f32 per invocation into ``f32_buffer``.
//
// Why a separate module instead of folding into ``program.wgsl``: the
// main program already has 5 pipeline variants (f16/f32 × points/density ×
// downsampled/full). Adding "packed input" as a sixth axis would explode
// the matrix and pollute the hot vertex/compute paths. The unpack pass
// runs once per data load (~1 ms on 322 M points on Apple GPU), so the
// extra dispatch cost is invisible compared to its bypass-the-JS-heap
// payoff.

struct UnpackParams {
  count: u32,
  // Linear inverse-map: f32 = min + u16 * scale, where scale = (max - min) / 65535.
  min: f32,
  scale: f32,
  // Padding so the struct is 16-byte aligned (WGSL uniform buffer rule).
  _padding: u32,
}

@group(0) @binding(0) var<storage, read> u16_buffer: array<u32>;
@group(0) @binding(1) var<storage, read_write> f32_buffer: array<f32>;
@group(0) @binding(2) var<uniform> params: UnpackParams;

override wg_unpack: u32 = 256u;
// 2D-dispatch row stride. WebGPU caps any single dispatch dimension at
// 65535, so we tile the work across (workgroups_x = stride / wg_size,
// workgroups_y = ceil(count / stride)). Stride 65536 takes us past
// 4 billion points (workgroups_y ≤ 65535) while keeping
// workgroups_x = 65536 / 256 = 256 ≪ 65535. The host must keep
// ``UNPACK_STRIDE`` in sync — see ``unpack.ts``.
override UNPACK_STRIDE: u32 = 65536u;

@compute @workgroup_size(wg_unpack, 1)
fn unpack(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.y * UNPACK_STRIDE + id.x;
  if (i >= params.count) { return; }
  let pair = u16_buffer[i >> 1u];
  let shift = (i & 1u) * 16u;
  let u16_value = (pair >> shift) & 0xFFFFu;
  f32_buffer[i] = params.min + f32(u16_value) * params.scale;
}
