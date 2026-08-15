<template>
  <p v-if="error">{{ error }}</p>
  <p v-else-if="resources === null">Preparing WebGPU resources…</p>

  <Visualize
    v-else
    :adapter="adapter"
    :chroma-subsampling="chromaSubsampling"
    :device="device"
    :queue="queue"
    :resources="resources"
    :video="video"
  />
</template>

<script lang="ts" setup>
  import type { VisualizeResources } from '@/VisualizeResources.ts'
  import { onMounted, ref } from 'vue'
  import { ChromaSubsampling } from '@/ChromaSubsampling.ts'
  import Visualize from '@/components/Visualize.vue'

  const { adapter, chromaSubsampling, device, queue, video } = defineProps<{
    adapter: GPUAdapter
    chromaSubsampling: ChromaSubsampling
    device: GPUDevice
    queue: GPUQueue
    video: HTMLVideoElement
  }>()

  const resources = ref<VisualizeResources | null>(null)
  const error = ref<string | null>(null)
  const textureUsage: GPUTextureUsageFlags = 0x04 | 0x02 // TEXTURE_BINDING | COPY_DST
  const textureArrayLength = 2

  onMounted(() => {
    try {
      resources.value = createVisualizeResources(device, video, chromaSubsampling)
    } catch (error_) {
      error.value = error_ instanceof Error ? error_.message : 'Unable to create WebGPU textures.'
    }
  })

  function createVisualizeResources (
    gpuDevice: GPUDevice,
    element: HTMLVideoElement,
    subsampling: ChromaSubsampling,
  ): VisualizeResources {
    const lumaSize = { width: element.videoWidth, height: element.videoHeight }
    const chromaSize = getChromaPlaneSize(lumaSize, subsampling)
    const lumaByteLength = lumaSize.width * lumaSize.height
    const chromaByteLength = chromaSize.width * chromaSize.height
    const frameData = new Uint8Array(lumaByteLength + (2 * chromaByteLength))
    const textures: GPUTexture[] = []

    try {
      const yTexture = createPlaneTexture(gpuDevice, lumaSize, textureArrayLength)
      textures.push(yTexture)
      const uTexture = createPlaneTexture(gpuDevice, chromaSize, textureArrayLength)
      textures.push(uTexture)
      const vTexture = createPlaneTexture(gpuDevice, chromaSize, textureArrayLength)
      textures.push(vTexture)

      return { textureArrayLength, frameData, yTexture, uTexture, vTexture }
    } catch (error_) {
      for (const texture of textures) texture.destroy()
      throw error_
    }
  }

  function getChromaPlaneSize (
    lumaSize: { width: number, height: number },
    subsampling: ChromaSubsampling,
  ) {
    switch (subsampling) {
      case ChromaSubsampling.YUV420: {
        return { width: Math.ceil(lumaSize.width / 2), height: Math.ceil(lumaSize.height / 2) }
      }
      case ChromaSubsampling.YUV422: {
        return { width: Math.ceil(lumaSize.width / 2), height: lumaSize.height }
      }
      case ChromaSubsampling.YUV444: {
        return lumaSize
      }
    }
  }

  function createPlaneTexture (
    gpuDevice: GPUDevice,
    size: { width: number, height: number },
    arrayLength: number,
  ) {
    return gpuDevice.createTexture({
      size: { ...size, depthOrArrayLayers: arrayLength },
      dimension: '2d',
      format: 'r8unorm',
      usage: textureUsage,
    })
  }
</script>

<script lang="ts">
</script>
