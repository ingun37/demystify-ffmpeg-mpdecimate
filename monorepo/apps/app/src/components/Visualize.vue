<template>
  <v-container fluid>
    <v-row>
      <v-col cols="12" md="7">
        <v-card>
          <video
            ref="videoElement"
            class="preview"
            controls
            playsinline
            :src="video.src"
            @loadedmetadata="updateVideoInfo"
            @ratechange="updateVideoInfo"
            @timeupdate="updateCurrentTime"
          />
        </v-card>
      </v-col>

      <v-col cols="12" md="5">
        <v-card title="Video information" variant="tonal">
          <v-card-text>
            <v-list density="compact">
              <v-list-item subtitle="Resolution" :title="videoResolution" />
              <v-list-item subtitle="Duration" :title="formatTimestamp(videoDuration)" />
              <v-list-item subtitle="Playback rate" :title="`${playbackRate}×`" />
              <v-list-item subtitle="Current timestamp" :title="formatTimestamp(currentTime)" />
              <v-list-item subtitle="Chroma subsampling" :title="chromaSubsampling" />

              <v-list-item subtitle="mpdecimate">
                <template #title>
                  <v-chip
                    :color="isCurrentFrameKept ? 'success' : 'error'"
                    :prepend-icon="isCurrentFrameKept ? 'mdi-check' : 'mdi-close'"
                    :text="isCurrentFrameKept ? 'Frame is Kept' : 'Frame is Dropped'"
                  />
                </template>
              </v-list-item>
            </v-list>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-row>
      <v-col cols="12" md="6">
        <v-card subtitle="A frame differs when enough 8×8 windows exceed lo" title="Low threshold">
          <v-card-text>
            <v-slider
              v-model="loThreshold"
              hide-details
              label="lo"
              :max="16320"
              :step="64"
            >
              <template #append>
                <v-number-input
                  v-model="loThreshold"
                  density="compact"
                  hide-details
                  :step="64"
                  width="10em"
                />
              </template>
            </v-slider>

            <v-slider
              v-model="loFraction"
              hide-details
              label="frac"
              :max="1"
              :step="0.01"
            >
              <template #append>
                <v-number-input
                  v-model="loFraction"
                  density="compact"
                  hide-details
                  :precision="2"
                  :step="0.01"
                  width="10em"
                />
              </template>
            </v-slider>
          </v-card-text>

          <v-card-text v-if="comparison">
            <v-row density="compact">
              <v-col>
                <p :class="comparison.luma.overLo > comparison.lumaLoLimit ? 'text-success' : 'text-error'">
                  Lo luma Y : {{ comparison.luma.overLo }} &gt; {{ comparison.lumaLoLimit }}
                </p>
              </v-col>

              <v-col>
                <p :class="comparison.u.overLo > comparison.chromaLoLimit ? 'text-success' : 'text-error'">
                  Lo chroma U : {{ comparison.u.overLo }} &gt; {{ comparison.chromaLoLimit }}
                </p>
              </v-col>

              <v-col>
                <p :class="comparison.v.overLo > comparison.chromaLoLimit ? 'text-success' : 'text-error'">
                  Lo chroma V : {{ comparison.v.overLo }} &gt; {{ comparison.chromaLoLimit }}
                </p>
              </v-col>
            </v-row>
          </v-card-text>

          <v-card-text>
            <p class="text-label-small mb-1">Lo luma ({{ formatPlaneSize(resources.lumaSize) }})</p>
            <canvas ref="loLumaCanvasElement" class="preview-canvas mb-4" />

            <p class="text-label-small mb-1">Lo chroma ({{ formatPlaneSize(resources.chromaSize) }})</p>
            <canvas ref="loChromaCanvasElement" class="preview-canvas" />
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="6">
        <v-card subtitle="A frame differs when one 8×8 window exceeds hi" title="High threshold">
          <v-card-text>
            <v-slider
              v-model="hiThreshold"
              hide-details
              label="hi"
              :max="16320"
              :step="64"
            >
              <template #append>
                <v-number-input
                  v-model="hiThreshold"
                  density="compact"
                  hide-details
                  :step="64"
                  width="10em"
                />
              </template>
            </v-slider>
          </v-card-text>

          <v-card-text v-if="comparison">
            <v-row density="compact">
              <v-col>
                <p :class="comparison.luma.overHi > 0 ? 'text-success' : 'text-error'">
                  Hi luma Y : {{ comparison.luma.overHi }}
                </p>
              </v-col>

              <v-col>
                <p :class="comparison.u.overHi > 0 ? 'text-success' : 'text-error'">
                  Hi chroma U : {{ comparison.u.overHi }}
                </p>
              </v-col>

              <v-col>
                <p :class="comparison.v.overHi > 0 ? 'text-success' : 'text-error'">
                  Hi chroma V : {{ comparison.v.overHi }}
                </p>
              </v-col>
            </v-row>
          </v-card-text>

          <v-card-text>
            <p class="text-label-small mb-1">Hi luma ({{ formatPlaneSize(resources.lumaSize) }})</p>
            <canvas ref="hiLumaCanvasElement" class="preview-canvas mb-4" />

            <p class="text-label-small mb-1">Hi chroma ({{ formatPlaneSize(resources.chromaSize) }})</p>
            <canvas ref="hiChromaCanvasElement" class="preview-canvas" />
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script lang="ts" setup>
  import type { WebGPUContext } from '@/stages'
  import type { VisualizeResources } from '@/VisualizeResources'
  import type {
    ChromaSubsampling,
    ComparisonResult,
    IncomingYUVFrame,
    PlaneSize,
    WrittenYUVFrame,
  } from 'interface'
  import type { WebGPUComparisonControlsService, WebGPUDiffTexturesService } from 'webgpu-impl'
  import { Effect, Fiber, Queue, Stream } from 'effect'
  import { writeYUVTextures } from 'interface'
  import { onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
  import { WebGPUComparisonControls, WebGPUDiffTextures } from 'webgpu-impl'

  const { chromaSubsampling, context, resources, video } = defineProps<{
    context: WebGPUContext
    video: HTMLVideoElement
    chromaSubsampling: ChromaSubsampling
    resources: VisualizeResources
  }>()

  const videoElement = useTemplateRef('videoElement')
  const loLumaCanvasElement = useTemplateRef('loLumaCanvasElement')
  const loChromaCanvasElement = useTemplateRef('loChromaCanvasElement')
  const hiLumaCanvasElement = useTemplateRef('hiLumaCanvasElement')
  const hiChromaCanvasElement = useTemplateRef('hiChromaCanvasElement')

  const loThreshold = ref(64 * 5)
  const hiThreshold = ref(64 * 12)
  const loFraction = ref(0.33)
  const isCurrentFrameKept = ref(true)
  const comparison = ref<ComparisonResult | null>(null)

  const videoResolution = ref('Loading…')
  const videoDuration = ref(Number.NaN)
  const playbackRate = ref(video.playbackRate)
  const currentTime = ref(video.currentTime)

  const doubleBlitShader = `
const g_positions: array<vec2<f32>, 4> = array<vec2<f32>, 4>(
  vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0),
  vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0),
);

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  var output: VertexOutput;
  let fixed_pos = g_positions[vertex_index];
  output.position = vec4<f32>(fixed_pos, 0.0, 1.0);
  output.uv = vec2<f32>((fixed_pos.x + 1.0) / 2.0, 1.0 - (fixed_pos.y + 1.0) / 2.0);
  return output;
}

@group(0) @binding(0) var src_sampler: sampler;
@group(0) @binding(1) var lo_src_texture: texture_2d<f32>;
@group(0) @binding(2) var hi_src_texture: texture_2d<f32>;

struct PixelOutput {
  @location(0) lo_output: vec4<f32>,
  @location(1) hi_output: vec4<f32>,
};

@fragment
fn ps(@location(0) uv: vec2<f32>) -> PixelOutput {
  return PixelOutput(
    textureSample(lo_src_texture, src_sampler, uv),
    textureSample(hi_src_texture, src_sampler, uv),
  );
}`

  const lumaByteLength = resources.lumaSize.width * resources.lumaSize.height
  const chromaByteLength = resources.chromaSize.width * resources.chromaSize.height
  // Predicted from plane sizes; VideoFrame.allocationSize() is unreliable for
  // YUV frames.
  const frameByteLength = lumaByteLength + 2 * chromaByteLength
  const copyBuffer = new Uint8Array(frameByteLength)
  const packedBuffer = new Uint8Array(frameByteLength)
  const frameQueue = Effect.runSync(Queue.make<IncomingYUVFrame>())

  let disposed = false
  let callbackId: number | null = null
  let pipelineFiber: Fiber.Fiber<void, unknown> | null = null
  let controls: WebGPUComparisonControlsService | null = null
  let canvasContexts: GPUCanvasContext[] = []

  onMounted(() => {
    const program = Effect.gen(function* () {
      const diffTextures = yield* WebGPUDiffTextures
      controls = yield* WebGPUComparisonControls
      const blit = yield* Effect.try({
        try: () => createBlit(diffTextures),
        catch: cause => cause instanceof Error ? cause : new Error(String(cause)),
      })
      yield* writeYUVTextures(Stream.fromQueue(frameQueue)).pipe(
        Stream.tap(frame => Effect.sync(() => {
          if (disposed) return
          onFrameProcessed(frame)
          blit()
          // The reusable buffers are safe to overwrite again only after this
          // frame's uploads were submitted, so re-arm the callback here.
          scheduleFrameCallback()
        })),
        Stream.runDrain,
      )
    }).pipe(
      Effect.provide(resources.encoderLive),
      Effect.tapCause(cause => Effect.sync(() => {
        if (!disposed) console.error('The visualization pipeline failed.', cause)
      })),
    )
    pipelineFiber = Effect.runFork(program)
    scheduleFrameCallback()
  })

  onBeforeUnmount(() => {
    disposed = true
    if (callbackId !== null) {
      videoElement.value?.cancelVideoFrameCallback(callbackId)
      callbackId = null
    }
    if (pipelineFiber) {
      // Interrupting the fiber closes the layer scope, releasing the GPU
      // resources.
      Effect.runFork(Fiber.interrupt(pipelineFiber))
      pipelineFiber = null
    }
    controls = null
    for (const canvasContext of canvasContexts) canvasContext.unconfigure()
    canvasContexts = []
  })

  function scheduleFrameCallback () {
    const element = videoElement.value
    if (disposed || !element || callbackId !== null) return
    callbackId = element.requestVideoFrameCallback(onVideoFrame)
  }

  async function onVideoFrame () {
    callbackId = null
    const element = videoElement.value
    if (disposed || !element) return

    const frame = new VideoFrame(element)
    try {
      const layouts = await frame.copyTo(copyBuffer)
      if (disposed) return
      Queue.offerUnsafe(frameQueue, packFrame(layouts))
      // The pipeline tap re-arms the callback after this frame processes.
    } catch (error) {
      // A failed copy never reaches the pipeline's tap; re-arm here so a
      // transient decode hiccup does not stall processing for good.
      scheduleFrameCallback()
      if (!disposed) console.error('Could not copy the video frame.', error)
    } finally {
      frame.close()
    }
  }

  function packFrame (layouts: readonly PlaneLayout[]): IncomingYUVFrame {
    const yLayout = layouts[0]
    if (!yLayout) throw new Error('The video frame does not contain a luminance plane.')
    packPlane(yLayout, resources.lumaSize.width, resources.lumaSize.height, 0)

    let isUVInterleaved = false
    if (layouts.length === 2) {
      const uvLayout = layouts[1]!
      isUVInterleaved = true
      packPlane(uvLayout, 2 * resources.chromaSize.width, resources.chromaSize.height, lumaByteLength)
    } else if (layouts.length === 3) {
      packPlane(layouts[1]!, resources.chromaSize.width, resources.chromaSize.height, lumaByteLength)
      packPlane(layouts[2]!, resources.chromaSize.width, resources.chromaSize.height, lumaByteLength + chromaByteLength)
    } else {
      throw new Error(`Unexpected video frame plane count: ${layouts.length}.`)
    }

    return {
      videoFrameBytes: packedBuffer,
      chromaSubsampling,
      isUVInterleaved,
      frameWidth: resources.lumaSize.width,
      frameHeight: resources.lumaSize.height,
    }
  }

  function packPlane (layout: PlaneLayout, rowByteLength: number, rowCount: number, destinationOffset: number) {
    if (layout.stride === rowByteLength) {
      packedBuffer.set(
        copyBuffer.subarray(layout.offset, layout.offset + rowByteLength * rowCount),
        destinationOffset,
      )
      return
    }
    for (let row = 0; row < rowCount; row++) {
      const rowOffset = layout.offset + row * layout.stride
      packedBuffer.set(
        copyBuffer.subarray(rowOffset, rowOffset + rowByteLength),
        destinationOffset + row * rowByteLength,
      )
    }
  }

  function onFrameProcessed (frame: WrittenYUVFrame) {
    isCurrentFrameKept.value = frame.isFrameKept
    comparison.value = frame.comparison
  }

  function createBlit (diffTextures: WebGPUDiffTexturesService) {
    const { device, queue } = context
    const format = navigator.gpu.getPreferredCanvasFormat()
    const module = device.createShaderModule({ code: doubleBlitShader })
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'ps', targets: [{ format }, { format }] },
      primitive: { topology: 'triangle-strip' },
    })
    const sampler = device.createSampler()
    const makeBindGroup = (lo: GPUTexture, hi: GPUTexture) => device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: lo.createView() },
        { binding: 2, resource: hi.createView() },
      ],
    })
    const lumaBindGroup = makeBindGroup(diffTextures.lumaLo, diffTextures.lumaHi)
    const chromaBindGroup = makeBindGroup(diffTextures.chromaLo, diffTextures.chromaHi)
    const loLumaContext = configureCanvas(loLumaCanvasElement.value, diffTextures.lumaLo, format)
    const hiLumaContext = configureCanvas(hiLumaCanvasElement.value, diffTextures.lumaHi, format)
    const loChromaContext = configureCanvas(loChromaCanvasElement.value, diffTextures.chromaLo, format)
    const hiChromaContext = configureCanvas(hiChromaCanvasElement.value, diffTextures.chromaHi, format)
    canvasContexts = [loLumaContext, hiLumaContext, loChromaContext, hiChromaContext]

    const pairs = [
      { bindGroup: lumaBindGroup, lo: loLumaContext, hi: hiLumaContext },
      { bindGroup: chromaBindGroup, lo: loChromaContext, hi: hiChromaContext },
    ]
    return () => {
      const encoder = device.createCommandEncoder()
      for (const pair of pairs) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            { view: pair.lo.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' },
            { view: pair.hi.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' },
          ],
        })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, pair.bindGroup)
        pass.draw(4)
        pass.end()
      }
      queue.submit([encoder.finish()])
    }
  }

  function configureCanvas (canvas: HTMLCanvasElement | null, texture: GPUTexture, format: GPUTextureFormat) {
    if (!canvas) throw new Error('An output canvas is unavailable.')
    canvas.width = texture.width
    canvas.height = texture.height
    const canvasContext = canvas.getContext('webgpu') as GPUCanvasContext | null
    if (!canvasContext) throw new Error('Unable to get a WebGPU canvas context.')
    canvasContext.configure({ device: context.device, format })
    return canvasContext
  }

  watch([loThreshold, hiThreshold], ([lo, hi]) => {
    const loValue = toInteger(lo)
    const hiValue = toInteger(hi)
    if (loValue === null || hiValue === null || !controls) return
    Effect.runFork(controls.setThresholds(loValue, hiValue))
  })

  watch(loFraction, fraction => {
    const value = Number(fraction)
    if (!Number.isFinite(value) || value < 0 || !controls) return
    Effect.runFork(controls.setFraction(value))
  })

  function toInteger (input: number | null | undefined): number | null {
    if (input === null || input === undefined || !Number.isFinite(input)) return null
    return Math.trunc(input)
  }

  function updateVideoInfo () {
    const element = videoElement.value
    if (!element) return

    videoResolution.value = element.videoWidth && element.videoHeight
      ? `${element.videoWidth} × ${element.videoHeight}`
      : 'Unknown'
    videoDuration.value = element.duration
    playbackRate.value = element.playbackRate
    updateCurrentTime()
  }

  function updateCurrentTime () {
    const element = videoElement.value
    if (!element) return
    currentTime.value = element.currentTime
  }

  function formatTimestamp (seconds: number) {
    if (!Number.isFinite(seconds)) return 'Unknown'

    const milliseconds = Math.round(seconds * 1000)
    const hours = Math.floor(milliseconds / 3_600_000)
    const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
    const wholeSeconds = Math.floor((milliseconds % 60_000) / 1000)
    const remainder = milliseconds % 1000
    const time = `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`
    return hours > 0 ? `${hours}:${time}` : time
  }

  function formatPlaneSize (size: PlaneSize) {
    return `${size.width} × ${size.height}`
  }
</script>

<style scoped>
.preview {
  display: block;
  width: 100%;
  max-height: 400px;
  background: #000;
}

.preview-canvas {
  display: block;
  width: 100%;
  max-height: 240px;
  background: #000;
  border-radius: 8px;
}
</style>
