@group(0) @binding(0) var sad_texture: texture_2d<f32>;

// (lo, hi) thresholds in shader scale (byte-scale ffmpeg threshold / 255).
@group(0) @binding(1) var<uniform> thresholds: vec2<f32>;

// counts[0] = blocks over lo, counts[1] = blocks over hi.
@group(0) @binding(2) var<storage, read_write> counts: array<atomic<u32>, 2>;

// One invocation per texel of the mpdecimate output (one texel per 8x8
// block). Counts blocks whose luma SAD exceeds each threshold, as ffmpeg's
// mpdecimate does: any block over hi marks the frame different, and the
// count over lo feeds the `frac` test.
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>)
{
    let dims: vec2<u32> = textureDimensions(sad_texture);
    if (id.x >= dims.x || id.y >= dims.y)
    {
        return;
    }

    let sad: f32 = textureLoad(sad_texture, id.xy, 0).r;
    if (sad > thresholds.x)
    {
        atomicAdd(&counts[0], 1u);
    }
    if (sad > thresholds.y)
    {
        atomicAdd(&counts[1], 1u);
    }
}
