use crate::{shaders, Context, Surface};
use wasm_bindgen::prelude::*;

/// The render pipeline generated from the `blit` shader.
#[wasm_bindgen]
pub struct BlitPipeline {
    pub(crate) pipeline: wgpu::RenderPipeline,
}

impl BlitPipeline {
    pub(crate) fn new(context: &Context, surface: &Surface) -> Self {
        let shader = shaders::blit::create_shader_module(&context.device);
        let layout = shaders::blit::create_pipeline_layout(&context.device);
        let format = surface.format();
        let pipeline = context
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("blit pipeline"),
                layout: Some(&layout),
                vertex: shaders::blit::vertex_state(&shader, &shaders::blit::vs_entry()),
                fragment: Some(shaders::blit::fragment_state(
                    &shader,
                    &shaders::blit::ps_entry([Some(format.into())]),
                )),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                cache: None,
                multiview_mask: None,
            });

        Self { pipeline }
    }
}
