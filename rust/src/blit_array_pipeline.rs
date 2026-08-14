use crate::{shaders, Context, Surface};
use wasm_bindgen::prelude::*;

/// The render pipeline generated from the `blit_array` shader.
#[wasm_bindgen]
pub struct BlitArrayPipeline {
    pub(crate) pipeline: wgpu::RenderPipeline,
}

impl BlitArrayPipeline {
    pub(crate) fn new(context: &Context, surface: &Surface) -> Self {
        let shader = shaders::blit_array::create_shader_module(&context.device);
        let layout = shaders::blit_array::create_pipeline_layout(&context.device);
        let format = surface.format();
        let pipeline = context
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("blit array pipeline"),
                layout: Some(&layout),
                vertex: shaders::blit_array::vertex_state(
                    &shader,
                    &shaders::blit_array::vs_entry(),
                ),
                fragment: Some(shaders::blit_array::fragment_state(
                    &shader,
                    &shaders::blit_array::ps_entry([Some(format.into())]),
                )),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleStrip,
                    ..wgpu::PrimitiveState::default()
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                cache: None,
                multiview_mask: None,
            });

        Self { pipeline }
    }
}
