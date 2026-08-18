<template>
  <v-container fluid>
    <v-row>
      <v-col cols="12" md="7">
        <v-card>
          <video
            ref="videoElement"
            class="preview"
            controls
            playsinline
            :src="video.src"
            @loadedmetadata="updateVideoInfo"
            @ratechange="updateVideoInfo"
            @timeupdate="updateCurrentTime"
          />
        </v-card>
      </v-col>

      <v-col cols="12" md="5">
        <v-card title="Video information" variant="tonal">
          <v-card-text>
            <v-list density="compact">
              <v-list-item subtitle="Resolution" :title="videoResolution" />
              <v-list-item subtitle="Duration" :title="formatTimestamp(videoDuration)" />
              <v-list-item subtitle="Playback rate" :title="`${playbackRate}×`" />
              <v-list-item subtitle="Current timestamp" :title="formatTimestamp(currentTime)" />
              <v-list-item subtitle="Chroma subsampling" :title="chromaSubsampling" />

              <v-list-item subtitle="mpdecimate">
                <template #title>
                  <v-chip
                    :color="isCurrentFrameKept ? 'success' : 'error'"
                    :prepend-icon="isCurrentFrameKept ? 'mdi-check' : 'mdi-close'"
                    :text="isCurrentFrameKept ? 'Frame is Kept' : 'Frame is Dropped'"
                  />
                </template>
              </v-list-item>
            </v-list>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-row>
      <v-col cols="12" md="6">
        <v-card subtitle="A frame differs when enough 8×8 windows exceed lo" title="Low threshold">
          <v-card-text>
            <v-slider
              v-model="loThreshold"
              hide-details
              label="lo"
              :max="16320"
              :step="64"
            >
              <template #append>
                <v-number-input
                  v-model="loThreshold"
                  density="compact"
                  hide-details
                  :step="64"
                  width="10em"
                />
              </template>
            </v-slider>

            <v-slider
              v-model="loFraction"
              hide-details
              label="frac"
              :max="1"
              :step="0.01"
            >
              <template #append>
                <v-number-input
                  v-model="loFraction"
                  density="compact"
                  hide-details
                  :precision="2"
                  :step="0.01"
                  width="10em"
                />
              </template>
            </v-slider>
          </v-card-text>

          <v-card-text>
            <p class="text-label-small mb-1">Lo luma ({{ formatPlaneSize(resources.lumaSize) }})</p>
            <canvas ref="loLumaCanvasElement" class="preview-canvas mb-4" />

            <p class="text-label-small mb-1">Lo chroma ({{ formatPlaneSize(resources.chromaSize) }})</p>
            <canvas ref="loChromaCanvasElement" class="preview-canvas" />
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="6">
        <v-card subtitle="A frame differs when one 8×8 window exceeds hi" title="High threshold">
          <v-card-text>
            <v-slider
              v-model="hiThreshold"
              hide-details
              label="hi"
              :max="16320"
              :step="64"
            >
              <template #append>
                <v-number-input
                  v-model="hiThreshold"
                  density="compact"
                  hide-details
                  :step="64"
                  width="10em"
                />
              </template>
            </v-slider>
          </v-card-text>

          <v-card-text>
            <p class="text-label-small mb-1">Hi luma ({{ formatPlaneSize(resources.lumaSize) }})</p>
            <canvas ref="hiLumaCanvasElement" class="preview-canvas mb-4" />

            <p class="text-label-small mb-1">Hi chroma ({{ formatPlaneSize(resources.chromaSize) }})</p>
            <canvas ref="hiChromaCanvasElement" class="preview-canvas" />
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script lang="ts" setup>
  import type { WebGPUContext } from '@/stages'
  import type { VisualizeResources } from '@/VisualizeResources'
  import type { ChromaSubsampling, PlaneSize } from 'interface'
  import { ref, useTemplateRef } from 'vue'

  const { resources, video } = defineProps<{
    context: WebGPUContext
    video: HTMLVideoElement
    chromaSubsampling: ChromaSubsampling
    resources: VisualizeResources
  }>()

  const videoElement = useTemplateRef('videoElement')
  const loLumaCanvasElement = useTemplateRef('loLumaCanvasElement')
  const loChromaCanvasElement = useTemplateRef('loChromaCanvasElement')
  const hiLumaCanvasElement = useTemplateRef('hiLumaCanvasElement')
  const hiChromaCanvasElement = useTemplateRef('hiChromaCanvasElement')

  const loThreshold = ref(64 * 5)
  const hiThreshold = ref(64 * 12)
  const loFraction = ref(0.33)
  const isCurrentFrameKept = ref(true)

  const videoResolution = ref('Loading…')
  const videoDuration = ref(Number.NaN)
  const playbackRate = ref(video.playbackRate)
  const currentTime = ref(video.currentTime)

  // TODO: build a Stream<IncomingYUVFrame> from requestVideoFrameCallback,
  // run writeYUVTextures(frames) with resources.encoderLive provided, update
  // isCurrentFrameKept from each WrittenYUVFrame, and blit the lo/hi output
  // textures into the four canvases.

  function updateVideoInfo () {
    const element = videoElement.value
    if (!element) return

    videoResolution.value = element.videoWidth && element.videoHeight
      ? `${element.videoWidth} × ${element.videoHeight}`
      : 'Unknown'
    videoDuration.value = element.duration
    playbackRate.value = element.playbackRate
    updateCurrentTime()
  }

  function updateCurrentTime () {
    const element = videoElement.value
    if (!element) return
    currentTime.value = element.currentTime
  }

  function formatTimestamp (seconds: number) {
    if (!Number.isFinite(seconds)) return 'Unknown'

    const milliseconds = Math.round(seconds * 1000)
    const hours = Math.floor(milliseconds / 3_600_000)
    const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
    const wholeSeconds = Math.floor((milliseconds % 60_000) / 1000)
    const remainder = milliseconds % 1000
    const time = `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`
    return hours > 0 ? `${hours}:${time}` : time
  }

  function formatPlaneSize (size: PlaneSize) {
    return `${size.width} × ${size.height}`
  }
</script>

<style scoped>
.preview {
  display: block;
  width: 100%;
  max-height: 400px;
  background: #000;
}

.preview-canvas {
  display: block;
  width: 100%;
  max-height: 240px;
  background: #000;
  border-radius: 8px;
}
</style>
