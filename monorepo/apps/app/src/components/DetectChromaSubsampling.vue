<template>
  <v-empty-state
    v-if="error"
    icon="mdi-video-off-outline"
    :text="error"
    title="Unsupported video"
  >
    <template #actions>
      <v-btn
        color="primary"
        prepend-icon="mdi-arrow-left"
        text="Choose another video"
        @click="emit('discard')"
      />
    </template>
  </v-empty-state>

  <v-empty-state v-else title="Extracting the first video frame…">
    <template #media>
      <v-progress-circular class="mb-4" indeterminate size="48" />
    </template>
  </v-empty-state>
</template>

<script lang="ts" setup>
  import { ChromaSubsampling } from 'interface'
  import { onBeforeUnmount, onMounted, ref } from 'vue'

  const { video } = defineProps<{
    video: HTMLVideoElement
  }>()

  const emit = defineEmits<{
    detected: [chromaSubsampling: ChromaSubsampling]
    discard: []
  }>()

  const error = ref<string | null>(null)
  let disposed = false
  let cancelFrameWait: (() => void) | null = null

  onBeforeUnmount(() => {
    disposed = true
    cancelFrameWait?.()
  })

  onMounted(async () => {
    try {
      const frame = await extractFirstFrame(video)
      try {
        const subsampling = detectChromaSubsampling(frame.format)
        if (subsampling === null) {
          error.value = `This video does not expose a YUV frame format (${frame.format ?? 'unknown'}). Please upload a video that uses a YUV format.`
          return
        }

        emit('detected', subsampling)
      } finally {
        frame.close()
      }
    } catch (error_) {
      if (disposed) return
      error.value = error_ instanceof Error ? error_.message : 'Unable to extract a video frame.'
    }
  })

  async function extractFirstFrame (element: HTMLVideoElement): Promise<VideoFrame> {
    if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      try {
        return new VideoFrame(element)
      } catch (error) {
        // readyState can advance before the decoded frame has been presented.
        // In that case, wait for the browser's decoded-frame notification below.
        if (!(error instanceof DOMException) || error.name !== 'InvalidStateError') throw error
      }
    }

    await new Promise<void>((resolve, reject) => {
      const callbackId = element.requestVideoFrameCallback(() => {
        cleanup()
        resolve()
      })
      const onError = () => {
        cleanup()
        reject(new Error('The selected video could not be decoded.'))
      }
      const cleanup = () => {
        element.cancelVideoFrameCallback(callbackId)
        element.removeEventListener('error', onError)
        cancelFrameWait = null
      }

      element.addEventListener('error', onError, { once: true })
      cancelFrameWait = () => {
        cleanup()
        reject(new DOMException('Frame extraction was cancelled.', 'AbortError'))
      }
    })

    return new VideoFrame(element)
  }

  function detectChromaSubsampling (pixelFormat: string | null): ChromaSubsampling | null {
    if (pixelFormat === null) return null

    if (/^(?:I420|I010|I012|I016|NV12|P010|P016)/.test(pixelFormat)) return ChromaSubsampling.YUV420
    if (/^(?:I422|I210|I212|I216)/.test(pixelFormat)) return ChromaSubsampling.YUV422
    if (/^(?:I444|I410|I412|I416)/.test(pixelFormat)) return ChromaSubsampling.YUV444

    return null
  }
</script>
