mod context;
mod texture;
mod utils;

use wasm_bindgen::prelude::*;

pub use context::Context;
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
pub fn create_texture(bytes: &[u8], context: &Context) -> Result<Texture, JsError> {
    Texture::from_bytes(context, bytes)
}
