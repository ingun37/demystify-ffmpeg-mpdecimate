use crate::Context;
use wasm_bindgen::prelude::*;

/// A GPU 2D texture array that receives decoded video frames for later shader processing.
#[wasm_bindgen]
pub struct TextureArray {
    texture: wgpu::Texture,
    size: wgpu::Extent3d,
}

impl TextureArray {
    pub fn new(context: &Context, width: u32, height: u32, layers: u32) -> Result<Self, JsError> {
        if width == 0 || height == 0 || layers == 0 {
            return Err(JsError::new("texture dimensions must be non-zero"));
        }

        let size = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: layers,
        };
        let texture = context.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("video frame texture array"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        Ok(Self { texture, size })
    }

    fn layer_size(&self) -> wgpu::Extent3d {
        wgpu::Extent3d {
            width: self.size.width,
            height: self.size.height,
            depth_or_array_layers: 1,
        }
    }

    fn check_index(&self, index: u32) -> Result<(), JsError> {
        if index >= self.size.depth_or_array_layers {
            return Err(JsError::new(&format!(
                "layer index {index} out of bounds for {} layers",
                self.size.depth_or_array_layers
            )));
        }
        Ok(())
    }

    /// Uploads tightly packed RGBA8 pixel data covering the layer at `index`.
    pub fn write_pixels(&self, context: &Context, data: &[u8], index: u32) -> Result<(), JsError> {
        self.check_index(index)?;

        let expected = (self.size.width * self.size.height * 4) as usize;
        if data.len() != expected {
            return Err(JsError::new(&format!(
                "pixel data must be {expected} bytes, got {}",
                data.len()
            )));
        }

        context.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: 0,
                    y: 0,
                    z: index,
                },
                aspect: wgpu::TextureAspect::All,
            },
            data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(self.size.width * 4),
                rows_per_image: Some(self.size.height),
            },
            self.layer_size(),
        );

        Ok(())
    }

    pub(crate) fn view(&self) -> wgpu::TextureView {
        self.texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        })
    }

    #[cfg(target_arch = "wasm32")]
    pub fn copy_video_frame(
        &self,
        context: &Context,
        frame: wgpu::web_sys::VideoFrame,
        index: u32,
    ) -> Result<(), JsError> {
        self.check_index(index)?;

        if frame.display_width() != self.size.width || frame.display_height() != self.size.height {
            return Err(JsError::new(
                "video frame dimensions must match the texture dimensions",
            ));
        }

        context.queue.copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo {
                source: wgpu::ExternalImageSource::VideoFrame(frame),
                origin: wgpu::Origin2d::ZERO,
                flip_y: false,
            },
            wgpu::CopyExternalImageDestInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: 0,
                    y: 0,
                    z: index,
                },
                aspect: wgpu::TextureAspect::All,
                color_space: wgpu::PredefinedColorSpace::Srgb,
                premultiplied_alpha: false,
            },
            self.layer_size(),
        );

        Ok(())
    }
}
