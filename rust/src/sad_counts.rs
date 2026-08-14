use wasm_bindgen::prelude::*;

/// Per-frame result of the `sad_count` shader: how many blocks of the
/// mpdecimate output exceed each threshold.
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub struct SadCounts {
    /// Blocks whose luma SAD exceeds the lo threshold.
    pub lo: u32,
    /// Blocks whose luma SAD exceeds the hi threshold. ffmpeg marks the
    /// frame different as soon as this is non-zero.
    pub hi: u32,
}
