<template>
  <v-app>
    <v-app-bar>
      <template #prepend>
        <v-btn
          v-if="hasVideo"
          icon="mdi-arrow-left"
          @click="backToUpload"
        />
      </template>

      <v-app-bar-title>Demystify FFmpeg mpdecimate</v-app-bar-title>

      <template #append>
        <v-btn text="About" @click="isAboutOpen = true" />
        <v-btn icon="mdi-theme-light-dark" @click="theme.cycle()" />
      </template>
    </v-app-bar>

    <v-main>
      <v-container class="fill-height" fluid>
        <InitializeWebGPU
          v-if="stage.name === 'initialize-webgpu'"
          @ready="onWebGPUReady"
        />

        <UploadVideo
          v-else-if="stage.name === 'upload-video'"
          @selected="onVideoSelected"
        />

        <DetectChromaSubsampling
          v-else-if="stage.name === 'detect-chroma-subsampling'"
          :video="stage.video.element"
          @detected="onChromaSubsamplingDetected"
          @discard="backToUpload"
        />

        <PrepareVisualize
          v-else-if="stage.name === 'prepare-visualize'"
          :chroma-subsampling="stage.chromaSubsampling"
          :context="stage.context"
          :video="stage.video.element"
          @discard="backToUpload"
          @ready="onResourcesReady"
        />

        <Visualize
          v-else
          :chroma-subsampling="stage.chromaSubsampling"
          :context="stage.context"
          :resources="stage.resources"
          :video="stage.video.element"
        />
      </v-container>
    </v-main>

    <AboutDialog v-model="isAboutOpen" />
  </v-app>
</template>

<script lang="ts" setup>
  import type { Stage, UploadedVideo, WebGPUContext } from '@/stages'
  import type { VisualizeResources } from '@/VisualizeResources'
  import type { ChromaSubsampling } from 'interface'
  import { computed, ref } from 'vue'
  import { useTheme } from 'vuetify'
  import AboutDialog from '@/components/AboutDialog.vue'
  import DetectChromaSubsampling from '@/components/DetectChromaSubsampling.vue'
  import InitializeWebGPU from '@/components/InitializeWebGPU.vue'
  import PrepareVisualize from '@/components/PrepareVisualize.vue'
  import UploadVideo from '@/components/UploadVideo.vue'
  import Visualize from '@/components/Visualize.vue'

  const theme = useTheme()
  const stage = ref<Stage>({ name: 'initialize-webgpu' })
  const isAboutOpen = ref(false)
  const hasVideo = computed(() => 'video' in stage.value)

  function onWebGPUReady (context: WebGPUContext) {
    stage.value = { name: 'upload-video', context }
  }

  function onVideoSelected (video: UploadedVideo) {
    if (stage.value.name !== 'upload-video') return
    stage.value = { name: 'detect-chroma-subsampling', context: stage.value.context, video }
  }

  function onChromaSubsamplingDetected (chromaSubsampling: ChromaSubsampling) {
    if (stage.value.name !== 'detect-chroma-subsampling') return
    stage.value = { ...stage.value, name: 'prepare-visualize', chromaSubsampling }
  }

  function onResourcesReady (resources: VisualizeResources) {
    if (stage.value.name !== 'prepare-visualize') return
    stage.value = { ...stage.value, name: 'visualize', resources }
  }

  function backToUpload () {
    if (!('video' in stage.value)) return

    releaseVideo(stage.value.video)
    stage.value = { name: 'upload-video', context: stage.value.context }
  }

  function releaseVideo (video: UploadedVideo) {
    video.element.pause()
    video.element.removeAttribute('src')
    video.element.load()
    URL.revokeObjectURL(video.objectUrl)
  }
</script>
