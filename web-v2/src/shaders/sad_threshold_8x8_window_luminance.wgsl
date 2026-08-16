@group(0) @binding(0) var y_texture: texture_2d_array<f32>;
@group(0) @binding(1) var<uniform> layer_index: u32;
@group(0) @binding(2) var lo_out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var hi_out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var<uniform> lo_threshold: i32;
@group(0) @binding(5) var<uniform> hi_threshold: i32;

const WINDOW_SIZE: u32 = 8u;
const WINDOW_STRIDE: u32 = 4u;
const FIRST_WINDOW_X: u32 = 8u;

fn luma_sad(window_position: vec2<u32>, previous_layer: u32) -> f32
{
    var sad: f32 = 0.0f;
    for (var y: u32 = 0u; y < WINDOW_SIZE; y = y + 1u)
    {
        for (var x: u32 = 0u; x < WINDOW_SIZE; x = x + 1u)
        {
            let position: vec2<u32> = window_position + vec2<u32>(x, y);
            let current: f32 = textureLoad(y_texture, position, layer_index, 0).r;
            let previous: f32 = textureLoad(y_texture, position, previous_layer, 0).r;
            sad = sad + abs(current - previous) * 255.0f;
        }
    }
    return sad;
}

fn passes_threshold(sad: f32, threshold: i32) -> f32
{
    // FFmpeg reports a difference only when the SAD is strictly greater.
    return select(0.0f, 1.0f, sad > f32(threshold));
}

// One texel represents one complete 8x8 luma window. Windows start at x = 8
// and advance by four pixels in both axes, matching FFmpeg's mpdecimate scan.
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>)
{
    let output_dimensions: vec2<u32> = textureDimensions(lo_out);
    if (id.x >= output_dimensions.x || id.y >= output_dimensions.y)
    {
        return;
    }

    let layer_count: u32 = textureNumLayers(y_texture);
    let previous_layer: u32 = select(layer_index - 1u, layer_count - 1u, layer_index == 0u);
    let window_position: vec2<u32> = vec2<u32>(FIRST_WINDOW_X, 0u) + id.xy * WINDOW_STRIDE;
    let sad: f32 = luma_sad(window_position, previous_layer);

    let lo: f32 = passes_threshold(sad, lo_threshold);
    let hi: f32 = passes_threshold(sad, hi_threshold);
    textureStore(lo_out, vec2<i32>(id.xy), vec4<f32>(lo, lo, lo, 1.0f));
    textureStore(hi_out, vec2<i32>(id.xy), vec4<f32>(hi, hi, hi, 1.0f));
}
