<template>
  <v-file-upload
    v-if="video === null"
    density="default"
    filter-by-type="video/*"
    icon="mdi-upload"
    title="Drag and drop video"
    @update:model-value="onUpload"
  />

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

  function onUpload (files: File[] | File) {
    const file = Array.isArray(files) ? files[0] : files
    if (!file) return
    const element = document.createElement('video')
    element.preload = 'auto'
    element.src = URL.createObjectURL(file)
    element.load()
    video.value = element
  }

</script>
