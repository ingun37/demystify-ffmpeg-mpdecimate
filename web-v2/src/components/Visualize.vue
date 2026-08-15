<template>
  <video
    ref="videoElement"
    controls
    playsinline
    :src="video.src"
    @play="startPlaybackCallback"
  />
</template>

<script lang="ts" setup>
  import type { ChromaSubsampling } from '@/ChromaSubsampling.ts'
  import { onBeforeUnmount, ref } from 'vue'

  const { video } = defineProps<{
    adapter: GPUAdapter
    chromaSubsampling: ChromaSubsampling
    device: GPUDevice
    queue: GPUQueue
    video: HTMLVideoElement
  }>()

  const videoElement = ref<HTMLVideoElement | null>(null)
  let callbackId: number | null = null

  function startPlaybackCallback () {
    schedulePlaybackCallback()
  }

  function schedulePlaybackCallback () {
    const element = videoElement.value
    if (!element || element.paused || element.ended || callbackId !== null) return

    callbackId = element.requestVideoFrameCallback(playbackCallback)
  }

  function playbackCallback () {
    callbackId = null

    const element = videoElement.value
    if (!element || element.paused || element.ended) return

    const frame = new VideoFrame(element)
    frame.close()

    schedulePlaybackCallback()
  }

  onBeforeUnmount(() => {
    const element = videoElement.value
    if (element && callbackId !== null) element.cancelVideoFrameCallback(callbackId)
  })
</script>
