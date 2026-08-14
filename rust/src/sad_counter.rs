use crate::{shaders, Context, MpdecimateOutputTexture, SadCounts};
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

/// Counts the mpdecimate output blocks whose luma SAD exceeds the lo and hi
/// thresholds, in a single compute pass.
#[wasm_bindgen]
pub struct SadCounter {
    pipeline: wgpu::ComputePipeline,
    bind_group: shaders::sad_count::bind_groups::BindGroup0,
    thresholds_buffer: wgpu::Buffer,
    counts_buffer: wgpu::Buffer,
    readback_buffer: wgpu::Buffer,
    size: wgpu::Extent3d,
}

impl SadCounter {
    pub(crate) fn new(
        context: &Context,
        output: &MpdecimateOutputTexture,
        lo: f32,
        hi: f32,
    ) -> Self {
        let pipeline = shaders::sad_count::compute::create_main_pipeline(&context.device);
        let thresholds_buffer = context
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("sad_count thresholds"),
                contents: &Self::thresholds_bytes(lo, hi),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
        let counts_buffer = context.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("sad_count counts"),
            size: 8,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let readback_buffer = context.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("sad_count readback"),
            size: 8,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let view = output.view();
        let bind_group = shaders::sad_count::bind_groups::BindGroup0::from_bindings(
            &context.device,
            shaders::sad_count::bind_groups::BindGroupLayout0 {
                sad_texture: &view,
                thresholds: thresholds_buffer.as_entire_buffer_binding(),
                counts: counts_buffer.as_entire_buffer_binding(),
            },
        );

        Self {
            pipeline,
            bind_group,
            thresholds_buffer,
            counts_buffer,
            readback_buffer,
            size: output.size,
        }
    }

    fn thresholds_bytes(lo: f32, hi: f32) -> [u8; 8] {
        let mut bytes = [0u8; 8];
        bytes[..4].copy_from_slice(&lo.to_le_bytes());
        bytes[4..].copy_from_slice(&hi.to_le_bytes());
        bytes
    }

    /// Updates the luma SAD thresholds a block must exceed to be counted.
    pub(crate) fn set_thresholds(&self, context: &Context, lo: f32, hi: f32) {
        context
            .queue
            .write_buffer(&self.thresholds_buffer, 0, &Self::thresholds_bytes(lo, hi));
    }

    /// Dispatches the count over the current mpdecimate output and reads both
    /// counts back. Errors if the readback buffer is still mapped from a
    /// previous call that has not finished.
    pub(crate) async fn count(&self, context: &Context) -> Result<SadCounts, JsError> {
        let mut encoder = context
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("sad_count command encoder"),
            });
        encoder.clear_buffer(&self.counts_buffer, 0, None);

        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("sad_count compute pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            self.bind_group.set(&mut pass);
            let [wg_x, wg_y, _] = shaders::sad_count::compute::MAIN_WORKGROUP_SIZE;
            pass.dispatch_workgroups(
                self.size.width.div_ceil(wg_x),
                self.size.height.div_ceil(wg_y),
                1,
            );
        }

        encoder.copy_buffer_to_buffer(&self.counts_buffer, 0, &self.readback_buffer, 0, 8);
        context.queue.submit([encoder.finish()]);

        let (sender, receiver) = futures_channel::oneshot::channel();
        self.readback_buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });
        let _ = context.device.poll(wgpu::PollType::Poll);
        receiver
            .await
            .map_err(|_| JsError::new("count readback callback was dropped"))?
            .map_err(|error| JsError::new(&error.to_string()))?;

        let counts = {
            let view = self
                .readback_buffer
                .get_mapped_range(..)
                .map_err(|error| JsError::new(&error.to_string()))?;
            SadCounts {
                lo: u32::from_le_bytes([view[0], view[1], view[2], view[3]]),
                hi: u32::from_le_bytes([view[4], view[5], view[6], view[7]]),
            }
        };
        self.readback_buffer.unmap();

        Ok(counts)
    }
}
