const g_positions : array<vec2<f32>, i32(4)> = array<vec2<f32>, i32(4)>( vec2<f32>(-1.0f, 1.0f), vec2<f32>(1.0f, 1.0f), vec2<f32>(-1.0f, -1.0f), vec2<f32>(1.0f, -1.0f));

struct VertexOutput
{
    @builtin(position) position : vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) i_vertexId_0 : u32) -> VertexOutput
{
    var output : VertexOutput;
    let fixed_pos: vec2f = g_positions[i_vertexId_0];
    output.position = vec4<f32>(fixed_pos, 0.0f, 1.0f);
    let u: f32 = (fixed_pos.x + 1.0f)/2.0f;
    let v: f32 = 1.0f - (fixed_pos.y + 1.0f)/2.0f;
    output.uv = vec2f(u,v);
    return output;
}


@group(0) @binding(0) var src_sampler: sampler;
@group(0) @binding(1) var src_texture: texture_2d<f32>;

// Color transform modes.
const MODE_NONE: u32 = 0u; // no transform, plain blit
const MODE_Y: u32 = 1u;    // luma, drawn in gray scale
const MODE_U: u32 = 2u;    // chroma U, drawn in blue
const MODE_V: u32 = 3u;    // chroma V, drawn in red
const MODE_THRESHOLD: u32 = 4u; // normalize [0, threshold] to [0, 1]

@group(0) @binding(2) var<uniform> color_transform: u32;
@group(0) @binding(3) var<uniform> threshold: f32;

// BT.601 RGB -> YUV. Y in [0,1], U/V in [-0.5, 0.5].
fn rgb_to_yuv(rgb: vec3<f32>) -> vec3<f32>
{
    let y: f32 = dot(rgb, vec3<f32>(0.299f, 0.587f, 0.114f));
    let u: f32 = dot(rgb, vec3<f32>(-0.168736f, -0.331264f, 0.5f));
    let v: f32 = dot(rgb, vec3<f32>(0.5f, -0.418688f, -0.081312f));
    return vec3<f32>(y, u, v);
}

struct PixelOutput
{
    @location(0) output_0 : vec4<f32>,
};

@fragment
fn ps(@location(0) uv : vec2f) -> PixelOutput
{
    let c: vec4<f32> = textureSample(src_texture, src_sampler, uv);

    var color: vec3<f32> = c.rgb;
    if (color_transform != MODE_NONE)
    {
        let yuv: vec3<f32> = rgb_to_yuv(c.rgb);
        switch (color_transform)
        {
            case MODE_Y:
            {
                color = vec3<f32>(yuv.x);
            }
            case MODE_U:
            {
                color = vec3<f32>(0.0f, 0.0f, yuv.y + 0.5f);
            }
            case MODE_V:
            {
                color = vec3<f32>(yuv.z + 0.5f, 0.0f, 0.0f);
            }
            case MODE_THRESHOLD:
            {
                color = clamp(c.rgb / threshold, vec3<f32>(0.0f), vec3<f32>(1.0f));
            }
            default:
            {
            }
        }
    }

    var _S1 : PixelOutput = PixelOutput( vec4<f32>(color, c.a) );
    return _S1;
}

