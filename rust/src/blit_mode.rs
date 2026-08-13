use wasm_bindgen::prelude::*;

/// How the `blit` shader transforms the sampled color before drawing.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BlitMode {
    /// No transform, plain blit.
    #[default]
    None = 0,
    /// Transform to YUV and draw the Y component in gray scale.
    Y = 1,
    /// Transform to YUV and draw the U component in blue.
    U = 2,
    /// Transform to YUV and draw the V component in red.
    V = 3,
}
