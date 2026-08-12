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


struct PixelOutput
{
    @location(0) output_0 : vec4<f32>,
};

@fragment
fn ps(@location(0) uv : vec2f) -> PixelOutput
{
    let c: vec4<f32> = textureSample(src_texture, src_sampler, uv);

    var _S1 : PixelOutput = PixelOutput( vec4<f32>(c) );
    return _S1;
}

