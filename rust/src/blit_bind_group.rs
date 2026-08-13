use crate::{shaders, BlitMode, Context, Texture};
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

/// The sampler and texture bindings consumed by the `blit` shader.
#[wasm_bindgen]
pub struct BlitBindGroup {
    pub(crate) bind_group: shaders::blit::bind_groups::BindGroup0,
}

impl BlitBindGroup {
    pub(crate) fn new(context: &Context, texture: &Texture, mode: BlitMode, threshold: f32) -> Self {
        let sampler = context.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("blit sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let texture_view = texture.view();
        let color_transform_buffer =
            context
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("blit color transform"),
                    contents: &(mode as u32).to_le_bytes(),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
        let threshold_buffer = context
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("blit threshold"),
                contents: &threshold.to_le_bytes(),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let bind_group = shaders::blit::bind_groups::BindGroup0::from_bindings(
            &context.device,
            shaders::blit::bind_groups::BindGroupLayout0 {
                src_sampler: &sampler,
                src_texture: &texture_view,
                color_transform: color_transform_buffer.as_entire_buffer_binding(),
                threshold: threshold_buffer.as_entire_buffer_binding(),
            },
        );

        Self { bind_group }
    }
}
