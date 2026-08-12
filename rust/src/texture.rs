use crate::Context;
use wasm_bindgen::prelude::*;

/// A GPU texture that receives decoded video frames for later shader processing.
#[wasm_bindgen]
pub struct Texture {
    texture: wgpu::Texture,
    size: wgpu::Extent3d,
}

impl Texture {
    pub fn new(context: &Context, width: u32, height: u32) -> Result<Self, JsError> {
        if width == 0 || height == 0 {
            return Err(JsError::new("texture dimensions must be non-zero"));
        }

        let size = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let texture = context.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("video frame texture"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        Ok(Self { texture, size })
    }

    pub(crate) fn view(&self) -> wgpu::TextureView {
        self.texture
            .create_view(&wgpu::TextureViewDescriptor::default())
    }

    #[cfg(target_arch = "wasm32")]
    pub fn copy_video_frame(
        &self,
        context: &Context,
        frame: wgpu::web_sys::VideoFrame,
    ) -> Result<(), JsError> {
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
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
                color_space: wgpu::PredefinedColorSpace::Srgb,
                premultiplied_alpha: false,
            },
            self.size,
        );

        Ok(())
    }
}
