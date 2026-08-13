use crate::Context;
use wasm_bindgen::prelude::*;

/// Side length of the block each output texel summarizes.
pub const BLOCK_SIZE: u32 = 8;

/// Float texture holding one (SAD Y, SAD U, SAD V) texel per 8x8 block.
#[wasm_bindgen]
pub struct MpdecimateOutputTexture {
    pub(crate) texture: wgpu::Texture,
    pub(crate) size: wgpu::Extent3d,
}

impl MpdecimateOutputTexture {
    /// Creates the output texture for inputs of `width` x `height` pixels.
    /// The texture has one texel per (partial) 8x8 block.
    pub fn new(context: &Context, width: u32, height: u32) -> Result<Self, JsError> {
        if width == 0 || height == 0 {
            return Err(JsError::new("texture dimensions must be non-zero"));
        }

        let size = wgpu::Extent3d {
            width: width.div_ceil(BLOCK_SIZE),
            height: height.div_ceil(BLOCK_SIZE),
            depth_or_array_layers: 1,
        };
        let texture = context.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("mpdecimate output texture"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba32Float,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });

        Ok(Self { texture, size })
    }

    pub(crate) fn view(&self) -> wgpu::TextureView {
        self.texture
            .create_view(&wgpu::TextureViewDescriptor::default())
    }
}
