<template>
  <v-container>
    <v-row>
      <v-col cols="12">
        <video
          ref="videoElement"
          class="preview"
          controls
          playsinline
          :src="video.src"
          @play="startPlaybackCallback"
        />
      </v-col>

      <v-col>

        <v-slider
          v-model="loThreshold"
          class="ma-0"
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
          v-model="loFrac"
          class="ma-0"
          hide-details
          label="frac"
          :max="1"
          :step="0.01"
        >
          <template #append>
            <v-number-input
              v-model="loFrac"
              density="compact"
              hide-details
              :precision="2"
              :step="0.01"
              width="10em"
            />
          </template>
        </v-slider>

        <v-container class="pa-0" fluid>
          <v-row density="compact">
            <v-col>
              <p>Lo luma Y : {{ loLumaNonzeroCount }}</p>
            </v-col>

            <v-col>
              <p>Lo chroma U : {{ chromaLoNonzeroCounts.g }}</p>
            </v-col>

            <v-col>
              <p>Lo chroma V : {{ chromaLoNonzeroCounts.b }}</p>
            </v-col>
          </v-row>
        </v-container>

        <canvas
          ref="loCanvasElement"
          class="preview-canvas"
        />

        <canvas
          ref="chromaLoCanvasElement"
          class="preview-canvas"
        />
      </v-col>

      <v-col>

        <v-slider
          v-model="hiThreshold"
          class="ma-0"
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

        <v-container class="pa-0" fluid>
          <v-row density="compact">
            <v-col>
              <p>Hi luma Y : {{ hiLumaNonzeroCount }}</p>
            </v-col>

            <v-col>
              <p>Hi chroma U : {{ chromaHiNonzeroCounts.g }}</p>
            </v-col>

            <v-col>
              <p>Hi chroma V : {{ chromaHiNonzeroCounts.b }}</p>
            </v-col>
          </v-row>
        </v-container>

        <canvas
          ref="hiCanvasElement"
          class="preview-canvas"
        />

        <canvas
          ref="chromaHiCanvasElement"
          class="preview-canvas"
        />
      </v-col>
    </v-row>
  </v-container>

</template>

