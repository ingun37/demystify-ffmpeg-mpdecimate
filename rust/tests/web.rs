//! Test suite for the Web and headless browsers.

#![cfg(target_arch = "wasm32")]

extern crate wasm_bindgen_test;
use rust::{
    blit_texture_array_to_surface, blit_texture_to_surface, count_sad_blocks,
    create_blit_array_bind_group, create_blit_array_pipeline, create_blit_bind_group,
    create_blit_pipeline, create_context, create_mpdecimate_bind_group,
    create_mpdecimate_output_texture, create_mpdecimate_pipeline, create_sad_counter,
    create_surface, create_texture, create_texture_array, read_mpdecimate_output, run_mpdecimate,
    set_blit_array_layer, set_sad_counter_thresholds, write_texture_array_pixels,
    write_texture_pixels, Context, MpdecimateOutputTexture,
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
    let bind_group = create_blit_bind_group(&context, &texture, 1.0);

    blit_texture_to_surface(&pipeline, &bind_group, &surface)
        .expect("blit should render and present a frame");
}

/// Runs the mpdecimate shader on two solid-color textures and returns the
/// output texels as row-major RGBA f32 values.
async fn run_mpdecimate_on_solid_colors(
    width: u32,
    height: u32,
    color_a: [u8; 4],
    color_b: [u8; 4],
) -> Vec<f32> {
    let context = create_context()
        .await
        .expect("WebGPU context should be created");
    let frames =
        create_texture_array(width, height, 2, &context).expect("texture array should be created");

    let pixel_count = (width * height) as usize;
    let pixels_a: Vec<u8> = color_a.iter().copied().cycle().take(pixel_count * 4).collect();
    let pixels_b: Vec<u8> = color_b.iter().copied().cycle().take(pixel_count * 4).collect();
    // Layer 1 is the current frame (color_a), layer 0 the previous (color_b).
    write_texture_array_pixels(&frames, &context, &pixels_a, 1).expect("pixels A should upload");
    write_texture_array_pixels(&frames, &context, &pixels_b, 0).expect("pixels B should upload");

    let output = create_mpdecimate_output_texture(&context, width, height)
        .expect("output texture should be created");
    let pipeline = create_mpdecimate_pipeline(&context);
    let bind_group = create_mpdecimate_bind_group(&context, &frames, 1, &output);
    run_mpdecimate(&context, &pipeline, &bind_group, &output);

    read_mpdecimate_output(&context, &output)
        .await
        .expect("output should be read back")
}

#[wasm_bindgen_test]
async fn mpdecimate_identical_textures_have_zero_sad() {
    let values =
        run_mpdecimate_on_solid_colors(16, 8, [200, 100, 50, 255], [200, 100, 50, 255]).await;

    assert_eq!(values.len(), 4, "one RGBA texel per 8x8 block");
    assert_eq!(&values[0..3], &[0.0, 0.0, 0.0], "SAD Y/U/V should be zero");
}

#[wasm_bindgen_test]
async fn mpdecimate_sums_absolute_yuv_differences_per_block() {
    // Black vs. white: Y differs by 1 per pixel, U and V are zero for both.
    let values = run_mpdecimate_on_solid_colors(16, 8, [0, 0, 0, 255], [255, 255, 255, 255]).await;

    assert_eq!(values.len(), 4, "one RGBA texel per 8x8 block");
    let [sad_y, sad_u, sad_v, alpha] = values[..] else {
        unreachable!()
    };
    assert!(
        (sad_y - 64.0).abs() < 0.1,
        "SAD Y should be ~64 (1.0 x 64 pixels), got {sad_y}"
    );
    assert!(sad_u.abs() < 0.1, "SAD U should be ~0, got {sad_u}");
    assert!(sad_v.abs() < 0.1, "SAD V should be ~0, got {sad_v}");
    assert_eq!(alpha, 1.0);
}

#[wasm_bindgen_test]
async fn mpdecimate_uses_overlapping_complete_windows() {
    // 20x12 input -> x = 8, 12 and y = 0, 4: four overlapping 8x8 windows.
    let values = run_mpdecimate_on_solid_colors(20, 12, [0, 0, 0, 255], [255, 255, 255, 255]).await;

    assert_eq!(values.len(), 16, "2x2 windows with 4 channels each");
    for block in 0..4 {
        let sad_y = values[block * 4];
        assert!(
            (sad_y - 64.0).abs() < 0.1,
            "window {block}: SAD Y should be ~64, got {sad_y}"
        );
    }
}

/// Runs the mpdecimate shader on two solid-color textures and returns the
/// context and output texture, ready for the sad_count shader.
async fn mpdecimate_solid_colors(
    width: u32,
    height: u32,
    color_a: [u8; 4],
    color_b: [u8; 4],
) -> (Context, MpdecimateOutputTexture) {
    let context = create_context()
        .await
        .expect("WebGPU context should be created");
    let frames =
        create_texture_array(width, height, 2, &context).expect("texture array should be created");

    let pixel_count = (width * height) as usize;
    let pixels_a: Vec<u8> = color_a.iter().copied().cycle().take(pixel_count * 4).collect();
    let pixels_b: Vec<u8> = color_b.iter().copied().cycle().take(pixel_count * 4).collect();
    write_texture_array_pixels(&frames, &context, &pixels_a, 1).expect("pixels A should upload");
    write_texture_array_pixels(&frames, &context, &pixels_b, 0).expect("pixels B should upload");

    let output = create_mpdecimate_output_texture(&context, width, height)
        .expect("output texture should be created");
    let pipeline = create_mpdecimate_pipeline(&context);
    let bind_group = create_mpdecimate_bind_group(&context, &frames, 1, &output);
    run_mpdecimate(&context, &pipeline, &bind_group, &output);

    (context, output)
}

