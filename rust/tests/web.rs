//! Test suite for the Web and headless browsers.

#![cfg(target_arch = "wasm32")]

extern crate wasm_bindgen_test;
use rust::{
    blit_texture_to_surface, create_blit_bind_group, create_blit_pipeline, create_context,
    create_surface, create_texture,
};
use wasm_bindgen::JsCast;
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
async fn creates_a_texture_for_video_frames() {
    let context = create_context()
        .await
        .expect("WebGPU context should be created");
    create_texture(1920, 1080, &context).expect("texture should be created");
}

#[wasm_bindgen_test]
async fn blits_a_texture_to_a_surface() {
    let context = create_context()
        .await
        .expect("WebGPU context should be created");
    let canvas = wgpu::web_sys::window()
        .expect("browser window should be available")
        .document()
        .expect("document should be available")
        .create_element("canvas")
        .expect("canvas should be created")
        .dyn_into::<wgpu::web_sys::HtmlCanvasElement>()
        .expect("element should be a canvas");
    canvas.set_width(4);
    canvas.set_height(4);

    let texture = create_texture(4, 4, &context).expect("texture should be created");
    let surface = create_surface(canvas, &context).expect("surface should be created");
    let pipeline = create_blit_pipeline(&context, &surface);
    let bind_group = create_blit_bind_group(&context, &texture);

    blit_texture_to_surface(&pipeline, &bind_group, &surface)
        .expect("blit should render and present a frame");
}
