use crate::{shaders, Context, MpdecimateOutputTexture, Texture};
use wasm_bindgen::prelude::*;

/// The texture bindings consumed by the `mpdecimate` shader.
#[wasm_bindgen]
pub struct MpdecimateBindGroup {
    pub(crate) bind_group: shaders::mpdecimate::bind_groups::BindGroup0,
}

impl MpdecimateBindGroup {
    pub(crate) fn new(
        context: &Context,
        texture_a: &Texture,
        texture_b: &Texture,
        output: &MpdecimateOutputTexture,
    ) -> Self {
        let view_a = texture_a.view();
        let view_b = texture_b.view();
        let view_c = output.view();
        let bind_group = shaders::mpdecimate::bind_groups::BindGroup0::from_bindings(
            &context.device,
            shaders::mpdecimate::bind_groups::BindGroupLayout0 {
                texture_a: &view_a,
                texture_b: &view_b,
                texture_c: &view_c,
            },
        );

        Self { bind_group }
    }
}
