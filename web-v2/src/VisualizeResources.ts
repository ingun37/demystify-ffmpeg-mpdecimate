export interface VisualizeResources {
  textureArrayLength: number
  frameData: Uint8Array
  uvCombinedBuffer: GPUBuffer
  uvLayerIndexBuffer: GPUBuffer
  uvDeinterleavePipeline: GPUComputePipeline
  uvDeinterleaveBindGroup: GPUBindGroup
  yTexture: GPUTexture
  uTexture: GPUTexture
  vTexture: GPUTexture
}
