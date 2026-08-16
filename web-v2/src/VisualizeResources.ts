export interface VisualizeResources {
  textureArrayLength: number
  frameData: Uint8Array
  yBuffer: GPUBuffer
  layerIndexBuffer: GPUBuffer
  yMapPipeline: GPUComputePipeline
  yMapBindGroup: GPUBindGroup
  yMapWorkgroupSize: [number, number, number]
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
  loThresholdBuffer: GPUBuffer
  hiThresholdBuffer: GPUBuffer
  loOutTexture: GPUTexture
  hiOutTexture: GPUTexture
}
