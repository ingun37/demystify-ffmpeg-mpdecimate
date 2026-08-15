<template>
  <v-app>
    <v-main>
      <InitializeWebGPU v-if="webgpu === null" @ready="webgpu = $event" />

      <UploadVideo
        v-else
        :adapter="webgpu.adapter"
        :device="webgpu.device"
        :queue="webgpu.queue"
      />
    </v-main>
  </v-app>
</template>

<script lang="ts" setup>
  import { ref } from 'vue'
  import InitializeWebGPU, { type WebGPUContext } from '@/components/InitializeWebGPU.vue'
  import UploadVideo from '@/components/UploadVideo.vue'

  const webgpu = ref<WebGPUContext | null>(null)
</script>
