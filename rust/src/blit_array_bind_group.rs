use crate::{shaders, Context, TextureArray};
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

/// The sampler and texture bindings consumed by the `blit_array` shader.
#[wasm_bindgen]
pub struct BlitArrayBindGroup {
    pub(crate) bind_group: shaders::blit_array::bind_groups::BindGroup0,
    layer_buffer: wgpu::Buffer,
}

impl BlitArrayBindGroup {
    pub(crate) fn new(context: &Context, texture: &TextureArray, layer: u32) -> Self {
        let sampler = context.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("blit array sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let texture_view = texture.view();
        let layer_buffer = context
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("blit array layer"),
                contents: &layer.to_le_bytes(),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
        let bind_group = shaders::blit_array::bind_groups::BindGroup0::from_bindings(
            &context.device,
            shaders::blit_array::bind_groups::BindGroupLayout0 {
                src_sampler: &sampler,
                src_texture: &texture_view,
                layer: layer_buffer.as_entire_buffer_binding(),
            },
        );

        Self {
            bind_group,
            layer_buffer,
        }
    }

    /// Updates which array layer of the source texture is sampled.
    pub(crate) fn set_layer(&self, context: &Context, layer: u32) {
        context
            .queue
            .write_buffer(&self.layer_buffer, 0, &layer.to_le_bytes());
    }
}
