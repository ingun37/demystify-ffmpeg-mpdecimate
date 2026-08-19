import type {
  ChromaSubsampling,
  PlaneSize,
  YUVTextureCommands,
  YUVTexturePipelineError,
} from 'interface'
import type { WebGPUComparisonControlsService, WebGPUDiffTexturesService } from 'webgpu-impl'
import { Context, Effect, Layer } from 'effect'
import { chromaPlaneSize, YUVTextureCommandEncoder } from 'interface'
import { WebGPUComparisonControls, WebGPUDiffTextures } from 'webgpu-impl'

/** Every service the visualize stage acquires from the backend layer. */
export type VisualizeServices
  = | YUVTextureCommandEncoder
    | WebGPUDiffTextures
    | WebGPUComparisonControls

/**
 * Everything the visualize stage needs to run the `interface` pipeline.
 *
 * `encoderLive` is the seam for the WebGPU backend: the app builds the real
 * `WebGPUDiffTextures.layer`, tests can substitute the mock layer without the
 * visualize stage changing.
 */
export interface VisualizeResources {
  readonly lumaSize: PlaneSize
  readonly chromaSize: PlaneSize
  readonly encoderLive: Layer.Layer<VisualizeServices, YUVTexturePipelineError>
}

/** The real WebGPU backend. Throws when a plane is too small to compare. */
export function createWebGPUVisualizeResources (
  device: GPUDevice,
  queue: GPUQueue,
  lumaSize: PlaneSize,
  chromaSubsampling: ChromaSubsampling,
): VisualizeResources {
  const chromaSize = chromaPlaneSize(chromaSubsampling, lumaSize.width, lumaSize.height)
  if (lumaSize.width < 16 || lumaSize.height < 8
    || chromaSize.width < 16 || chromaSize.height < 8) {
    throw new Error(
      `SAD comparison needs every plane to be at least 16×8; `
      + `${lumaSize.width}×${lumaSize.height} video has `
      + `${chromaSize.width}×${chromaSize.height} chroma planes.`,
    )
  }
  return {
    lumaSize,
    chromaSize,
    encoderLive: WebGPUDiffTextures.layer(device, queue, {
      width: lumaSize.width,
      height: lumaSize.height,
      chromaSubsampling,
    }),
  }
}

const mockCommands: YUVTextureCommands = {
  enqueuePlaneWrite: () => Effect.void,
  enqueueUVDeinterleave: () => Effect.void,
  enqueueComparison: () =>
    Effect.succeed({
      read: Effect.succeed({
        isFrameKept: true,
        luma: { overLo: 0, overHi: 0 },
        u: { overLo: 0, overHi: 0 },
        v: { overLo: 0, overHi: 0 },
        lumaLoLimit: 0,
        chromaLoLimit: 0,
      }),
    }),
  enqueueReferenceCopy: () => Effect.void,
}

// One texel per complete 8x8 SAD window, matching the real backend's sizing.
function sadWindowOutputSize (size: PlaneSize): PlaneSize {
  return {
    width: Math.floor((size.width - 16) / 4) + 1,
    height: Math.floor((size.height - 8) / 4) + 1,
  }
}

/** Carries only the dimensions a test can read; GPU methods are absent. */
function mockTexture (size: PlaneSize): GPUTexture {
  return { width: size.width, height: size.height } as GPUTexture
}

function mockDiffTextures (lumaSize: PlaneSize,
  chromaSize: PlaneSize): WebGPUDiffTexturesService {
  const lumaWindowSize = sadWindowOutputSize(lumaSize)
  const chromaWindowSize = sadWindowOutputSize(chromaSize)
  return {
    lumaLo: mockTexture(lumaWindowSize),
    lumaHi: mockTexture(lumaWindowSize),
    chromaLo: mockTexture(chromaWindowSize),
    chromaHi: mockTexture(chromaWindowSize),
  }
}

const mockControls: WebGPUComparisonControlsService = {
  setThresholds: () => Effect.void,
  setFraction: () => Effect.void,
}

/** A backend that records nothing and classifies every frame as kept. */
export function createMockVisualizeResources (
  lumaSize: PlaneSize,
  chromaSubsampling: ChromaSubsampling,
): VisualizeResources {
  const chromaSize = chromaPlaneSize(chromaSubsampling, lumaSize.width, lumaSize.height)
  return {
    lumaSize,
    chromaSize,
    encoderLive: Layer.succeedContext(
      Context.make(YUVTextureCommandEncoder, {
        submit: record => record(mockCommands),
      }).pipe(
        Context.add(WebGPUDiffTextures, mockDiffTextures(lumaSize, chromaSize)),
        Context.add(WebGPUComparisonControls, mockControls),
      ),
    ),
  }
}
