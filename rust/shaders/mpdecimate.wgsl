@group(0) @binding(0) var frames: texture_2d_array<f32>;
@group(0) @binding(1) var texture_c: texture_storage_2d<rgba32float, write>;

// The array layer of the current frame. Layer `index - 1` holds the
// previous frame.
@group(0) @binding(2) var<uniform> index: u32;

const BLOCK_SIZE: u32 = 8u;

// BT.601 RGB -> YUV. Y in [0,1], U/V in [-0.5, 0.5].
fn rgb_to_yuv(rgb: vec3<f32>) -> vec3<f32>
{
    let y: f32 = dot(rgb, vec3<f32>(0.299f, 0.587f, 0.114f));
    let u: f32 = dot(rgb, vec3<f32>(-0.168736f, -0.331264f, 0.5f));
    let v: f32 = dot(rgb, vec3<f32>(0.5f, -0.418688f, -0.081312f));
    return vec3<f32>(y, u, v);
}

// One invocation per 8x8 block. Each invocation sums the absolute YUV
// differences of its block and stores them as (R, G, B) = (SAD Y, SAD U, SAD V).
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>)
{
    let out_dims: vec2<u32> = textureDimensions(texture_c);
    if (id.x >= out_dims.x || id.y >= out_dims.y)
    {
        return;
    }

    let in_dims: vec2<u32> = textureDimensions(frames);
    let origin: vec2<u32> = id.xy * BLOCK_SIZE;
    var sad: vec3<f32> = vec3<f32>(0.0f);
    for (var y: u32 = 0u; y < BLOCK_SIZE; y = y + 1u)
    {
        for (var x: u32 = 0u; x < BLOCK_SIZE; x = x + 1u)
        {
            let p: vec2<u32> = origin + vec2<u32>(x, y);
            if (p.x < in_dims.x && p.y < in_dims.y)
            {
                let a: vec3<f32> = rgb_to_yuv(textureLoad(frames, p, index, 0).rgb);
                let b: vec3<f32> = rgb_to_yuv(textureLoad(frames, p, index - 1u, 0).rgb);
                sad = sad + abs(a - b);
            }
        }
    }

    textureStore(texture_c, id.xy, vec4<f32>(sad, 1.0f));
}
