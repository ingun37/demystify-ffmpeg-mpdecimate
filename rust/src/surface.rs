use crate::Context;
use wasm_bindgen::prelude::*;

/// A WebGPU presentation surface configured for an HTML canvas.
#[wasm_bindgen]
pub struct Surface {
    pub(crate) surface: wgpu::Surface<'static>,
    pub(crate) device: wgpu::Device,
    pub(crate) queue: wgpu::Queue,
    format: wgpu::TextureFormat,
}

impl Surface {
    pub fn new(
        context: &Context,
        canvas: wgpu::web_sys::HtmlCanvasElement,
    ) -> Result<Self, JsError> {
        let width = canvas.width();
        let height = canvas.height();

        if width == 0 || height == 0 {
            return Err(JsError::new("canvas dimensions must be non-zero"));
        }

        let surface = context
            .instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(|error| JsError::new(&error.to_string()))?;
        let configuration = surface
            .get_default_config(&context.adapter, width, height)
            .ok_or_else(|| JsError::new("the canvas surface is not supported by this adapter"))?;

        surface.configure(&context.device, &configuration);

        Ok(Self {
            surface,
            device: context.device.clone(),
            queue: context.queue.clone(),
            format: configuration.format,
        })
    }

    pub(crate) fn format(&self) -> wgpu::TextureFormat {
        self.format
    }
}
