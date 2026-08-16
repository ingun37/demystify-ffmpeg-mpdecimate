@group(0) @binding(0) var u_texture: texture_2d_array<f32>;
@group(0) @binding(1) var v_texture: texture_2d_array<f32>;
@group(0) @binding(2) var<uniform> layer_index: u32;
@group(0) @binding(3) var lo_out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var hi_out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var<uniform> lo_threshold: i32;
@group(0) @binding(6) var<uniform> hi_threshold: i32;

const WINDOW_SIZE: u32 = 8u;
const WINDOW_STRIDE: u32 = 4u;
const FIRST_WINDOW_X: u32 = 8u;

fn plane_sad(
    plane: texture_2d_array<f32>,
    window_position: vec2<u32>,
    previous_layer: u32,
) -> f32
{
    var sad: f32 = 0.0f;
    for (var y: u32 = 0u; y < WINDOW_SIZE; y = y + 1u)
    {
        for (var x: u32 = 0u; x < WINDOW_SIZE; x = x + 1u)
        {
            let position: vec2<u32> = window_position + vec2<u32>(x, y);
            let current: f32 = textureLoad(plane, position, layer_index, 0).r;
            let previous: f32 = textureLoad(plane, position, previous_layer, 0).r;
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

// One texel represents one complete 8x8 chroma window. U and V share the
// same dimensions, so their aligned windows can be stored in G and B.
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>)
{
    let output_dimensions: vec2<u32> = textureDimensions(lo_out);
    if (id.x >= output_dimensions.x || id.y >= output_dimensions.y)
    {
        return;
    }

    let layer_count: u32 = textureNumLayers(u_texture);
    let previous_layer: u32 = select(layer_index - 1u, layer_count - 1u, layer_index == 0u);
    let window_position: vec2<u32> = vec2<u32>(FIRST_WINDOW_X, 0u) + id.xy * WINDOW_STRIDE;
    let u_sad: f32 = plane_sad(u_texture, window_position, previous_layer);
    let v_sad: f32 = plane_sad(v_texture, window_position, previous_layer);

    let lo_u: f32 = passes_threshold(u_sad, lo_threshold);
    let lo_v: f32 = passes_threshold(v_sad, lo_threshold);
    let hi_u: f32 = passes_threshold(u_sad, hi_threshold);
    let hi_v: f32 = passes_threshold(v_sad, hi_threshold);
    textureStore(lo_out, vec2<i32>(id.xy), vec4<f32>(0.0f, lo_u, lo_v, 1.0f));
    textureStore(hi_out, vec2<i32>(id.xy), vec4<f32>(0.0f, hi_u, hi_v, 1.0f));
}
