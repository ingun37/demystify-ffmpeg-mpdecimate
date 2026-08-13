#[cfg(target_arch = "wasm32")]
mod blit_bind_group;
#[cfg(target_arch = "wasm32")]
mod blit_mode;
#[cfg(target_arch = "wasm32")]
mod blit_pipeline;
mod context;
mod shaders;
#[cfg(target_arch = "wasm32")]
mod surface;
mod texture;
mod utils;

use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
pub use blit_bind_group::BlitBindGroup;
#[cfg(target_arch = "wasm32")]
pub use blit_mode::BlitMode;
#[cfg(target_arch = "wasm32")]
pub use blit_pipeline::BlitPipeline;
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

/// Creates the render pipeline for presenting a texture on `surface`.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn create_blit_pipeline(context: &Context, surface: &Surface) -> BlitPipeline {
    BlitPipeline::new(context, surface)
}

/// Creates the sampler and texture bindings consumed by the blit shader.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn create_blit_bind_group(
    context: &Context,
    texture: &Texture,
    mode: BlitMode,
) -> BlitBindGroup {
    BlitBindGroup::new(context, texture, mode)
}

/// Draws the source texture in `bind_group` to `surface` using `pipeline`.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn blit_texture_to_surface(
    pipeline: &BlitPipeline,
    bind_group: &BlitBindGroup,
    surface: &Surface,
) -> Result<(), JsError> {
    let frame = match surface.surface.get_current_texture() {
        wgpu::CurrentSurfaceTexture::Success(frame)
        | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
        status => {
            return Err(JsError::new(&format!(
                "could not acquire surface texture: {status:?}"
            )))
        }
    };
    let view = frame
        .texture
        .create_view(&wgpu::TextureViewDescriptor::default());
    let mut encoder = surface
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("blit command encoder"),
        });

    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("blit render pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&pipeline.pipeline);
        bind_group.bind_group.set(&mut pass);
        pass.draw(0..4, 0..1);
    }

    surface.queue.submit([encoder.finish()]);
    surface.queue.present(frame);
    Ok(())
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
