@group(0) @binding(0) var sad_texture: texture_2d<f32>;

// Threshold in shader scale (byte-scale ffmpeg threshold / 255).
@group(0) @binding(1) var<uniform> threshold: f32;

@group(0) @binding(2) var<storage, read_write> count: atomic<u32>;

// One invocation per texel of the mpdecimate output (one texel per 8x8
// block). Counts blocks whose luma SAD exceeds the threshold, as ffmpeg's
// mpdecimate does for its `frac` test.
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>)
{
    let dims: vec2<u32> = textureDimensions(sad_texture);
    if (id.x >= dims.x || id.y >= dims.y)
    {
        return;
    }

    if (textureLoad(sad_texture, id.xy, 0).r > threshold)
    {
        atomicAdd(&count, 1u);
    }
}
