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
  import { type FunctionInfo, WgslReflect } from 'wgsl_reflect'
  import { ChromaSubsampling } from '@/ChromaSubsampling.ts'
  import Visualize from '@/components/Visualize.vue'
  import doubleBlitShader from '@/shaders/double_blit.wgsl?raw'
  import chromaSadThresholdShader from '@/shaders/sad_threshold_8x8_window_chrominance.wgsl?raw'
  import sadThresholdShader from '@/shaders/sad_threshold_8x8_window_luminance.wgsl?raw'
  import uvDeinterleaveShader from '@/shaders/uv_deinterleave.wgsl?raw'
  import yMapShader from '@/shaders/y_map.wgsl?raw'

  const { adapter, chromaSubsampling, device, queue, video } = defineProps<{
    adapter: GPUAdapter
    chromaSubsampling: ChromaSubsampling
    device: GPUDevice
    queue: GPUQueue
    video: HTMLVideoElement
  }>()

  const resources = ref<VisualizeResources | null>(null)
  const error = ref<string | null>(null)
  const planeTextureUsage: GPUTextureUsageFlags = 0x08 | 0x04 // STORAGE_BINDING | TEXTURE_BINDING
  const storageBufferUsage: GPUBufferUsageFlags = 0x80 | 0x08 // STORAGE | COPY_DST
  const uniformBufferUsage: GPUBufferUsageFlags = 0x40 | 0x08 // UNIFORM | COPY_DST
  const textureArrayLength = 2
  const defaultLoThreshold = 64 * 5
  const defaultHiThreshold = 64 * 12

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
      const yTexture = createPlaneTexture(gpuDevice, lumaSize, textureArrayLength)
      textures.push(yTexture)
      const uTexture = createPlaneTexture(gpuDevice, chromaSize, textureArrayLength)
      textures.push(uTexture)
      const vTexture = createPlaneTexture(gpuDevice, chromaSize, textureArrayLength)
      textures.push(vTexture)

      const yBuffer = gpuDevice.createBuffer({ size: lumaByteLength, usage: storageBufferUsage })
      buffers.push(yBuffer)
      const uBuffer = gpuDevice.createBuffer({ size: chromaByteLength, usage: storageBufferUsage })
      buffers.push(uBuffer)
      const vBuffer = gpuDevice.createBuffer({ size: chromaByteLength, usage: storageBufferUsage })
      buffers.push(vBuffer)
      const uvCombinedBuffer = gpuDevice.createBuffer({
        size: 2 * chromaByteLength,
        usage: storageBufferUsage,
      })
      buffers.push(uvCombinedBuffer)
      const layerIndexBuffer = gpuDevice.createBuffer({ size: 4, usage: uniformBufferUsage })
      buffers.push(layerIndexBuffer)
      const loThresholdBuffer = gpuDevice.createBuffer({ size: 4, usage: uniformBufferUsage })
      buffers.push(loThresholdBuffer)
      const hiThresholdBuffer = gpuDevice.createBuffer({ size: 4, usage: uniformBufferUsage })
      buffers.push(hiThresholdBuffer)
      gpuDevice.queue.writeBuffer(loThresholdBuffer, 0, new Int32Array([defaultLoThreshold]))
      gpuDevice.queue.writeBuffer(hiThresholdBuffer, 0, new Int32Array([defaultHiThreshold]))

      const sadWindowOutputSize = getSadWindowOutputSize(lumaSize)
      const loOutTexture = createOutputTexture(gpuDevice, sadWindowOutputSize)
      textures.push(loOutTexture)
      const hiOutTexture = createOutputTexture(gpuDevice, sadWindowOutputSize)
      textures.push(hiOutTexture)
      const chromaSadWindowOutputSize = getSadWindowOutputSize(chromaSize)
      const chromaLoOutTexture = createOutputTexture(gpuDevice, chromaSadWindowOutputSize)
      textures.push(chromaLoOutTexture)
      const chromaHiOutTexture = createOutputTexture(gpuDevice, chromaSadWindowOutputSize)
      textures.push(chromaHiOutTexture)

      const doubleBlitModule = gpuDevice.createShaderModule({ code: doubleBlitShader })
      const doubleBlitReflection = new WgslReflect(doubleBlitShader)
      const doubleBlitVertexEntryPoint = doubleBlitReflection.entry.vertex[0]
      const doubleBlitFragmentEntryPoint = doubleBlitReflection.entry.fragment[0]
      if (!doubleBlitVertexEntryPoint || !doubleBlitFragmentEntryPoint) {
        throw new Error('The double blit shader must have vertex and fragment entry points.')
      }
      const doubleBlitPipeline = gpuDevice.createRenderPipeline({
        layout: 'auto',
        vertex: { module: doubleBlitModule, entryPoint: doubleBlitVertexEntryPoint.name },
        fragment: {
          module: doubleBlitModule,
          entryPoint: doubleBlitFragmentEntryPoint.name,
          targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }, { format: navigator.gpu.getPreferredCanvasFormat() }],
        },
        primitive: { topology: 'triangle-strip' },
      })
      const doubleBlitBindings = doubleBlitReflection.getBindGroups()[0]
      if (!doubleBlitBindings) throw new Error('The double blit shader has no bind group 0.')
      const doubleBlitBinding = (name: string) => {
        const resource = doubleBlitBindings.find(candidate => candidate.name === name)
        if (!resource) throw new Error(`The double blit shader is missing the ${name} binding.`)
        return resource.binding
      }
      const doubleBlitBindGroup = gpuDevice.createBindGroup({
        layout: doubleBlitPipeline.getBindGroupLayout(0),
        entries: [
          { binding: doubleBlitBinding('src_sampler'), resource: gpuDevice.createSampler() },
          { binding: doubleBlitBinding('lo_src_texture'), resource: loOutTexture.createView() },
          { binding: doubleBlitBinding('hi_src_texture'), resource: hiOutTexture.createView() },
        ],
      })
      const chromaDoubleBlitBindGroup = gpuDevice.createBindGroup({
        layout: doubleBlitPipeline.getBindGroupLayout(0),
        entries: [
          { binding: doubleBlitBinding('src_sampler'), resource: gpuDevice.createSampler() },
          { binding: doubleBlitBinding('lo_src_texture'), resource: chromaLoOutTexture.createView() },
          { binding: doubleBlitBinding('hi_src_texture'), resource: chromaHiOutTexture.createView() },
        ],
      })

      const yShaderModule = gpuDevice.createShaderModule({ code: yMapShader })
      const yReflection = new WgslReflect(yMapShader)
      const yComputeEntryPoint = yReflection.entry.compute[0]
      if (!yComputeEntryPoint) throw new Error('The Y map shader has no compute entry point.')
      const yMapWorkgroupSize = getWorkgroupSize(yComputeEntryPoint, 'Y map')

      const yMapPipeline = gpuDevice.createComputePipeline({
        layout: 'auto',
        compute: { module: yShaderModule, entryPoint: yComputeEntryPoint.name },
      })
      const yReflectedBindings = yReflection.getBindGroups()[0]
      if (!yReflectedBindings) throw new Error('The Y map shader has no bind group 0.')
      const yBinding = (name: string) => {
        const resource = yReflectedBindings.find(candidate => candidate.name === name)
        if (!resource) throw new Error(`The Y map shader is missing the ${name} binding.`)
        return resource.binding
      }
      const yMapBindGroup = gpuDevice.createBindGroup({
        layout: yMapPipeline.getBindGroupLayout(0),
        entries: [
          { binding: yBinding('y_bytes'), resource: { buffer: yBuffer } },
          { binding: yBinding('y_texture'), resource: yTexture.createView({ dimension: '2d-array' }) },
          { binding: yBinding('layer_index'), resource: { buffer: layerIndexBuffer } },
        ],
      })
      const uMapBindGroup = gpuDevice.createBindGroup({
        layout: yMapPipeline.getBindGroupLayout(0),
        entries: [
          { binding: yBinding('y_bytes'), resource: { buffer: uBuffer } },
          { binding: yBinding('y_texture'), resource: uTexture.createView({ dimension: '2d-array' }) },
          { binding: yBinding('layer_index'), resource: { buffer: layerIndexBuffer } },
        ],
      })
      const vMapBindGroup = gpuDevice.createBindGroup({
        layout: yMapPipeline.getBindGroupLayout(0),
        entries: [
          { binding: yBinding('y_bytes'), resource: { buffer: vBuffer } },
          { binding: yBinding('y_texture'), resource: vTexture.createView({ dimension: '2d-array' }) },
          { binding: yBinding('layer_index'), resource: { buffer: layerIndexBuffer } },
        ],
      })

      const shaderModule = gpuDevice.createShaderModule({ code: uvDeinterleaveShader })
      const reflection = new WgslReflect(uvDeinterleaveShader)
      const computeEntryPoint = reflection.entry.compute[0]
      if (!computeEntryPoint) throw new Error('The UV deinterleave shader has no compute entry point.')
      const uvDeinterleaveWorkgroupSize = getWorkgroupSize(computeEntryPoint, 'UV deinterleave')

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
          { binding: binding('layer_index'), resource: { buffer: layerIndexBuffer } },
        ],
      })

      const sadThresholdModule = gpuDevice.createShaderModule({ code: sadThresholdShader })
      const sadThresholdReflection = new WgslReflect(sadThresholdShader)
      const sadThresholdEntryPoint = sadThresholdReflection.entry.compute[0]
      if (!sadThresholdEntryPoint) throw new Error('The SAD threshold shader has no compute entry point.')
      const sadThresholdWorkgroupSize = getWorkgroupSize(sadThresholdEntryPoint, 'SAD threshold')
      const sadThresholdPipeline = gpuDevice.createComputePipeline({
        layout: 'auto',
        compute: { module: sadThresholdModule, entryPoint: sadThresholdEntryPoint.name },
      })
      const sadThresholdBindings = sadThresholdReflection.getBindGroups()[0]
      if (!sadThresholdBindings) throw new Error('The SAD threshold shader has no bind group 0.')
      const sadThresholdBinding = (name: string) => {
        const resource = sadThresholdBindings.find(candidate => candidate.name === name)
        if (!resource) throw new Error(`The SAD threshold shader is missing the ${name} binding.`)
        return resource.binding
      }
      const sadThresholdBindGroup = gpuDevice.createBindGroup({
        layout: sadThresholdPipeline.getBindGroupLayout(0),
        entries: [
          { binding: sadThresholdBinding('y_texture'), resource: yTexture.createView({ dimension: '2d-array' }) },
          { binding: sadThresholdBinding('layer_index'), resource: { buffer: layerIndexBuffer } },
          { binding: sadThresholdBinding('lo_out'), resource: loOutTexture.createView() },
          { binding: sadThresholdBinding('hi_out'), resource: hiOutTexture.createView() },
          { binding: sadThresholdBinding('lo_threshold'), resource: { buffer: loThresholdBuffer } },
          { binding: sadThresholdBinding('hi_threshold'), resource: { buffer: hiThresholdBuffer } },
        ],
      })

      const chromaSadThresholdModule = gpuDevice.createShaderModule({ code: chromaSadThresholdShader })
      const chromaSadThresholdReflection = new WgslReflect(chromaSadThresholdShader)
      const chromaSadThresholdEntryPoint = chromaSadThresholdReflection.entry.compute[0]
      if (!chromaSadThresholdEntryPoint) throw new Error('The chroma SAD threshold shader has no compute entry point.')
      const chromaSadThresholdWorkgroupSize = getWorkgroupSize(chromaSadThresholdEntryPoint, 'chroma SAD threshold')
      const chromaSadThresholdPipeline = gpuDevice.createComputePipeline({
        layout: 'auto',
        compute: { module: chromaSadThresholdModule, entryPoint: chromaSadThresholdEntryPoint.name },
      })
      const chromaSadThresholdBindings = chromaSadThresholdReflection.getBindGroups()[0]
      if (!chromaSadThresholdBindings) throw new Error('The chroma SAD threshold shader has no bind group 0.')
      const chromaSadThresholdBinding = (name: string) => {
        const resource = chromaSadThresholdBindings.find(candidate => candidate.name === name)
        if (!resource) throw new Error(`The chroma SAD threshold shader is missing the ${name} binding.`)
        return resource.binding
      }
      const chromaSadThresholdBindGroup = gpuDevice.createBindGroup({
        layout: chromaSadThresholdPipeline.getBindGroupLayout(0),
        entries: [
          { binding: chromaSadThresholdBinding('u_texture'), resource: uTexture.createView({ dimension: '2d-array' }) },
          { binding: chromaSadThresholdBinding('v_texture'), resource: vTexture.createView({ dimension: '2d-array' }) },
          { binding: chromaSadThresholdBinding('layer_index'), resource: { buffer: layerIndexBuffer } },
          { binding: chromaSadThresholdBinding('lo_out'), resource: chromaLoOutTexture.createView() },
          { binding: chromaSadThresholdBinding('hi_out'), resource: chromaHiOutTexture.createView() },
          { binding: chromaSadThresholdBinding('lo_threshold'), resource: { buffer: loThresholdBuffer } },
          { binding: chromaSadThresholdBinding('hi_threshold'), resource: { buffer: hiThresholdBuffer } },
        ],
      })

      return {
        textureArrayLength,
        frameData,
        yBuffer,
        layerIndexBuffer,
        yMapPipeline,
        yMapBindGroup,
        uMapBindGroup,
        vMapBindGroup,
        yMapWorkgroupSize,
        uBuffer,
        vBuffer,
        uvCombinedBuffer,
        uvDeinterleavePipeline,
        uvDeinterleaveBindGroup,
        uvDeinterleaveWorkgroupSize,
        yTexture,
        uTexture,
        vTexture,
        sadThresholdPipeline,
        sadThresholdBindGroup,
        sadThresholdWorkgroupSize,
        chromaSadThresholdPipeline,
        chromaSadThresholdBindGroup,
        chromaSadThresholdWorkgroupSize,
        loThresholdBuffer,
        hiThresholdBuffer,
        loOutTexture,
        hiOutTexture,
        chromaLoOutTexture,
        chromaHiOutTexture,
        doubleBlitPipeline,
        doubleBlitBindGroup,
        chromaDoubleBlitBindGroup,
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

  function getWorkgroupSize (
    entryPoint: FunctionInfo,
    shaderName: string,
  ): [number, number, number] {
    const attribute = entryPoint.attributes?.find(candidate => candidate.name === 'workgroup_size')
    if (!attribute?.value) throw new Error(`The ${shaderName} shader has no workgroup_size attribute.`)

    const reflectedValues = Array.isArray(attribute.value) ? attribute.value : [attribute.value]
    const workgroupSize = [
      Number(reflectedValues[0] ?? '1'),
      Number(reflectedValues[1] ?? '1'),
      Number(reflectedValues[2] ?? '1'),
    ] as [number, number, number]
    if (workgroupSize.some(value => !Number.isInteger(value) || value <= 0)) {
      throw new Error(`The ${shaderName} shader has an invalid workgroup_size attribute.`)
    }

    return workgroupSize
  }

  function createPlaneTexture (
    gpuDevice: GPUDevice,
    size: { width: number, height: number },
    arrayLength: number,
  ) {
    return gpuDevice.createTexture({
      size: { ...size, depthOrArrayLayers: arrayLength },
      dimension: '2d',
      format: 'rgba8unorm',
      usage: planeTextureUsage,
    })
  }

  function createOutputTexture (
    gpuDevice: GPUDevice,
    size: { width: number, height: number },
  ) {
    return gpuDevice.createTexture({
      size,
      format: 'rgba8unorm',
      usage: planeTextureUsage,
    })
  }

  function getSadWindowOutputSize (planeSize: { width: number, height: number }) {
    // FFmpeg scans complete 8x8 windows at x = 8, 12, ... and y = 0, 4, ... .
    const width = Math.floor((planeSize.width - 16) / 4) + 1
    const height = Math.floor((planeSize.height - 8) / 4) + 1
    if (width < 1 || height < 1) {
      throw new Error('SAD thresholding requires a plane of at least 16×8 pixels.')
    }
    return { width, height }
  }
</script>

<script lang="ts">
</script>
