use crate::{shaders, Context, Texture};
use wasm_bindgen::prelude::*;

/// The sampler and texture bindings consumed by the `blit` shader.
#[wasm_bindgen]
pub struct BlitBindGroup {
    pub(crate) bind_group: shaders::blit::bind_groups::BindGroup0,
}

impl BlitBindGroup {
    pub(crate) fn new(context: &Context, texture: &Texture) -> Self {
        let sampler = context.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("blit sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let texture_view = texture.view();
        let bind_group = shaders::blit::bind_groups::BindGroup0::from_bindings(
            &context.device,
            shaders::blit::bind_groups::BindGroupLayout0 {
                src_sampler: &sampler,
                src_texture: &texture_view,
            },
        );

        Self { bind_group }
    }
}
