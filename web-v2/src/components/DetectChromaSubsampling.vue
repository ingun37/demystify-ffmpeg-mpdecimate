<template>
  <p v-if="error">{{ error }}</p>
  <p v-else-if="format === null">Extracting the first video frame…</p>

  <dl v-else>
    <dt>VideoFrame format</dt>
    <dd>{{ format }}</dd>
    <dt>Chroma subsampling</dt>
    <dd>{{ chromaSubsampling }}</dd>
  </dl>
</template>

<script lang="ts" setup>
  import { onMounted, ref } from 'vue'

  const { video } = defineProps<{
    adapter: GPUAdapter
    device: GPUDevice
    queue: GPUQueue
    video: HTMLVideoElement
  }>()

  const format = ref<string | null>(null)
  const chromaSubsampling = ref<string | null>(null)
  const error = ref<string | null>(null)

  onMounted(async () => {
    try {
      const frame = await extractFirstFrame(video)
      format.value = frame.format ?? 'unknown'
      chromaSubsampling.value = detectChromaSubsampling(frame.format)
      frame.close()
    } catch (error_) {
      error.value = error_ instanceof Error ? error_.message : 'Unable to extract a video frame.'
    }
  })

  async function extractFirstFrame (element: HTMLVideoElement): Promise<VideoFrame> {
    if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      return new VideoFrame(element)
    }

    await new Promise<void>((resolve, reject) => {
      const onLoadedData = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error('The selected video could not be decoded.'))
      }
      const cleanup = () => {
        element.removeEventListener('loadeddata', onLoadedData)
        element.removeEventListener('error', onError)
      }

      element.addEventListener('loadeddata', onLoadedData, { once: true })
      element.addEventListener('error', onError, { once: true })
    })

    return new VideoFrame(element)
  }

  function detectChromaSubsampling (pixelFormat: string | null): string {
    if (pixelFormat === null) return 'unknown (the browser did not expose a pixel format)'

    if (/^(?:I420|I010|I012|I016|NV12|P010|P016)/.test(pixelFormat)) return '4:2:0'
    if (/^(?:I422|I210|I212|I216)/.test(pixelFormat)) return '4:2:2'
    if (/^(?:I444|I410|I412|I416)/.test(pixelFormat)) return '4:4:4'

    return `unknown (${pixelFormat} is not a recognized YUV format)`
  }
</script>
