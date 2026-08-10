//! Test suite for the Web and headless browsers.

#![cfg(target_arch = "wasm32")]

extern crate wasm_bindgen_test;
use rust::{create_context, create_texture};
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen_test]
fn pass() {
    assert_eq!(1 + 1, 2);
}

#[wasm_bindgen_test]
async fn creates_a_webgpu_context() {
    create_context()
        .await
        .expect("WebGPU context should be created");
}

#[wasm_bindgen_test]
async fn creates_a_texture_from_bytes() {
    let context = create_context()
        .await
        .expect("WebGPU context should be created");
    create_texture(&[1, 2, 3, 4], &context).expect("texture should be created");
}
