<template>
  <v-card elevation="3" rounded="lg">
    <v-card-title class="text-subtitle-1">mpdecimate output</v-card-title>

    <v-card-text>
      <v-row dense>
        <v-col cols="12" sm="4">
          <v-number-input
            v-model="hi"
            control-variant="stacked"
            density="comfortable"
            hide-details
            label="hi threshold"
            :min="0"
            :step="1"
            variant="outlined"
          />
        </v-col>

        <v-col cols="12" sm="4">
          <v-number-input
            v-model="lo"
            control-variant="stacked"
            density="comfortable"
            hide-details
            label="lo threshold"
            :min="0"
            :step="1"
            variant="outlined"
          />
        </v-col>

        <v-col cols="12" sm="4">
          <v-number-input
            v-model="frac"
            control-variant="stacked"
            density="comfortable"
            hide-details
            label="frac"
            :max="1"
            :min="0"
            :precision="2"
            :step="0.01"
            variant="outlined"
          />
        </v-col>
      </v-row>

      <v-alert
        class="mt-3"
        density="comfortable"
        :icon="dropped ? 'mdi-delete-outline' : 'mdi-check'"
        :type="dropped ? 'warning' : 'success'"
        variant="tonal"
      >
        {{ dropped
          ? `Frame dropped — no block exceeds hi and only ${loCount} of the allowed ${loLimit} blocks exceed lo.`
          : hiCount > 0
            ? 'Frame kept — at least one block exceeds hi.'
            : `Frame kept — ${loCount} blocks exceed lo, more than the allowed ${loLimit}.` }}
      </v-alert>

      <v-row dense>
        <v-col cols="12" sm="6">
          <p class="text-caption text-medium-emphasis mb-1">
            hi — {{ hiCount > 0 ? `exceeded (frame differs)` : 'not exceeded' }}
          </p>

          <canvas
            ref="hiCanvas"
            class="mpdecimate-canvas"
            :height="mpdecimateHeight"
            :width="mpdecimateWidth"
          />
        </v-col>

        <v-col cols="12" sm="6">
          <p class="text-caption text-medium-emphasis mb-1">
            lo — frac: {{ (loCount / totalBlocks).toFixed(2) }} ({{ loCount }}/{{ totalBlocks }} blocks)
          </p>

          <canvas
            ref="loCanvas"
            class="mpdecimate-canvas"
            :height="mpdecimateHeight"
            :width="mpdecimateWidth"
          />
        </v-col>
      </v-row>
    </v-card-text>
  </v-card>

  <v-card class="mt-4" elevation="3" rounded="lg">
    <v-card-title class="text-subtitle-1">Captured frames</v-card-title>

    <v-card-text>
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

          <p class="text-caption text-medium-emphasis text-center mb-0">{{ index }}</p>
        </div>
      </div>
    </v-card-text>
  </v-card>
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
    count_sad_blocks,
    create_blit_array_bind_group,
    create_blit_array_pipeline,
    create_blit_pipeline,
    create_mpdecimate_bind_group,
    create_mpdecimate_blit_bind_group,
    create_mpdecimate_output_texture,
    create_mpdecimate_pipeline,
    create_sad_counter,
    create_surface,
    create_texture_array,
    type MpdecimateBindGroup,
    type MpdecimateOutputTexture,
    type MpdecimatePipeline,
    run_mpdecimate,
    type SadCounter,
    set_blit_array_layer,
    set_blit_threshold,
    set_mpdecimate_index,
    set_sad_counter_thresholds,
    type Surface,
    type TextureArray,
  } from 'rust'
  import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'

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
  // Fraction of blocks allowed to exceed lo before the frame counts as
  // different. ffmpeg's default is 0.33.
  const frac = ref(0.33)

  // The mpdecimate output has one texel per 8x8 block.
  const mpdecimateWidth = Math.ceil(video.videoWidth / 8)
  const mpdecimateHeight = Math.ceil(video.videoHeight / 8)
  const totalBlocks = mpdecimateWidth * mpdecimateHeight

  // How many blocks of the latest mpdecimate output exceed each threshold,
  // as counted on the GPU. `loCount / totalBlocks` is ffmpeg's `frac`; any
  // non-zero hiCount marks the frame as different.
  const loCount = ref(0)
  const hiCount = ref(0)

  // ffmpeg's mpdecimate verdict: the frame is a duplicate (dropped) when no
  // block exceeds hi and at most `frac` of the blocks exceed lo.
  const loLimit = computed(() => Math.floor(totalBlocks * (Number.isFinite(frac.value) ? frac.value : 0.33)))
  const dropped = computed(() => hiCount.value === 0 && loCount.value <= loLimit.value)

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
    sadCounter: SadCounter
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
    const sadCounter = create_sad_counter(
      context,
      mpdecimateOutput,
      sanitizeThreshold(lo.value),
      sanitizeThreshold(hi.value),
    )

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
      sadCounter,
    }

    watch(hi, value => {
      set_blit_threshold(resources.hiBindGroup, context, sanitizeThreshold(value))
      updateSadCounterThresholds()
    })
    watch(lo, value => {
      set_blit_threshold(resources.loBindGroup, context, sanitizeThreshold(value))
      updateSadCounterThresholds()
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

  function updateSadCounterThresholds () {
    set_sad_counter_thresholds(
      resources.sadCounter,
      context,
      sanitizeThreshold(lo.value),
      sanitizeThreshold(hi.value),
    )
    blitMpdecimateOutput()
    updateSadCounts()
  }

  // The counts are read back asynchronously; while one readback is in flight,
  // further requests are skipped so capture never stalls behind it.
  let sadCountsPending = false
  let unmounted = false

  async function updateSadCounts () {
    if (sadCountsPending || unmounted) return
    sadCountsPending = true

    try {
      const counts = await count_sad_blocks(resources.sadCounter, context)
      loCount.value = counts.lo
      hiCount.value = counts.hi
    } finally {
      sadCountsPending = false
      // The wasm counter cannot be freed while a count borrows it, so an
      // unmount during a readback defers the free to here.
      if (unmounted) resources.sadCounter.free()
    }
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
        updateSadCounts()
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

    unmounted = true
    if (!sadCountsPending) resources.sadCounter.free()
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
.mpdecimate-canvas {
  display: block;
  width: 100%;
  image-rendering: pixelated;
  background: #000;
  border-radius: 4px;
}

.frame-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
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
