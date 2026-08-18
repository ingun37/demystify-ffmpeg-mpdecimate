import type {
  PlaneSize,
  YUVTextureCommandEncoder,
  YUVTextureCommands,
} from 'interface'
import { Effect, Layer } from 'effect'
import { ChromaSubsampling, YUVTextureCommandEncoder as YUVTextureCommandEncoderTag } from 'interface'

/**
 * Everything the visualize stage needs to run the `interface` pipeline.
 *
 * `encoderLive` is the seam for the WebGPU backend: today it is a mock layer
 * that keeps every frame, later it becomes `makeWebGPULayer` from
 * `webgpu-impl` without the visualize stage changing.
 */
export interface VisualizeResources {
  readonly lumaSize: PlaneSize
  readonly chromaSize: PlaneSize
  readonly encoderLive: Layer.Layer<YUVTextureCommandEncoder>
}

export function getChromaPlaneSize (
  lumaSize: PlaneSize,
  subsampling: ChromaSubsampling,
): PlaneSize {
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

const mockCommands: YUVTextureCommands = {
  enqueuePlaneWrite: () => Effect.void,
  enqueueUVDeinterleave: () => Effect.void,
  enqueueComparison: () =>
    Effect.succeed({ read: Effect.succeed({ isFrameKept: true }) }),
  enqueueReferenceCopy: () => Effect.void,
}

/** A backend that records nothing and classifies every frame as kept. */
const mockEncoderLive = Layer.succeed(YUVTextureCommandEncoderTag)({
  submit: record => record(mockCommands),
})

export function createMockVisualizeResources (
  lumaSize: PlaneSize,
  chromaSubsampling: ChromaSubsampling,
): VisualizeResources {
  return {
    lumaSize,
    chromaSize: getChromaPlaneSize(lumaSize, chromaSubsampling),
    encoderLive: mockEncoderLive,
  }
}
