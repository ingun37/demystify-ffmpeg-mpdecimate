use crate::{shaders, Context, MpdecimateOutputTexture, Texture};
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

/// The sampler and texture bindings consumed by the `blit` shader.
#[wasm_bindgen]
pub struct BlitBindGroup {
    pub(crate) bind_group: shaders::blit::bind_groups::BindGroup0,
    threshold_buffer: wgpu::Buffer,
}

impl BlitBindGroup {
    pub(crate) fn new(context: &Context, texture: &Texture, threshold: f32) -> Self {
        Self::from_view(context, texture.view(), threshold)
    }

    /// Binds the mpdecimate output texture as the blit source so its per-block
    /// SAD values can be visualized, normalized by `threshold`.
    pub(crate) fn new_for_mpdecimate_output(
        context: &Context,
        output: &MpdecimateOutputTexture,
        threshold: f32,
    ) -> Self {
        Self::from_view(context, output.view(), threshold)
    }

    fn from_view(context: &Context, texture_view: wgpu::TextureView, threshold: f32) -> Self {
        let sampler = context.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("blit sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let threshold_buffer = context
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("blit threshold"),
                contents: &threshold.to_le_bytes(),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
        let bind_group = shaders::blit::bind_groups::BindGroup0::from_bindings(
            &context.device,
            shaders::blit::bind_groups::BindGroupLayout0 {
                src_sampler: &sampler,
                src_texture: &texture_view,
                threshold: threshold_buffer.as_entire_buffer_binding(),
            },
        );

        Self {
            bind_group,
            threshold_buffer,
        }
    }

    /// Updates the threshold that normalizes the source pixel values.
    pub(crate) fn set_threshold(&self, context: &Context, threshold: f32) {
        context
            .queue
            .write_buffer(&self.threshold_buffer, 0, &threshold.to_le_bytes());
    }
}
