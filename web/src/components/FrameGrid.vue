<template>
  <div class="mpdecimate-view">
    <div class="threshold-inputs">
      <label>
        hi
        <input
          v-model.number="hi"
          min="0"
          step="1"
          type="number"
        >
      </label>

      <label>
        lo
        <input
          v-model.number="lo"
          min="0"
          step="1"
          type="number"
        >
      </label>
    </div>

    <canvas
      ref="hiCanvas"
      class="mpdecimate-canvas"
      :height="mpdecimateHeight"
      :width="mpdecimateWidth"
    />

    <canvas
      ref="loCanvas"
      class="mpdecimate-canvas"
      :height="mpdecimateHeight"
      :width="mpdecimateWidth"
    />
  </div>

  <div class="frame-grid">
    <div
      v-for="index in frameCount"
      :key="index"
      class="frame-cell"
    >
      <canvas
        ref="frameCanvases"
        class="frame-canvas"
        :height="video.videoHeight"
        :width="video.videoWidth"
      />
    </div>
  </div>
</template>

<script lang="ts" setup>
  import {
    blit_texture_array_to_surface,
    blit_texture_to_surface,
    type BlitArrayBindGroup,
    type BlitArrayPipeline,
    type BlitBindGroup,
    type BlitPipeline,
    type Context,
    copy_video_frame_to_texture_array,
    create_blit_array_bind_group,
    create_blit_array_pipeline,
    create_blit_pipeline,
    create_mpdecimate_bind_group,
    create_mpdecimate_blit_bind_group,
    create_mpdecimate_output_texture,
    create_mpdecimate_pipeline,
    create_surface,
    create_texture_array,
    type MpdecimateBindGroup,
    type MpdecimateOutputTexture,
    type MpdecimatePipeline,
    run_mpdecimate,
    set_blit_array_layer,
    set_blit_threshold,
    set_mpdecimate_index,
    type Surface,
    type TextureArray,
  } from 'rust'
  import { onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'

  // The parent only mounts this component once the video's metadata is loaded,
  // so `video` always has valid dimensions and `resources` exists from mount on.
  const { context, video, frameCount } = defineProps<{
    context: Context
    video: HTMLVideoElement
    frameCount: number
  }>()

  const frameCanvases = useTemplateRef<HTMLCanvasElement[]>('frameCanvases')
  const hiCanvas = useTemplateRef<HTMLCanvasElement>('hiCanvas')
  const loCanvas = useTemplateRef<HTMLCanvasElement>('loCanvas')

  // Byte-scale thresholds as ffmpeg's mpdecimate CLI takes them.
  // Defaults: hi = 64 * 12, lo = 64 * 5.
  const hi = ref(64 * 12)
  const lo = ref(64 * 5)

  // The mpdecimate output has one texel per 8x8 block.
  const mpdecimateWidth = Math.ceil(video.videoWidth / 8)
  const mpdecimateHeight = Math.ceil(video.videoHeight / 8)

  /** GPU resources for the mounted video, created and freed as a unit. */
  interface FrameResources {
    textureArray: TextureArray
    surfaces: Surface[]
    pipeline: BlitArrayPipeline
    bindGroup: BlitArrayBindGroup
    mpdecimateOutput: MpdecimateOutputTexture
    mpdecimatePipeline: MpdecimatePipeline
    mpdecimateBindGroup: MpdecimateBindGroup
    hiSurface: Surface
    loSurface: Surface
    blitPipeline: BlitPipeline
    hiBindGroup: BlitBindGroup
    loBindGroup: BlitBindGroup
  }

  let resources!: FrameResources
  let capturedFrameCount = 0
  let frameCaptureCallback = 0

  onMounted(() => {
    const textureArray = create_texture_array(
      video.videoWidth,
      video.videoHeight,
      frameCount,
      context,
    )
    const surfaces = frameCanvases.value!.map(canvas => create_surface(canvas, context))
    // All canvases share the same surface format, so one pipeline serves them all.
    const pipeline = create_blit_array_pipeline(context, surfaces[0])
    const bindGroup = create_blit_array_bind_group(context, textureArray, 0)
    const mpdecimateOutput = create_mpdecimate_output_texture(
      context,
      video.videoWidth,
      video.videoHeight,
    )
    const mpdecimatePipeline = create_mpdecimate_pipeline(context)
    const mpdecimateBindGroup = create_mpdecimate_bind_group(
      context,
      textureArray,
      1,
      mpdecimateOutput,
    )

    const hiSurface = create_surface(hiCanvas.value!, context)
    const loSurface = create_surface(loCanvas.value!, context)
    const blitPipeline = create_blit_pipeline(context, hiSurface)
    const hiBindGroup = create_mpdecimate_blit_bind_group(context, mpdecimateOutput, sanitizeThreshold(hi.value))
    const loBindGroup = create_mpdecimate_blit_bind_group(context, mpdecimateOutput, sanitizeThreshold(lo.value))

    resources = {
      textureArray,
      surfaces,
      pipeline,
      bindGroup,
      mpdecimateOutput,
      mpdecimatePipeline,
      mpdecimateBindGroup,
      hiSurface,
      loSurface,
      blitPipeline,
      hiBindGroup,
      loBindGroup,
    }

    watch(hi, value => {
      set_blit_threshold(resources.hiBindGroup, context, sanitizeThreshold(value))
      blitMpdecimateOutput()
    })
    watch(lo, value => {
      set_blit_threshold(resources.loBindGroup, context, sanitizeThreshold(value))
      blitMpdecimateOutput()
    })

    video.addEventListener('play', startFrameCapture)
    video.addEventListener('pause', stopFrameCapture)
    video.addEventListener('ended', stopFrameCapture)
    if (!video.paused && !video.ended) startFrameCapture()
  })

  /**
   * Converts a byte-scale ffmpeg threshold to the shader's scale, where each
   * pixel diff is in [0, 1] instead of [0, 255]. The shader divides by the
   * threshold, so keep it a positive number.
   */
  function sanitizeThreshold (value: number) {
    return Number.isFinite(value) && value > 0 ? value / 255 : 1e-6
  }

  function blitMpdecimateOutput () {
    blit_texture_to_surface(resources.blitPipeline, resources.hiBindGroup, resources.hiSurface)
    blit_texture_to_surface(resources.blitPipeline, resources.loBindGroup, resources.loSurface)
  }

  function startFrameCapture () {
    if (frameCaptureCallback || typeof video.requestVideoFrameCallback !== 'function') return

    const captureNextFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      frameCaptureCallback = 0
      captureFrameAt(metadata.mediaTime)

      if (!video.paused && !video.ended) {
        frameCaptureCallback = video.requestVideoFrameCallback(captureNextFrame)
      }
    }

    frameCaptureCallback = video.requestVideoFrameCallback(captureNextFrame)
  }

  function stopFrameCapture () {
    if (frameCaptureCallback) video.cancelVideoFrameCallback(frameCaptureCallback)
    frameCaptureCallback = 0
  }

  function captureFrameAt (time: number) {
    if (!Number.isFinite(time) || typeof VideoFrame === 'undefined') return

    const frame = new VideoFrame(video)
    const frameIndex = capturedFrameCount % resources.surfaces.length
    capturedFrameCount += 1

    try {
      copy_video_frame_to_texture_array(frame, resources.textureArray, context, frameIndex)
      set_blit_array_layer(resources.bindGroup, context, frameIndex)
      blit_texture_array_to_surface(resources.pipeline, resources.bindGroup, resources.surfaces[frameIndex])

      // The shader compares layer `frameIndex` against `frameIndex - 1`, so
      // the first layer has no previous frame to diff against.
      if (frameIndex > 0) {
        set_mpdecimate_index(resources.mpdecimateBindGroup, context, frameIndex)
        run_mpdecimate(
          context,
          resources.mpdecimatePipeline,
          resources.mpdecimateBindGroup,
          resources.mpdecimateOutput,
        )
        blitMpdecimateOutput()
      }
    } finally {
      frame.close()
    }
  }

  onBeforeUnmount(() => {
    stopFrameCapture()
    video.removeEventListener('play', startFrameCapture)
    video.removeEventListener('pause', stopFrameCapture)
    video.removeEventListener('ended', stopFrameCapture)

    resources.hiBindGroup.free()
    resources.loBindGroup.free()
    resources.blitPipeline.free()
    resources.hiSurface.free()
    resources.loSurface.free()
    resources.mpdecimateBindGroup.free()
    resources.mpdecimatePipeline.free()
    resources.mpdecimateOutput.free()
    resources.bindGroup.free()
    resources.pipeline.free()
    resources.textureArray.free()
    for (const surface of resources.surfaces) surface.free()
  })
</script>

<style scoped>
.mpdecimate-view {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.threshold-inputs {
  display: flex;
  gap: 16px;
}

.threshold-inputs label {
  display: flex;
  align-items: center;
  gap: 6px;
}

.threshold-inputs input {
  width: 80px;
}

.mpdecimate-canvas {
  width: 100%;
  image-rendering: pixelated;
  background: #000;
  border-radius: 4px;
}

.frame-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.frame-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.frame-canvas {
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 4px;
}
</style>
