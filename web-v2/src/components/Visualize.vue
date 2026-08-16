<template>
  <video
    ref="videoElement"
    controls
    playsinline
    :src="video.src"
    @play="startPlaybackCallback"
  />

  <canvas ref="loCanvasElement" />
  <canvas ref="hiCanvasElement" />
</template>

<script lang="ts" setup>
  import type { ChromaSubsampling } from '@/ChromaSubsampling.ts'
  import type { VisualizeResources } from '@/VisualizeResources.ts'
  import { onBeforeUnmount, onMounted, ref } from 'vue'

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
  let callbackId: number | null = null
  let textureArrayIndex = 0
  let loCanvasContext: GPUCanvasContext | null = null
  let hiCanvasContext: GPUCanvasContext | null = null

  onMounted(() => {
    const format = navigator.gpu.getPreferredCanvasFormat()
    loCanvasContext = configureCanvas(loCanvasElement.value, format)
    hiCanvasContext = configureCanvas(hiCanvasElement.value, format)
  })

  function startPlaybackCallback () {
    schedulePlaybackCallback()
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

      queue.submit([commandEncoder.finish()])

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

  function configureCanvas (canvas: HTMLCanvasElement | null, format: GPUTextureFormat) {
    if (!canvas) throw new Error('The output canvas is unavailable.')
    canvas.width = resources.loOutTexture.width
    canvas.height = resources.loOutTexture.height
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null
    if (!context) throw new Error('Unable to get a WebGPU canvas context.')
    context.configure({ device, format })
    return context
  }
</script>
