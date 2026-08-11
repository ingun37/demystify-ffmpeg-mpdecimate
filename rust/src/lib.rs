mod context;
mod shaders;
#[cfg(target_arch = "wasm32")]
mod surface;
mod texture;
mod utils;

use wasm_bindgen::prelude::*;

pub use context::Context;
#[cfg(target_arch = "wasm32")]
pub use surface::Surface;
pub use texture::Texture;

// When the `wee_alloc` feature is enabled, use `wee_alloc` as the global
// allocator.
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

#[wasm_bindgen]
pub async fn create_context() -> Result<Context, JsError> {
    Context::new().await
}

#[wasm_bindgen]
pub fn create_texture(width: u32, height: u32, context: &Context) -> Result<Texture, JsError> {
    Texture::new(context, width, height)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn create_surface(
    canvas: wgpu::web_sys::HtmlCanvasElement,
    context: &Context,
) -> Result<Surface, JsError> {
    Surface::new(context, canvas)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn copy_video_frame_to_texture(
    frame: wgpu::web_sys::VideoFrame,
    texture: &Texture,
    context: &Context,
) -> Result<(), JsError> {
    texture.copy_video_frame(context, frame)
}
