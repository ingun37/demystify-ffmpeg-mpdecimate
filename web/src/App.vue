<template>
  <v-app>
    <v-app-bar>
      <v-app-bar-title v-if="!hasVideo">mpdecimate playground</v-app-bar-title>

      <v-btn
        v-else
        prepend-icon="mdi-arrow-left"
        text="Back"
        @click="goBack"
      />
    </v-app-bar>

    <v-main>
      <InitializeWebGPU v-if="webgpu === null" @ready="webgpu = $event" />

      <UploadVideo
        v-else
        :key="uploadSession"
        :adapter="webgpu.adapter"
        :device="webgpu.device"
        :queue="webgpu.queue"
        @video-selected="hasVideo = true"
      />
    </v-main>
  </v-app>
</template>

<script lang="ts" setup>
  import { ref } from 'vue'
  import InitializeWebGPU, { type WebGPUContext } from '@/components/InitializeWebGPU.vue'
  import UploadVideo from '@/components/UploadVideo.vue'

  const webgpu = ref<WebGPUContext | null>(null)
  const hasVideo = ref(false)
  const uploadSession = ref(0)

  function goBack () {
    hasVideo.value = false
    uploadSession.value++
  }
</script>
