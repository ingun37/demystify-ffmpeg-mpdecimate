use crate::Context;
use wasm_bindgen::prelude::*;

/// Side length of the SAD window each output texel summarizes.
pub const BLOCK_SIZE: u32 = 8;
/// Distance between adjacent FFmpeg SAD windows.
pub const BLOCK_STRIDE: u32 = 4;
/// FFmpeg starts its horizontal scan at x = 8.
pub const FIRST_X: u32 = 8;

/// Float texture holding one (SAD Y, SAD U, SAD V) texel per FFmpeg SAD window.
#[wasm_bindgen]
pub struct MpdecimateOutputTexture {
    pub(crate) texture: wgpu::Texture,
    pub(crate) size: wgpu::Extent3d,
}

impl MpdecimateOutputTexture {
    /// Creates the output texture for inputs of `width` x `height` pixels.
    /// The texture has one texel per complete 8x8 window. Windows overlap by
    /// four pixels, matching FFmpeg's `mpdecimate` traversal.
    pub fn new(context: &Context, width: u32, height: u32) -> Result<Self, JsError> {
        if width == 0 || height == 0 {
            return Err(JsError::new("texture dimensions must be non-zero"));
        }

        // FFmpeg visits y = 0, 4, ... while y < h - 7 and x = 8, 12, ...
        // while x < w - 7. A texture cannot have a zero dimension, so reject
        // inputs for which that traversal contains no complete SAD window.
        if width < FIRST_X + BLOCK_SIZE || height < BLOCK_SIZE {
            return Err(JsError::new(
                "mpdecimate requires at least a 16x8 input for one complete SAD window",
            ));
        }

        let size = wgpu::Extent3d {
            width: (width - FIRST_X - BLOCK_SIZE) / BLOCK_STRIDE + 1,
            height: (height - BLOCK_SIZE) / BLOCK_STRIDE + 1,
            depth_or_array_layers: 1,
        };
        let texture = context.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("mpdecimate output texture"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba32Float,
            usage: wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        Ok(Self { texture, size })
    }

    pub(crate) fn view(&self) -> wgpu::TextureView {
        self.texture
            .create_view(&wgpu::TextureViewDescriptor::default())
    }
}
