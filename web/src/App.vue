<template>
  <v-app>
    <v-main class="app-shell">
      <v-container class="py-12" max-width="760">
        <div class="d-flex align-center mb-8">
          <v-icon class="mr-3" color="primary" icon="mdi-video-outline" size="36" />

          <div>
            <h1 class="text-h4 font-weight-bold">Video frame sampler</h1>
            <p class="text-medium-emphasis mb-0">Choose an MP4, then move the timeline to capture a frame.</p>
          </div>
        </div>

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
              @loadedmetadata="onLoadedMetadata"
            />

            <div class="d-flex justify-space-between align-center mb-1">
              <span class="text-subtitle-1 font-weight-medium">Capture position</span>

              <span class="text-body-2 text-medium-emphasis">{{ formatTime(selectedTime) }} / {{
                formatTime(duration)
              }}</span>
            </div>

            <v-slider
              v-model="selectedTime"
              color="primary"
              :disabled="!duration"
              hide-details
              :max="duration"
              :step="0.01"
              thumb-label
              @update:model-value="captureFrameAt"
            />

            <div class="frame-grid mt-5">
              <canvas
                v-for="index in frameCount"
                :key="index"
                ref="frameCanvases"
                class="frame-canvas"
              />
            </div>
          </template>

          <div v-else class="empty-state text-center text-medium-emphasis py-10">
            <v-icon icon="mdi-movie-open-outline" size="48" />
            <p class="mt-3 mb-0">Your video preview and timeline will appear here.</p>
          </div>
        </v-card>
      </v-container>
    </v-main>

    <v-btn
      class="ma-2"
      icon="mdi-theme-light-dark"
      location="top right"
      position="absolute"
      @click="$vuetify.theme.cycle()"
    />
  </v-app>
</template>

<script lang="ts" setup>
  import { type Context, create_context, create_surface, create_texture, type Surface, type Texture } from 'rust'
  import { nextTick, onBeforeUnmount, ref, shallowRef, useTemplateRef, watch } from 'vue'

  const videoElement = ref<HTMLVideoElement | null>(null)
  const frameCanvases = useTemplateRef<HTMLCanvasElement[]>('frameCanvases')
  const videoUrl = ref('')
  const duration = ref(0)
  const selectedTime = ref(0)
  const frameCount = ref(4)

  const context = shallowRef<Context | null>(null)
  let frameSurfaces: Surface[] = []
  let frameTextures: Texture[] = []

  create_context().then(created => {
    context.value = created
    createFrameResources()
  })

  function createFrameResources () {
    const video = videoElement.value
    for (const texture of frameTextures) texture.free()
    frameTextures = []
    for (const surface of frameSurfaces) surface.free()
    frameSurfaces = []

    if (!context.value || !video?.videoWidth || !frameCanvases.value) return

    frameTextures = Array.from(
      { length: frameCount.value },
      () => create_texture(video.videoWidth, video.videoHeight, context.value!),
    )
    frameSurfaces = frameCanvases.value.map(canvas => {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      return create_surface(canvas, context.value!)
    })
  }

  watch(frameCount, async () => {
    await nextTick()
    createFrameResources()
  })

  let captureRequest = 0

  function loadVideo (value: File | File[] | null) {
    const file = Array.isArray(value) ? value[0] : value

    if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)

    videoUrl.value = file ? URL.createObjectURL(file) : ''
    duration.value = 0
    selectedTime.value = 0
  }

  async function onLoadedMetadata () {
    duration.value = videoElement.value?.duration ?? 0
    await nextTick()
    createFrameResources()
  }

  async function captureFrameAt (time: number) {
    const video = videoElement.value
    if (!video || !Number.isFinite(time)) return

    // Ignore pending seeks when the slider is moved again before decoding finishes.
    const request = ++captureRequest
    video.currentTime = time
    await new Promise<void>(resolve => video.addEventListener('seeked', () => resolve(), { once: true }))

    if (request !== captureRequest || typeof VideoFrame === 'undefined') return

    const frame = new VideoFrame(video)
    // The frame is intentionally not displayed or processed yet.
    frame.close()
  }

  function formatTime (seconds: number) {
    if (!Number.isFinite(seconds)) return '0:00'
    const wholeSeconds = Math.floor(seconds)
    return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, '0')}`
  }

  onBeforeUnmount(() => {
    if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
    for (const surface of frameSurfaces) surface.free()
    for (const texture of frameTextures) texture.free()
    context.value?.free()
  })
</script>

<style scoped>
.app-shell {
  min-height: 100vh;
  background: rgb(var(--v-theme-surface));
}

.video-preview {
  display: block;
  width: 100%;
  max-height: 400px;
  background: #000;
  border-radius: 8px;
}

.frame-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
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
