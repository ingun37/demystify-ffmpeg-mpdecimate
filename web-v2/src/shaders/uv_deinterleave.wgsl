@group(0) @binding(0) var<storage, read> uv_combined: array<u32>;
@group(0) @binding(1) var u_texture: texture_storage_2d_array<r32float, write>;
@group(0) @binding(2) var v_texture: texture_storage_2d_array<r32float, write>;
@group(0) @binding(3) var<uniform> layer_index: u32;

// The buffer contains byte-packed NV12 chroma: U0 V0 U1 V1 ... . Storage
// buffers are addressed as u32s, so each load supplies two chroma samples.
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>)
{
    let dimensions: vec2<u32> = textureDimensions(u_texture);
    if (id.x >= dimensions.x || id.y >= dimensions.y)
    {
        return;
    }

    let chroma_index: u32 = id.y * dimensions.x + id.x;
    let packed: u32 = uv_combined[chroma_index >> 1u];
    let shift: u32 = (chroma_index & 1u) * 16u;
    let u: f32 = f32((packed >> shift) & 0xffu) / 255.0f;
    let v: f32 = f32((packed >> (shift + 8u)) & 0xffu) / 255.0f;
    let position: vec2<i32> = vec2<i32>(id.xy);

    textureStore(u_texture, position, i32(layer_index), vec4<f32>(u, 0.0f, 0.0f, 1.0f));
    textureStore(v_texture, position, i32(layer_index), vec4<f32>(v, 0.0f, 0.0f, 1.0f));
}
