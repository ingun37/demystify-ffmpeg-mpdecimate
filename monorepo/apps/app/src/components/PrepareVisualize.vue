<template>
  <v-empty-state
    v-if="error"
    icon="mdi-alert-circle-outline"
    :text="error"
    title="Could not prepare resources"
  >
    <template #actions>
      <v-btn
        color="primary"
        prepend-icon="mdi-arrow-left"
        text="Choose another video"
        @click="emit('discard')"
      />
    </template>
  </v-empty-state>

  <v-empty-state v-else title="Preparing visualization resources…">
    <template #media>
      <v-progress-circular class="mb-4" indeterminate size="48" />
    </template>
  </v-empty-state>
</template>

<script lang="ts" setup>
  import type { WebGPUContext } from '@/stages'
  import type { VisualizeResources } from '@/VisualizeResources'
  import type { ChromaSubsampling } from 'interface'
  import { onMounted, ref } from 'vue'
  import { createMockVisualizeResources } from '@/VisualizeResources'

  const { chromaSubsampling, video } = defineProps<{
    context: WebGPUContext
    video: HTMLVideoElement
    chromaSubsampling: ChromaSubsampling
  }>()

  const emit = defineEmits<{
    ready: [resources: VisualizeResources]
    discard: []
  }>()

  const error = ref<string | null>(null)

  onMounted(() => {
    try {
      // TODO: replace the mock with webgpu-impl's makeWebGPULayer(context.device, …).
      const lumaSize = { width: video.videoWidth, height: video.videoHeight }
      emit('ready', createMockVisualizeResources(lumaSize, chromaSubsampling))
    } catch (error_) {
      error.value = error_ instanceof Error ? error_.message : 'Unable to create visualization resources.'
    }
  })
</script>
