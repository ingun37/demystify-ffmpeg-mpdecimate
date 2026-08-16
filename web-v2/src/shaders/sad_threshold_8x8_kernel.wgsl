@group(0) @binding(0) var y_texture: texture_2d_array<f32>;
@group(0) @binding(1) var u_texture: texture_2d_array<f32>;
@group(0) @binding(2) var v_texture: texture_2d_array<f32>;
@group(0) @binding(3) var<uniform> layer_index: u32;
@group(0) @binding(4) var lo_out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var hi_out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(6) var<uniform> lo_threshold: i32;
@group(0) @binding(7) var<uniform> hi_threshold: i32;

const KERNEL_SIZE: u32 = 8u;

fn plane_sad(
    plane: texture_2d_array<f32>,
    output_position: vec2<u32>,
    output_dimensions: vec2<u32>,
    previous_layer: u32,
) -> f32
{
    let plane_dimensions: vec2<u32> = textureDimensions(plane);
    let origin: vec2<u32> = min(
        output_position * plane_dimensions / output_dimensions,
        plane_dimensions - vec2<u32>(1u),
    );
    var sad: f32 = 0.0f;
    for (var y: u32 = 0u; y < KERNEL_SIZE; y = y + 1u)
    {
        for (var x: u32 = 0u; x < KERNEL_SIZE; x = x + 1u)
        {
            let position: vec2<u32> = min(
                origin + vec2<u32>(x, y),
                plane_dimensions - vec2<u32>(1u),
            );
            let current: f32 = textureLoad(plane, position, layer_index, 0).r;
            let previous: f32 = textureLoad(plane, position, previous_layer, 0).r;
            sad = sad + abs(current - previous) * 255.0f;
        }
    }
    return sad;
}

fn passes_threshold(sad: vec3<f32>, threshold: i32) -> vec3<f32>
{
    return step(vec3<f32>(f32(threshold)), sad);
}

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
    let sad: vec3<f32> = vec3<f32>(
        plane_sad(y_texture, id.xy, output_dimensions, previous_layer),
        plane_sad(u_texture, id.xy, output_dimensions, previous_layer),
        plane_sad(v_texture, id.xy, output_dimensions, previous_layer),
    );

    textureStore(lo_out, vec2<i32>(id.xy), vec4<f32>(passes_threshold(sad, lo_threshold), 1.0f));
    textureStore(hi_out, vec2<i32>(id.xy), vec4<f32>(passes_threshold(sad, hi_threshold), 1.0f));
}
