<template>
  <input v-if="video === null" accept="video/*" type="file" @change="uploadVideo">

  <DetectChromaSubsampling
    v-else
    :adapter="adapter"
    :device="device"
    :queue="queue"
    :video="video"
  />
</template>

<script lang="ts" setup>
  import { ref } from 'vue'
  import DetectChromaSubsampling from '@/components/DetectChromaSubsampling.vue'

  const { adapter, device, queue } = defineProps<{
    adapter: GPUAdapter
    device: GPUDevice
    queue: GPUQueue
  }>()

  const video = ref<HTMLVideoElement | null>(null)

  function uploadVideo (event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0]
    if (!file) return

    const element = document.createElement('video')
    element.preload = 'auto'
    element.src = URL.createObjectURL(file)
    element.load()
    video.value = element
  }
</script>
