use wasm_bindgen::prelude::*;

/// WebGPU state owned by the WebAssembly module.
#[wasm_bindgen]
pub struct Context {
    pub(crate) instance: wgpu::Instance,
    pub(crate) adapter: wgpu::Adapter,
    pub(crate) device: wgpu::Device,
    pub(crate) queue: wgpu::Queue,
}

impl Context {
    pub async fn new() -> Result<Self, JsError> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .map_err(|error| JsError::new(&error.to_string()))?;
        // Sampling the rgba32float mpdecimate output with the blit shader's
        // filtering sampler requires float32-filterable.
        let required_features = adapter.features() & wgpu::Features::FLOAT32_FILTERABLE;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                required_features,
                ..Default::default()
            })
            .await
            .map_err(|error| JsError::new(&error.to_string()))?;

        Ok(Self {
            instance,
            adapter,
            device,
            queue,
        })
    }
}
