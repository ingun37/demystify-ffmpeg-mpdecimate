<template>
  <v-card class="pa-6" elevation="3" rounded="lg">
    <v-slider
      v-model="frameCount"
      class="mb-4"
      color="primary"
      hide-details
      label="Frames to process"
      :max="12"
      :min="2"
      :step="1"
      thumb-label="always"
    />

    <v-file-input
      accept="video/mp4,.mp4"
      clearable
      label="MP4 video"
      prepend-icon="mdi-file-video-outline"
      variant="outlined"
      @update:model-value="loadVideo"
    />

    <template v-if="videoUrl">
      <video
        ref="videoElement"
        class="video-preview mb-5"
        controls
        :src="videoUrl"
        @loadedmetadata="videoReady = true"
      />

      <FrameGrid
        v-if="videoReady && videoElement"
        :key="`${videoUrl}-${frameCount}`"
        class="mt-5"
        :context="context"
        :frame-count="frameCount"
        :video="videoElement"
      />
    </template>

    <div v-else class="empty-state text-center text-medium-emphasis py-10">
      <v-icon icon="mdi-movie-open-outline" size="48" />
      <p class="mt-3 mb-0">Your video preview and timeline will appear here.</p>
    </div>
  </v-card>
</template>

<script lang="ts" setup>
  import type { Context } from 'rust'
  import { onBeforeUnmount, ref } from 'vue'
  import FrameGrid from '@/components/FrameGrid.vue'

  const { context } = defineProps<{ context: Context }>()

  const videoElement = ref<HTMLVideoElement | null>(null)
  const videoUrl = ref('')
  const videoReady = ref(false)
  const frameCount = ref(2)

  function loadVideo (value: File | File[] | null) {
    const file = Array.isArray(value) ? value[0] : value

    if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)

    videoUrl.value = file ? URL.createObjectURL(file) : ''
    videoReady.value = false
  }

  onBeforeUnmount(() => {
    if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
  })
</script>

<style scoped>
.video-preview {
  display: block;
  width: 100%;
  max-height: 400px;
  background: #000;
  border-radius: 8px;
}

.empty-state {
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.25);
  border-radius: 8px;
}
</style>
