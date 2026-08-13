use crate::{shaders, Context};
use wasm_bindgen::prelude::*;

/// The compute pipeline generated from the `mpdecimate` shader.
#[wasm_bindgen]
pub struct MpdecimatePipeline {
    pub(crate) pipeline: wgpu::ComputePipeline,
}

impl MpdecimatePipeline {
    pub(crate) fn new(context: &Context) -> Self {
        let pipeline = shaders::mpdecimate::compute::create_main_pipeline(&context.device);
        Self { pipeline }
    }
}
