import type { VisualizeResources } from '@/VisualizeResources'
import type { ChromaSubsampling } from 'interface'

/** The WebGPU handles shared by every stage after initialization. */
export interface WebGPUContext {
  readonly adapter: GPUAdapter
  readonly device: GPUDevice
  readonly queue: GPUQueue
}

/** A user-selected video with the object URL that must be revoked later. */
export interface UploadedVideo {
  readonly element: HTMLVideoElement
  readonly objectUrl: string
}

/**
 * The application is a linear sequence of stages. Each stage owns exactly the
 * data produced so far, so a stage component can never render before its
 * inputs exist.
 */
export type Stage
  = | { readonly name: 'initialize-webgpu' }
    | { readonly name: 'upload-video', readonly context: WebGPUContext }
    | {
      readonly name: 'detect-chroma-subsampling'
      readonly context: WebGPUContext
      readonly video: UploadedVideo
    }
    | {
      readonly name: 'prepare-visualize'
      readonly context: WebGPUContext
      readonly video: UploadedVideo
      readonly chromaSubsampling: ChromaSubsampling
    }
    | {
      readonly name: 'visualize'
      readonly context: WebGPUContext
      readonly video: UploadedVideo
      readonly chromaSubsampling: ChromaSubsampling
      readonly resources: VisualizeResources
    }