<script lang="ts" setup>
  import type { ChromaSubsampling } from '@/ChromaSubsampling.ts'
  import type { VisualizeResources } from '@/VisualizeResources.ts'
  import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

  const { device, queue, resources, video } = defineProps<{
    adapter: GPUAdapter
    chromaSubsampling: ChromaSubsampling
    device: GPUDevice
    queue: GPUQueue
    resources: VisualizeResources
    video: HTMLVideoElement
  }>()

  const videoElement = ref<HTMLVideoElement | null>(null)
  const loCanvasElement = ref<HTMLCanvasElement | null>(null)
  const hiCanvasElement = ref<HTMLCanvasElement | null>(null)
  const chromaLoCanvasElement = ref<HTMLCanvasElement | null>(null)
  const chromaHiCanvasElement = ref<HTMLCanvasElement | null>(null)
  const loThreshold = ref(64 * 5)
  watch(loThreshold, lo => {
    updateThreshold(lo, resources.loThresholdBuffer, 'lo')
  })
  const loFrac = ref(0.33)
  const hiThreshold = ref(64 * 12)
  watch(hiThreshold, hi => {
    updateThreshold(hi, resources.hiThresholdBuffer, 'hi')
  })
  const loLumaNonzeroCount = ref(0)
  const hiLumaNonzeroCount = ref(0)
  const chromaLoNonzeroCounts = ref({ g: 0, b: 0 })
  const chromaHiNonzeroCounts = ref({ g: 0, b: 0 })
  let callbackId: number | null = null
  let textureArrayIndex = 0
  let loCanvasContext: GPUCanvasContext | null = null
  let hiCanvasContext: GPUCanvasContext | null = null
  let chromaLoCanvasContext: GPUCanvasContext | null = null
  let chromaHiCanvasContext: GPUCanvasContext | null = null

  onMounted(() => {
    const format = navigator.gpu.getPreferredCanvasFormat()
    loCanvasContext = configureCanvas(loCanvasElement.value, resources.loOutTexture, format)
    hiCanvasContext = configureCanvas(hiCanvasElement.value, resources.hiOutTexture, format)
    chromaLoCanvasContext = configureCanvas(chromaLoCanvasElement.value, resources.chromaLoOutTexture, format)
    chromaHiCanvasContext = configureCanvas(chromaHiCanvasElement.value, resources.chromaHiOutTexture, format)
  })

  function startPlaybackCallback () {
    schedulePlaybackCallback()
  }

  function updateThreshold (input: string | number | null, buffer: GPUBuffer, threshold: 'lo' | 'hi') {
    if (input === null || input === '') return

    const value = Number(input)
    if (!Number.isFinite(value)) return

    const integerValue = Math.trunc(value)
    if (threshold === 'lo') loThreshold.value = integerValue
    else hiThreshold.value = integerValue
    queue.writeBuffer(buffer, 0, new Int32Array([integerValue]))
  }

  function schedulePlaybackCallback () {
    const element = videoElement.value
    if (!element || element.paused || element.ended || callbackId !== null) return

    callbackId = element.requestVideoFrameCallback(playbackCallback)
  }

  async function playbackCallback () {
    callbackId = null

    const element = videoElement.value
    if (!element || element.paused || element.ended) return

    const frame = new VideoFrame(element)
    try {
      const planeLayouts = await frame.copyTo(resources.frameData)
      const yPlaneLayout = planeLayouts[0]
      if (!yPlaneLayout) throw new Error('The video frame does not contain a luminance plane.')

      const lumaWidth = resources.yTexture.width
      const lumaHeight = resources.yTexture.height
      queue.writeBuffer(
        resources.yBuffer,
        0,
        resources.frameData,
        yPlaneLayout.offset,
        lumaWidth * lumaHeight,
      )
      queue.writeBuffer(resources.layerIndexBuffer, 0, new Uint32Array([textureArrayIndex]))

      const commandEncoder = device.createCommandEncoder()
      const yComputePass = commandEncoder.beginComputePass()
      yComputePass.setPipeline(resources.yMapPipeline)
      yComputePass.setBindGroup(0, resources.yMapBindGroup)
      const [yWorkgroupWidth, yWorkgroupHeight] = resources.yMapWorkgroupSize
      yComputePass.dispatchWorkgroups(
        Math.ceil(lumaWidth / yWorkgroupWidth),
        Math.ceil(lumaHeight / yWorkgroupHeight),
      )
      yComputePass.end()

      if (planeLayouts.length === 2) {
        const uvPlaneLayout = planeLayouts[1]
        if (!uvPlaneLayout) throw new Error('The video frame does not contain a chroma plane.')

        const chromaWidth = resources.uTexture.width
        const chromaHeight = resources.uTexture.height
        const chromaByteLength = chromaWidth * chromaHeight
        queue.writeBuffer(
          resources.uvCombinedBuffer,
          0,
          resources.frameData,
          uvPlaneLayout.offset,
          2 * chromaByteLength,
        )
        const computePass = commandEncoder.beginComputePass()
        computePass.setPipeline(resources.uvDeinterleavePipeline)
        computePass.setBindGroup(0, resources.uvDeinterleaveBindGroup)
        const [uvWorkgroupWidth, uvWorkgroupHeight] = resources.uvDeinterleaveWorkgroupSize
        computePass.dispatchWorkgroups(
          Math.ceil(chromaWidth / uvWorkgroupWidth),
          Math.ceil(chromaHeight / uvWorkgroupHeight),
        )
        computePass.end()
      } else if (planeLayouts.length === 3) {
        const uPlaneLayout = planeLayouts[1]
        const vPlaneLayout = planeLayouts[2]
        if (!uPlaneLayout || !vPlaneLayout) {
          throw new Error('The video frame does not contain both chroma planes.')
        }

        const chromaWidth = resources.uTexture.width
        const chromaHeight = resources.uTexture.height
        const chromaByteLength = chromaWidth * chromaHeight
        queue.writeBuffer(
          resources.uBuffer,
          0,
          resources.frameData,
          uPlaneLayout.offset,
          chromaByteLength,
        )
        queue.writeBuffer(
          resources.vBuffer,
          0,
          resources.frameData,
          vPlaneLayout.offset,
          chromaByteLength,
        )

        const [chromaWorkgroupWidth, chromaWorkgroupHeight] = resources.yMapWorkgroupSize
        for (const bindGroup of [resources.uMapBindGroup, resources.vMapBindGroup]) {
          const computePass = commandEncoder.beginComputePass()
          computePass.setPipeline(resources.yMapPipeline)
          computePass.setBindGroup(0, bindGroup)
          computePass.dispatchWorkgroups(
            Math.ceil(chromaWidth / chromaWorkgroupWidth),
            Math.ceil(chromaHeight / chromaWorkgroupHeight),
          )
          computePass.end()
        }
      }

      const sadThresholdPass = commandEncoder.beginComputePass()
      sadThresholdPass.setPipeline(resources.sadThresholdPipeline)
      sadThresholdPass.setBindGroup(0, resources.sadThresholdBindGroup)
      const [sadThresholdWorkgroupWidth, sadThresholdWorkgroupHeight] = resources.sadThresholdWorkgroupSize
      sadThresholdPass.dispatchWorkgroups(
        Math.ceil(resources.loOutTexture.width / sadThresholdWorkgroupWidth),
        Math.ceil(resources.loOutTexture.height / sadThresholdWorkgroupHeight),
      )
      sadThresholdPass.end()

      const chromaSadThresholdPass = commandEncoder.beginComputePass()
      chromaSadThresholdPass.setPipeline(resources.chromaSadThresholdPipeline)
      chromaSadThresholdPass.setBindGroup(0, resources.chromaSadThresholdBindGroup)
      const [chromaSadThresholdWorkgroupWidth, chromaSadThresholdWorkgroupHeight] = resources.chromaSadThresholdWorkgroupSize
      chromaSadThresholdPass.dispatchWorkgroups(
        Math.ceil(resources.chromaLoOutTexture.width / chromaSadThresholdWorkgroupWidth),
        Math.ceil(resources.chromaLoOutTexture.height / chromaSadThresholdWorkgroupHeight),
      )
      chromaSadThresholdPass.end()

      const countTargets = [
        {
          texture: resources.loOutTexture,
          bindGroup: resources.loNonzeroCountBindGroup,
          countBuffer: resources.loNonzeroCountBuffer,
          readBuffer: resources.loNonzeroCountReadBuffer,
        },
        {
          texture: resources.hiOutTexture,
          bindGroup: resources.hiNonzeroCountBindGroup,
          countBuffer: resources.hiNonzeroCountBuffer,
          readBuffer: resources.hiNonzeroCountReadBuffer,
        },
        {
          texture: resources.chromaLoOutTexture,
          bindGroup: resources.chromaLoNonzeroCountBindGroup,
          countBuffer: resources.chromaLoNonzeroCountBuffer,
          readBuffer: resources.chromaLoNonzeroCountReadBuffer,
        },
        {
          texture: resources.chromaHiOutTexture,
          bindGroup: resources.chromaHiNonzeroCountBindGroup,
          countBuffer: resources.chromaHiNonzeroCountBuffer,
          readBuffer: resources.chromaHiNonzeroCountReadBuffer,
        },
      ]
      const [countWorkgroupWidth, countWorkgroupHeight] = resources.nonzeroCountWorkgroupSize
      for (const target of countTargets) {
        commandEncoder.clearBuffer(target.countBuffer)
        const countPass = commandEncoder.beginComputePass()
        countPass.setPipeline(resources.nonzeroCountPipeline)
        countPass.setBindGroup(0, target.bindGroup)
        countPass.dispatchWorkgroups(
          Math.ceil(target.texture.width / countWorkgroupWidth),
          Math.ceil(target.texture.height / countWorkgroupHeight),
        )
        countPass.end()
        commandEncoder.copyBufferToBuffer(target.countBuffer, 0, target.readBuffer, 0, 16)
      }

      if (loCanvasContext && hiCanvasContext) {
        const doubleBlitPass = commandEncoder.beginRenderPass({
          colorAttachments: [
            { view: loCanvasContext.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' },
            { view: hiCanvasContext.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' },
          ],
        })
        doubleBlitPass.setPipeline(resources.doubleBlitPipeline)
        doubleBlitPass.setBindGroup(0, resources.doubleBlitBindGroup)
        doubleBlitPass.draw(4)
        doubleBlitPass.end()
      }

      if (chromaLoCanvasContext && chromaHiCanvasContext) {
        const chromaDoubleBlitPass = commandEncoder.beginRenderPass({
          colorAttachments: [
            { view: chromaLoCanvasContext.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' },
            { view: chromaHiCanvasContext.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' },
          ],
        })
        chromaDoubleBlitPass.setPipeline(resources.doubleBlitPipeline)
        chromaDoubleBlitPass.setBindGroup(0, resources.chromaDoubleBlitBindGroup)
        chromaDoubleBlitPass.draw(4)
        chromaDoubleBlitPass.end()
      }

      queue.submit([commandEncoder.finish()])

      const [loCounts, hiCounts, chromaLoCounts, chromaHiCounts] = await Promise.all(
        countTargets.map(target => readNonzeroCounts(target.readBuffer)),
      )
      loLumaNonzeroCount.value = loCounts[0] ?? 0
      hiLumaNonzeroCount.value = hiCounts[0] ?? 0
      chromaLoNonzeroCounts.value = { g: chromaLoCounts[1] ?? 0, b: chromaLoCounts[2] ?? 0 }
      chromaHiNonzeroCounts.value = { g: chromaHiCounts[1] ?? 0, b: chromaHiCounts[2] ?? 0 }

      textureArrayIndex = (textureArrayIndex + 1) % resources.textureArrayLength
    } finally {
      frame.close()
    }

    schedulePlaybackCallback()
  }

  onBeforeUnmount(() => {
    const element = videoElement.value
    if (element && callbackId !== null) element.cancelVideoFrameCallback(callbackId)
  })

  function configureCanvas (canvas: HTMLCanvasElement | null, texture: GPUTexture, format: GPUTextureFormat) {
    if (!canvas) throw new Error('The output canvas is unavailable.')
    canvas.width = texture.width
    canvas.height = texture.height
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null
    if (!context) throw new Error('Unable to get a WebGPU canvas context.')
    context.configure({ device, format })
    return context
  }

  async function readNonzeroCounts (buffer: GPUBuffer) {
    await buffer.mapAsync(0x01) // MAP_READ
    const counts = new Uint32Array(buffer.getMappedRange()).slice()
    buffer.unmap()
    return counts
  }
</script>

<style scoped>
.preview {
  display: block;
  width: 100%;
  max-height: 400px;
  background: #000;
  border-radius: 8px;
}

.preview-canvas {
  display: block;
  max-height: 400px;
  background: #000;
  border-radius: 8px;
}

.threshold-controls {
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
}

.pixel-counts p {
  margin: 0;
}

</style>
