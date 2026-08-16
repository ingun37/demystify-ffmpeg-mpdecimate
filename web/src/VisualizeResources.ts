export interface VisualizeResources {
  textureArrayLength: number
  frameData: Uint8Array
  yBuffer: GPUBuffer
  layerIndexBuffer: GPUBuffer
  yMapPipeline: GPUComputePipeline
  yMapBindGroup: GPUBindGroup
  uMapBindGroup: GPUBindGroup
  vMapBindGroup: GPUBindGroup
  yMapWorkgroupSize: [number, number, number]
  uBuffer: GPUBuffer
  vBuffer: GPUBuffer
  uvCombinedBuffer: GPUBuffer
  uvDeinterleavePipeline: GPUComputePipeline
  uvDeinterleaveBindGroup: GPUBindGroup
  uvDeinterleaveWorkgroupSize: [number, number, number]
  yTexture: GPUTexture
  uTexture: GPUTexture
  vTexture: GPUTexture
  sadThresholdPipeline: GPUComputePipeline
  sadThresholdBindGroup: GPUBindGroup
  sadThresholdWorkgroupSize: [number, number, number]
  chromaSadThresholdPipeline: GPUComputePipeline
  chromaSadThresholdBindGroup: GPUBindGroup
  chromaSadThresholdWorkgroupSize: [number, number, number]
  loThresholdBuffer: GPUBuffer
  hiThresholdBuffer: GPUBuffer
  loOutTexture: GPUTexture
  hiOutTexture: GPUTexture
  chromaLoOutTexture: GPUTexture
  chromaHiOutTexture: GPUTexture
  nonzeroCountPipeline: GPUComputePipeline
  nonzeroCountWorkgroupSize: [number, number, number]
  loNonzeroCountBindGroup: GPUBindGroup
  hiNonzeroCountBindGroup: GPUBindGroup
  chromaLoNonzeroCountBindGroup: GPUBindGroup
  chromaHiNonzeroCountBindGroup: GPUBindGroup
  loNonzeroCountBuffer: GPUBuffer
  hiNonzeroCountBuffer: GPUBuffer
  chromaLoNonzeroCountBuffer: GPUBuffer
  chromaHiNonzeroCountBuffer: GPUBuffer
  loNonzeroCountReadBuffer: GPUBuffer
  hiNonzeroCountReadBuffer: GPUBuffer
  chromaLoNonzeroCountReadBuffer: GPUBuffer
  chromaHiNonzeroCountReadBuffer: GPUBuffer
  doubleBlitPipeline: GPURenderPipeline
  doubleBlitBindGroup: GPUBindGroup
  chromaDoubleBlitBindGroup: GPUBindGroup
}

export function destroyVisualizeResources (resources: VisualizeResources) {
  const textures = [
    resources.yTexture,
    resources.uTexture,
    resources.vTexture,
    resources.loOutTexture,
    resources.hiOutTexture,
    resources.chromaLoOutTexture,
    resources.chromaHiOutTexture,
  ]
  const buffers = [
    resources.yBuffer,
    resources.uBuffer,
    resources.vBuffer,
    resources.uvCombinedBuffer,
    resources.layerIndexBuffer,
    resources.loThresholdBuffer,
    resources.hiThresholdBuffer,
    resources.loNonzeroCountBuffer,
    resources.hiNonzeroCountBuffer,
    resources.chromaLoNonzeroCountBuffer,
    resources.chromaHiNonzeroCountBuffer,
    resources.loNonzeroCountReadBuffer,
    resources.hiNonzeroCountReadBuffer,
    resources.chromaLoNonzeroCountReadBuffer,
    resources.chromaHiNonzeroCountReadBuffer,
  ]

  for (const texture of textures) {
    texture.destroy()
  }
  for (const buffer of buffers) {
    buffer.destroy()
  }
}