#[wasm_bindgen_test]
async fn sad_count_identical_frames_count_nothing() {
    let (context, output) =
        mpdecimate_solid_colors(16, 8, [200, 100, 50, 255], [200, 100, 50, 255]).await;

    let counter = create_sad_counter(&context, &output, 0.5, 1.0);
    let counts = count_sad_blocks(&counter, &context)
        .await
        .expect("counts should be read back");

    assert_eq!(counts.lo, 0, "no block should exceed lo");
    assert_eq!(counts.hi, 0, "no block should exceed hi");
}

#[wasm_bindgen_test]
async fn sad_count_counts_block_between_lo_and_hi() {
    // Black vs. white: one 8x8 block with luma SAD ~64.
    let (context, output) =
        mpdecimate_solid_colors(16, 8, [0, 0, 0, 255], [255, 255, 255, 255]).await;

    let counter = create_sad_counter(&context, &output, 1.0, 100.0);
    let counts = count_sad_blocks(&counter, &context)
        .await
        .expect("counts should be read back");

    assert_eq!(counts.lo, 1, "the block's SAD ~64 should exceed lo=1");
    assert_eq!(counts.hi, 0, "the block's SAD ~64 should not exceed hi=100");
}

#[wasm_bindgen_test]
async fn sad_count_counts_every_block_over_both_thresholds() {
    // 20x12 input -> 2x2 overlapping windows, each with luma SAD ~64.
    let (context, output) =
        mpdecimate_solid_colors(20, 12, [0, 0, 0, 255], [255, 255, 255, 255]).await;

    let counter = create_sad_counter(&context, &output, 1.0, 2.0);
    let counts = count_sad_blocks(&counter, &context)
        .await
        .expect("counts should be read back");

    assert_eq!(counts.lo, 4, "all four windows should exceed lo");
    assert_eq!(counts.hi, 4, "all four windows should exceed hi");
}

#[wasm_bindgen_test]
async fn sad_count_set_thresholds_applies_to_next_count() {
    let (context, output) =
        mpdecimate_solid_colors(16, 8, [0, 0, 0, 255], [255, 255, 255, 255]).await;

    let counter = create_sad_counter(&context, &output, 1.0, 2.0);
    let counts = count_sad_blocks(&counter, &context)
        .await
        .expect("counts should be read back");
    assert_eq!((counts.lo, counts.hi), (1, 1));

    // Raise both thresholds above the block's SAD (~64); counts must reset
    // to zero rather than accumulate across dispatches.
    set_sad_counter_thresholds(&counter, &context, 100.0, 200.0);
    let counts = count_sad_blocks(&counter, &context)
        .await
        .expect("counts should be read back");
    assert_eq!((counts.lo, counts.hi), (0, 0));
}

/// Creates a canvas of the given size, ready to be wrapped in a surface.
fn create_canvas(width: u32, height: u32) -> wgpu::web_sys::HtmlCanvasElement {
    let canvas = wgpu::web_sys::window()
        .expect("browser window should be available")
        .document()
        .expect("document should be available")
        .create_element("canvas")
        .expect("canvas should be created")
        .dyn_into::<wgpu::web_sys::HtmlCanvasElement>()
        .expect("element should be a canvas");
    canvas.set_width(width);
    canvas.set_height(height);
    canvas
}

#[wasm_bindgen_test]
async fn blits_a_texture_array_layer_to_a_surface() {
    let context = create_context()
        .await
        .expect("WebGPU context should be created");
    let frames = create_texture_array(4, 4, 2, &context).expect("texture array should be created");
    let red: Vec<u8> = [255, 0, 0, 255].iter().copied().cycle().take(4 * 4 * 4).collect();
    let blue: Vec<u8> = [0, 0, 255, 255].iter().copied().cycle().take(4 * 4 * 4).collect();
    write_texture_array_pixels(&frames, &context, &red, 0).expect("layer 0 should upload");
    write_texture_array_pixels(&frames, &context, &blue, 1).expect("layer 1 should upload");

    let surface =
        create_surface(create_canvas(4, 4), &context).expect("surface should be created");
    let pipeline = create_blit_array_pipeline(&context, &surface);
    let bind_group = create_blit_array_bind_group(&context, &frames, 0);

    blit_texture_array_to_surface(&pipeline, &bind_group, &surface)
        .expect("blit should render and present layer 0");
}

#[wasm_bindgen_test]
async fn blit_array_switches_layers_between_frames() {
    let context = create_context()
        .await
        .expect("WebGPU context should be created");
    let frames = create_texture_array(4, 4, 3, &context).expect("texture array should be created");
    for layer in 0..3 {
        let pixels: Vec<u8> = [layer as u8 * 100, 0, 0, 255]
            .iter()
            .copied()
            .cycle()
            .take(4 * 4 * 4)
            .collect();
        write_texture_array_pixels(&frames, &context, &pixels, layer)
            .expect("layer should upload");
    }

    let surface =
        create_surface(create_canvas(4, 4), &context).expect("surface should be created");
    let pipeline = create_blit_array_pipeline(&context, &surface);
    let bind_group = create_blit_array_bind_group(&context, &frames, 0);

    // Present each layer in turn, as the player does when scrubbing frames.
    for layer in 0..3 {
        set_blit_array_layer(&bind_group, &context, layer);
        blit_texture_array_to_surface(&pipeline, &bind_group, &surface)
            .expect("blit should render and present the selected layer");
    }
}
