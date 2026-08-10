mod context;
mod utils;

use wasm_bindgen::prelude::*;

pub use context::Context;

// When the `wee_alloc` feature is enabled, use `wee_alloc` as the global
// allocator.
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;


#[wasm_bindgen]
pub async fn create_context() -> Result<Context, JsError> {
    Context::new().await
}
