<template>
  <video
    ref="videoElement"
    controls
    playsinline
    :src="video.src"
    @play="startPlaybackCallback"
  />
</template>

<script lang="ts" setup>
  import type { ChromaSubsampling } from '@/ChromaSubsampling.ts'
  import type { VisualizeResources } from '@/VisualizeResources.ts'
  import { onBeforeUnmount, ref } from 'vue'

  const { queue, resources, video } = defineProps<{
    adapter: GPUAdapter
    chromaSubsampling: ChromaSubsampling
    device: GPUDevice
    queue: GPUQueue
    resources: VisualizeResources
    video: HTMLVideoElement
  }>()

  const videoElement = ref<HTMLVideoElement | null>(null)
  let callbackId: number | null = null
  let textureArrayIndex = 0

  function startPlaybackCallback () {
    schedulePlaybackCallback()
  }

  function schedulePlaybackCallback () {
    const element = videoElement.value
    if (!element || element.paused || element.ended || callbackId !== null) return

    callbackId = element.requestVideoFrameCallback(playbackCallback)
  }

  async function playbackCallback () {
    callbackId = null

    const element = videoElement.value
    if (!element || element.paused || element.ended) return

    const frame = new VideoFrame(element)
    try {
      const planeLayouts = await frame.copyTo(resources.frameData)
      const yPlaneLayout = planeLayouts[0]
      if (!yPlaneLayout) throw new Error('The video frame does not contain a luminance plane.')

      queue.writeTexture(
        {
          texture: resources.yTexture,
          origin: { x: 0, y: 0, z: textureArrayIndex },
        },
        resources.frameData,
        {
          offset: yPlaneLayout.offset,
          bytesPerRow: yPlaneLayout.stride,
          rowsPerImage: frame.displayHeight,
        },
        {
          width: frame.displayWidth,
          height: frame.displayHeight,
          depthOrArrayLayers: 1,
        },
      )

      textureArrayIndex = (textureArrayIndex + 1) % resources.textureArrayLength
    } finally {
      frame.close()
    }

    schedulePlaybackCallback()
  }

  onBeforeUnmount(() => {
    const element = videoElement.value
    if (element && callbackId !== null) element.cancelVideoFrameCallback(callbackId)
  })
</script>
