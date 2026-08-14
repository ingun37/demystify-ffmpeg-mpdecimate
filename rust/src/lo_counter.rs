use crate::{shaders, Context, MpdecimateOutputTexture};
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

/// Counts the mpdecimate output blocks whose luma SAD exceeds a threshold,
/// as ffmpeg's mpdecimate does for its `frac` test.
#[wasm_bindgen]
pub struct LoCounter {
    pipeline: wgpu::ComputePipeline,
    bind_group: shaders::count_lo::bind_groups::BindGroup0,
    threshold_buffer: wgpu::Buffer,
    counter_buffer: wgpu::Buffer,
    readback_buffer: wgpu::Buffer,
    size: wgpu::Extent3d,
}

impl LoCounter {
    pub(crate) fn new(context: &Context, output: &MpdecimateOutputTexture, threshold: f32) -> Self {
        let pipeline = shaders::count_lo::compute::create_main_pipeline(&context.device);
        let threshold_buffer = context
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("count_lo threshold"),
                contents: &threshold.to_le_bytes(),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
        let counter_buffer = context.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("count_lo counter"),
            size: 4,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let readback_buffer = context.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("count_lo readback"),
            size: 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let view = output.view();
        let bind_group = shaders::count_lo::bind_groups::BindGroup0::from_bindings(
            &context.device,
            shaders::count_lo::bind_groups::BindGroupLayout0 {
                sad_texture: &view,
                threshold: threshold_buffer.as_entire_buffer_binding(),
                count: counter_buffer.as_entire_buffer_binding(),
            },
        );

        Self {
            pipeline,
            bind_group,
            threshold_buffer,
            counter_buffer,
            readback_buffer,
            size: output.size,
        }
    }

    /// Updates the luma SAD threshold a block must exceed to be counted.
    pub(crate) fn set_threshold(&self, context: &Context, threshold: f32) {
        context
            .queue
            .write_buffer(&self.threshold_buffer, 0, &threshold.to_le_bytes());
    }

    /// Dispatches the count over the current mpdecimate output and reads the
    /// result back. Errors if the readback buffer is still mapped from a
    /// previous call that has not finished.
    pub(crate) async fn count(&self, context: &Context) -> Result<u32, JsError> {
        let mut encoder = context
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("count_lo command encoder"),
            });
        encoder.clear_buffer(&self.counter_buffer, 0, None);

        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("count_lo compute pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            self.bind_group.set(&mut pass);
            let [wg_x, wg_y, _] = shaders::count_lo::compute::MAIN_WORKGROUP_SIZE;
            pass.dispatch_workgroups(
                self.size.width.div_ceil(wg_x),
                self.size.height.div_ceil(wg_y),
                1,
            );
        }

        encoder.copy_buffer_to_buffer(&self.counter_buffer, 0, &self.readback_buffer, 0, 4);
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

        let count = {
            let view = self
                .readback_buffer
                .get_mapped_range(..)
                .map_err(|error| JsError::new(&error.to_string()))?;
            u32::from_le_bytes([view[0], view[1], view[2], view[3]])
        };
        self.readback_buffer.unmap();

        Ok(count)
    }
}
