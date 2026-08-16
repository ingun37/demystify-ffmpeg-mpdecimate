export interface VisualizeResources {
  textureArrayLength: number
  frameData: Uint8Array
  yBuffer: GPUBuffer
  layerIndexBuffer: GPUBuffer
  yMapPipeline: GPUComputePipeline
  yMapBindGroup: GPUBindGroup
  uvCombinedBuffer: GPUBuffer
  uvDeinterleavePipeline: GPUComputePipeline
  uvDeinterleaveBindGroup: GPUBindGroup
  yTexture: GPUTexture
  uTexture: GPUTexture
  vTexture: GPUTexture
}
