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

  const { device, queue, resources, video } = defineProps<{
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

      if (planeLayouts.length === 2) {
        const uvPlaneLayout = planeLayouts[1]
        if (!uvPlaneLayout) throw new Error('The video frame does not contain a chroma plane.')

        const chromaWidth = resources.uTexture.width
        const chromaHeight = resources.uTexture.height
        const chromaByteLength = chromaWidth * chromaHeight
        queue.writeBuffer(
          resources.uvCombinedBuffer,
          0,
          resources.frameData,
          uvPlaneLayout.offset,
          2 * chromaByteLength,
        )
        queue.writeBuffer(resources.uvLayerIndexBuffer, 0, new Uint32Array([textureArrayIndex]))

        const commandEncoder = device.createCommandEncoder()
        const computePass = commandEncoder.beginComputePass()
        computePass.setPipeline(resources.uvDeinterleavePipeline)
        computePass.setBindGroup(0, resources.uvDeinterleaveBindGroup)
        computePass.dispatchWorkgroups(Math.ceil(chromaWidth / 8), Math.ceil(chromaHeight / 8))
        computePass.end()
        queue.submit([commandEncoder.finish()])
      }

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
