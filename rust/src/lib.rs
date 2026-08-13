#[cfg(target_arch = "wasm32")]
mod blit_bind_group;
#[cfg(target_arch = "wasm32")]
mod blit_mode;
#[cfg(target_arch = "wasm32")]
mod blit_pipeline;
mod context;
mod mpdecimate_bind_group;
mod mpdecimate_output_texture;
mod mpdecimate_pipeline;
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
pub use mpdecimate_bind_group::MpdecimateBindGroup;
pub use mpdecimate_output_texture::MpdecimateOutputTexture;
pub use mpdecimate_pipeline::MpdecimatePipeline;
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
    threshold: f32,
) -> BlitBindGroup {
    BlitBindGroup::new(context, texture, mode, threshold)
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

/// Uploads tightly packed RGBA8 pixel data covering the whole texture.
#[wasm_bindgen]
pub fn write_texture_pixels(
    texture: &Texture,
    context: &Context,
    data: &[u8],
) -> Result<(), JsError> {
    texture.write_pixels(context, data)
}

/// Creates the compute pipeline for the `mpdecimate` shader.
#[wasm_bindgen]
pub fn create_mpdecimate_pipeline(context: &Context) -> MpdecimatePipeline {
    MpdecimatePipeline::new(context)
}

/// Creates the float output texture with one texel per 8x8 block of a
/// `width` x `height` input.
#[wasm_bindgen]
pub fn create_mpdecimate_output_texture(
    context: &Context,
    width: u32,
    height: u32,
) -> Result<MpdecimateOutputTexture, JsError> {
    MpdecimateOutputTexture::new(context, width, height)
}

/// Creates the texture bindings consumed by the `mpdecimate` shader.
#[wasm_bindgen]
pub fn create_mpdecimate_bind_group(
    context: &Context,
    texture_a: &Texture,
    texture_b: &Texture,
    output: &MpdecimateOutputTexture,
) -> MpdecimateBindGroup {
    MpdecimateBindGroup::new(context, texture_a, texture_b, output)
}

/// Dispatches the `mpdecimate` shader, writing per-block YUV sums of absolute
/// differences between the two bound input textures into the output texture.
#[wasm_bindgen]
pub fn run_mpdecimate(
    context: &Context,
    pipeline: &MpdecimatePipeline,
    bind_group: &MpdecimateBindGroup,
    output: &MpdecimateOutputTexture,
) {
    let mut encoder = context
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("mpdecimate command encoder"),
        });

    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("mpdecimate compute pass"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&pipeline.pipeline);
        bind_group.bind_group.set(&mut pass);
        let [wg_x, wg_y, _] = shaders::mpdecimate::compute::MAIN_WORKGROUP_SIZE;
        pass.dispatch_workgroups(
            output.size.width.div_ceil(wg_x),
            output.size.height.div_ceil(wg_y),
            1,
        );
    }

    context.queue.submit([encoder.finish()]);
}

/// Reads the output texture back as row-major RGBA `f32` values (4 per texel).
#[wasm_bindgen]
pub async fn read_mpdecimate_output(
    context: &Context,
    output: &MpdecimateOutputTexture,
) -> Result<Vec<f32>, JsError> {
    const BYTES_PER_TEXEL: u32 = 16; // rgba32float
    let unpadded_bytes_per_row = output.size.width * BYTES_PER_TEXEL;
    let bytes_per_row = unpadded_bytes_per_row.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
        * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let buffer = context.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("mpdecimate readback buffer"),
        size: u64::from(bytes_per_row * output.size.height),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut encoder = context
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("mpdecimate readback encoder"),
        });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &output.texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: Some(output.size.height),
            },
        },
        output.size,
    );
    context.queue.submit([encoder.finish()]);

    let (sender, receiver) = futures_channel::oneshot::channel();
    buffer
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
    let _ = context.device.poll(wgpu::PollType::Poll);
    receiver
        .await
        .map_err(|_| JsError::new("readback callback was dropped"))?
        .map_err(|error| JsError::new(&error.to_string()))?;

    let view = buffer
        .get_mapped_range(..)
        .map_err(|error| JsError::new(&error.to_string()))?;
    let mut values =
        Vec::with_capacity((output.size.width * output.size.height * 4) as usize);
    for row in 0..output.size.height {
        let start = (row * bytes_per_row) as usize;
        let row_bytes = &view[start..start + unpadded_bytes_per_row as usize];
        for b in row_bytes.chunks_exact(4) {
            values.push(f32::from_le_bytes([b[0], b[1], b[2], b[3]]));
        }
    }
    drop(view);
    buffer.unmap();

    Ok(values)
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
