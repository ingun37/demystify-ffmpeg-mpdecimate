<template>
  <v-card class="pa-6" elevation="3" rounded="lg">
    <v-slider
      v-model="frameCount"
      class="mb-4"
      color="primary"
      hide-details
      label="Frames to process"
      :max="12"
      :min="2"
      :step="1"
      thumb-label="always"
    />

    <v-file-input
      accept="video/mp4,.mp4"
      clearable
      label="MP4 video"
      prepend-icon="mdi-file-video-outline"
      variant="outlined"
      @update:model-value="loadVideo"
    />

    <template v-if="videoUrl">
      <video
        ref="videoElement"
        class="video-preview mb-5"
        controls
        :src="videoUrl"
        @ended="stopFrameCapture"
        @loadedmetadata="onLoadedMetadata"
        @pause="stopFrameCapture"
        @play="startFrameCapture"
      />

      <div class="frame-grid mt-5">
        <div
          v-for="index in frameCount"
          :key="index"
          class="frame-cell"
        >
          <canvas
            ref="frameCanvases"
            class="frame-canvas"
          />
        </div>
      </div>
    </template>

    <div v-else class="empty-state text-center text-medium-emphasis py-10">
      <v-icon icon="mdi-movie-open-outline" size="48" />
      <p class="mt-3 mb-0">Your video preview and timeline will appear here.</p>
    </div>
  </v-card>
</template>

<script lang="ts" setup>
  import {
    blit_texture_to_surface,
    type BlitBindGroup,
    type BlitPipeline,
    type Context,
    copy_video_frame_to_texture,
    copy_video_frame_to_texture_array,
    create_blit_bind_group,
    create_blit_pipeline,
    create_surface,
    create_texture,
    create_texture_array,
    type Surface,
    type Texture,
    type TextureArray,
  } from 'rust'
  import { nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'

  const { context } = defineProps<{ context: Context }>()

  const videoElement = ref<HTMLVideoElement | null>(null)
  const frameCanvases = useTemplateRef<HTMLCanvasElement[]>('frameCanvases')
  const videoUrl = ref('')
  const frameCount = ref(2)

  /** GPU resources for one loaded video, created and freed as a unit. */
  interface FrameResources {
    textures: Texture[]
    textureArray: TextureArray
    surfaces: Surface[]
    pipelines: BlitPipeline[]
    bindGroups: BlitBindGroup[]
  }

  let frameResources: FrameResources | undefined
  let capturedFrameCount = 0

  function freeFrameResources () {
    if (!frameResources) return
    for (const bindGroup of frameResources.bindGroups) bindGroup.free()
    for (const pipeline of frameResources.pipelines) pipeline.free()
    for (const texture of frameResources.textures) texture.free()
    frameResources.textureArray.free()
    for (const surface of frameResources.surfaces) surface.free()
    frameResources = undefined
  }

  function createFrameResources () {
    freeFrameResources()
    capturedFrameCount = 0

    const video = videoElement.value
    if (!video?.videoWidth || !frameCanvases.value) return

    const textures = Array.from(
      { length: frameCount.value },
      () => create_texture(video.videoWidth, video.videoHeight, context),
    )
    const textureArray = create_texture_array(
      video.videoWidth,
      video.videoHeight,
      frameCount.value,
      context,
    )
    const surfaces = frameCanvases.value.map(canvas => {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      return create_surface(canvas, context)
    })
    const pipelines = surfaces.map(surface => create_blit_pipeline(context, surface))
    const bindGroups = surfaces.map((_, index) => create_blit_bind_group(
      context,
      textures[index],
      1,
    ))

    frameResources = { textures, textureArray, surfaces, pipelines, bindGroups }
  }

  watch(frameCount, async () => {
    await nextTick()
    createFrameResources()
  })

  let frameCaptureCallback = 0

  function loadVideo (value: File | File[] | null) {
    const file = Array.isArray(value) ? value[0] : value

    if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)

    videoUrl.value = file ? URL.createObjectURL(file) : ''
    stopFrameCapture()
  }

  async function onLoadedMetadata () {
    await nextTick()
    createFrameResources()
  }

  function startFrameCapture () {
    const video = videoElement.value
    if (!video || frameCaptureCallback || typeof video.requestVideoFrameCallback !== 'function') return

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
    const video = videoElement.value
    if (video && frameCaptureCallback) video.cancelVideoFrameCallback(frameCaptureCallback)
    frameCaptureCallback = 0
  }

  function captureFrameAt (time: number) {
    const video = videoElement.value
    const resources = frameResources
    if (!video || !resources || !Number.isFinite(time)) return

    if (typeof VideoFrame === 'undefined') return

    const frame = new VideoFrame(video)
    const frameIndex = capturedFrameCount % resources.textures.length
    capturedFrameCount += 1

    try {
      copy_video_frame_to_texture(frame, resources.textures[frameIndex], context)
      const arrayFrame = new VideoFrame(video)
      try {
        copy_video_frame_to_texture_array(arrayFrame, resources.textureArray, context, frameIndex)
      } finally {
        arrayFrame.close()
      }
      blit_texture_to_surface(resources.pipelines[frameIndex], resources.bindGroups[frameIndex], resources.surfaces[frameIndex])
    } finally {
      frame.close()
    }
  }

  onBeforeUnmount(() => {
    stopFrameCapture()
    if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
    freeFrameResources()
  })
</script>

<style scoped>
.video-preview {
  display: block;
  width: 100%;
  max-height: 400px;
  background: #000;
  border-radius: 8px;
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

.empty-state {
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.25);
  border-radius: 8px;
}
</style>
