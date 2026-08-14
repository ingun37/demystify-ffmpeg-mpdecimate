<template>
  <v-row>
    <v-col cols="12" lg="4" md="5">
      <v-card elevation="3" rounded="lg">
        <v-card-title class="text-subtitle-1">Source</v-card-title>

        <v-card-text>
          <v-file-input
            accept="video/mp4,.mp4"
            clearable
            density="comfortable"
            label="MP4 video"
            prepend-icon="mdi-file-video-outline"
            variant="outlined"
            @update:model-value="loadVideo"
          />

          <v-slider
            v-model="frameCount"
            class="mt-4"
            color="primary"
            hide-details
            label="Frames to process"
            :max="12"
            :min="2"
            :step="1"
            thumb-label="always"
          />
        </v-card-text>
      </v-card>

      <v-card class="mt-4" elevation="3" rounded="lg">
        <v-card-title class="text-subtitle-1">Preview</v-card-title>

        <v-card-text>
          <video
            v-if="videoUrl"
            ref="videoElement"
            class="video-preview"
            controls
            :src="videoUrl"
            @loadedmetadata="videoReady = true"
          />

          <div v-else class="empty-state text-center text-medium-emphasis py-10">
            <v-icon icon="mdi-movie-open-outline" size="48" />
            <p class="mt-3 mb-0">Your video preview will appear here.</p>
          </div>
        </v-card-text>
      </v-card>
    </v-col>

    <v-col cols="12" lg="8" md="7">
      <FrameGrid
        v-if="videoUrl && videoReady && videoElement"
        :key="`${videoUrl}-${frameCount}`"
        :context="context"
        :frame-count="frameCount"
        :video="videoElement"
      />

      <v-card
        v-else
        class="fill-height d-flex align-center justify-center"
        elevation="3"
        min-height="320"
        rounded="lg"
      >
        <div class="text-center text-medium-emphasis pa-10">
          <v-icon icon="mdi-grid" size="48" />
          <p class="mt-3 mb-0">The mpdecimate analysis and captured frames will appear here.</p>
        </div>
      </v-card>
    </v-col>
  </v-row>
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
