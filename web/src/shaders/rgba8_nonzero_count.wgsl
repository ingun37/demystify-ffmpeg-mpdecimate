// An rgba8unorm texture view is exposed to WGSL as texture_2d<f32>; each
// component returned by textureLoad is its normalized byte value.
@group(0) @binding(0) var input_texture: texture_2d<f32>;

// Four u32 values, in RGBA order. WGSL does not permit atomic vector
// components, so this buffer is the atomic representation of a vec4<u32>.
// Clear all four values to zero before dispatching this shader.
@group(0) @binding(1) var<storage, read_write> nonzero_counts: array<atomic<u32>, 4>;

// One invocation per input texel. The dispatch dimensions are
// ceil(texture width / 8) by ceil(texture height / 8).
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let dimensions: vec2<u32> = textureDimensions(input_texture);
    if (id.x >= dimensions.x || id.y >= dimensions.y) {
        return;
    }

    let pixel: vec4<f32> = textureLoad(input_texture, id.xy, 0);
    if (pixel.r != 0.0f) {
        atomicAdd(&nonzero_counts[0], 1u);
    }
    if (pixel.g != 0.0f) {
        atomicAdd(&nonzero_counts[1], 1u);
    }
    if (pixel.b != 0.0f) {
        atomicAdd(&nonzero_counts[2], 1u);
    }
    if (pixel.a != 0.0f) {
        atomicAdd(&nonzero_counts[3], 1u);
    }
}
