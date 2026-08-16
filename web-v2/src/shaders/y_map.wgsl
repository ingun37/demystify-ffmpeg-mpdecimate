@group(0) @binding(0) var<storage, read> y_bytes: array<u32>;
@group(0) @binding(1) var y_texture: texture_storage_2d_array<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> layer_index: u32;

// The source buffer contains one tightly packed byte per luminance sample.
// Storage buffers are addressed as u32s, so each load supplies four samples.
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>)
{
    let dimensions: vec2<u32> = textureDimensions(y_texture);
    if (id.x >= dimensions.x || id.y >= dimensions.y)
    {
        return;
    }

    let pixel_index: u32 = id.y * dimensions.x + id.x;
    let packed: u32 = y_bytes[pixel_index >> 2u];
    let shift: u32 = (pixel_index & 3u) * 8u;
    let y: f32 = f32((packed >> shift) & 0xffu) / 255.0f;

    textureStore(
        y_texture,
        vec2<i32>(id.xy),
        i32(layer_index),
        vec4<f32>(y, 0.0f, 0.0f, 1.0f),
    );
}
