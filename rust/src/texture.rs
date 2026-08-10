use crate::Context;
use std::convert::TryFrom;
use wasm_bindgen::prelude::*;

/// A one-dimensional texture containing byte values for a compute shader to read.
#[wasm_bindgen]
pub struct Texture {
    texture: wgpu::Texture,
}

impl Texture {
    pub fn from_bytes(context: &Context, bytes: &[u8]) -> Result<Self, JsError> {
        let width =
            u32::try_from(bytes.len()).map_err(|_| JsError::new("texture data is too large"))?;

        if width == 0 {
            return Err(JsError::new("texture data must not be empty"));
        }

        let size = wgpu::Extent3d {
            width,
            height: 1,
            depth_or_array_layers: 1,
        };
        let texture = context.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("compute input texture"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D1,
            format: wgpu::TextureFormat::R8Uint,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        context.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            bytes,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: None,
                rows_per_image: None,
            },
            size,
        );

        Ok(Self { texture })
    }
}
