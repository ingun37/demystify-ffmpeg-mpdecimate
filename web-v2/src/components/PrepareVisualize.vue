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
  import { WgslReflect } from 'wgsl_reflect'
  import { ChromaSubsampling } from '@/ChromaSubsampling.ts'
  import Visualize from '@/components/Visualize.vue'
  import uvDeinterleaveShader from '@/shaders/uv_deinterleave.wgsl?raw'

  const { adapter, chromaSubsampling, device, queue, video } = defineProps<{
    adapter: GPUAdapter
    chromaSubsampling: ChromaSubsampling
    device: GPUDevice
    queue: GPUQueue
    video: HTMLVideoElement
  }>()

  const resources = ref<VisualizeResources | null>(null)
  const error = ref<string | null>(null)
  const lumaTextureUsage: GPUTextureUsageFlags = 0x04 | 0x02 // TEXTURE_BINDING | COPY_DST
  const chromaTextureUsage: GPUTextureUsageFlags = 0x08 | 0x04 // STORAGE_BINDING | TEXTURE_BINDING
  const storageBufferUsage: GPUBufferUsageFlags = 0x80 | 0x08 // STORAGE | COPY_DST
  const uniformBufferUsage: GPUBufferUsageFlags = 0x40 | 0x08 // UNIFORM | COPY_DST
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
    const buffers: GPUBuffer[] = []

    try {
      const yTexture = createPlaneTexture(
        gpuDevice,
        lumaSize,
        textureArrayLength,
        'r8unorm',
        lumaTextureUsage,
      )
      textures.push(yTexture)
      const uTexture = createPlaneTexture(
        gpuDevice,
        chromaSize,
        textureArrayLength,
        'r32float',
        chromaTextureUsage,
      )
      textures.push(uTexture)
      const vTexture = createPlaneTexture(
        gpuDevice,
        chromaSize,
        textureArrayLength,
        'r32float',
        chromaTextureUsage,
      )
      textures.push(vTexture)

      const uvCombinedBuffer = gpuDevice.createBuffer({
        size: 2 * chromaByteLength,
        usage: storageBufferUsage,
      })
      buffers.push(uvCombinedBuffer)
      const uvLayerIndexBuffer = gpuDevice.createBuffer({ size: 4, usage: uniformBufferUsage })
      buffers.push(uvLayerIndexBuffer)

      const shaderModule = gpuDevice.createShaderModule({ code: uvDeinterleaveShader })
      const reflection = new WgslReflect(uvDeinterleaveShader)
      const computeEntryPoint = reflection.entry.compute[0]
      if (!computeEntryPoint) throw new Error('The UV deinterleave shader has no compute entry point.')

      const uvDeinterleavePipeline = gpuDevice.createComputePipeline({
        layout: 'auto',
        compute: { module: shaderModule, entryPoint: computeEntryPoint.name },
      })
      const reflectedBindings = reflection.getBindGroups()[0]
      if (!reflectedBindings) throw new Error('The UV deinterleave shader has no bind group 0.')
      const binding = (name: string) => {
        const resource = reflectedBindings.find(candidate => candidate.name === name)
        if (!resource) throw new Error(`The UV deinterleave shader is missing the ${name} binding.`)
        return resource.binding
      }
      const uvDeinterleaveBindGroup = gpuDevice.createBindGroup({
        layout: uvDeinterleavePipeline.getBindGroupLayout(0),
        entries: [
          { binding: binding('uv_combined'), resource: { buffer: uvCombinedBuffer } },
          { binding: binding('u_texture'), resource: uTexture.createView({ dimension: '2d-array' }) },
          { binding: binding('v_texture'), resource: vTexture.createView({ dimension: '2d-array' }) },
          { binding: binding('layer_index'), resource: { buffer: uvLayerIndexBuffer } },
        ],
      })

      return {
        textureArrayLength,
        frameData,
        uvCombinedBuffer,
        uvLayerIndexBuffer,
        uvDeinterleavePipeline,
        uvDeinterleaveBindGroup,
        yTexture,
        uTexture,
        vTexture,
      }
    } catch (error_) {
      for (const texture of textures) texture.destroy()
      for (const buffer of buffers) buffer.destroy()
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
    format: GPUTextureFormat,
    usage: GPUTextureUsageFlags,
  ) {
    return gpuDevice.createTexture({
      size: { ...size, depthOrArrayLayers: arrayLength },
      dimension: '2d',
      format,
      usage,
    })
  }
</script>

<script lang="ts">
</script>
