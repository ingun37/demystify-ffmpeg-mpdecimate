use crate::{shaders, Context, MpdecimateOutputTexture, TextureArray};
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

/// The texture bindings consumed by the `mpdecimate` shader.
#[wasm_bindgen]
pub struct MpdecimateBindGroup {
    pub(crate) bind_group: shaders::mpdecimate::bind_groups::BindGroup0,
    index_buffer: wgpu::Buffer,
}

impl MpdecimateBindGroup {
    pub(crate) fn new(
        context: &Context,
        frames: &TextureArray,
        index: u32,
        output: &MpdecimateOutputTexture,
    ) -> Self {
        let frames_view = frames.view();
        let view_c = output.view();
        let index_buffer = context
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("mpdecimate frame index"),
                contents: &index.to_le_bytes(),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
        let bind_group = shaders::mpdecimate::bind_groups::BindGroup0::from_bindings(
            &context.device,
            shaders::mpdecimate::bind_groups::BindGroupLayout0 {
                frames: &frames_view,
                texture_c: &view_c,
                index: index_buffer.as_entire_buffer_binding(),
            },
        );

        Self {
            bind_group,
            index_buffer,
        }
    }

    /// Updates which array layer holds the current frame. The previous frame
    /// is read from layer `index - 1`.
    pub(crate) fn set_index(&self, context: &Context, index: u32) {
        context
            .queue
            .write_buffer(&self.index_buffer, 0, &index.to_le_bytes());
    }
}
