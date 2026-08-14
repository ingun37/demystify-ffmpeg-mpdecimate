<template>
  <v-app>
    <v-main class="app-shell">
      <v-container class="py-12" max-width="760">
        <div class="d-flex align-center mb-8">
          <v-icon class="mr-3" color="primary" icon="mdi-video-outline" size="36" />

          <div>
            <h1 class="text-h4 font-weight-bold">Video frame sampler</h1>
            <p class="text-medium-emphasis mb-0">Choose an MP4 and play it to capture each displayed frame.</p>
          </div>
        </div>

        <VideoSampler v-if="context" :context="context" />

        <div v-else class="text-center text-medium-emphasis py-10">
          <v-progress-circular color="primary" indeterminate size="48" />
          <p class="mt-3 mb-0">Initializing WebGPU…</p>
        </div>
      </v-container>
    </v-main>

    <v-btn
      class="ma-2"
      icon="mdi-theme-light-dark"
      location="top right"
      position="absolute"
      @click="$vuetify.theme.cycle()"
    />
  </v-app>
</template>

<script lang="ts" setup>
  import { type Context, create_context } from 'rust'
  import { onBeforeUnmount, shallowRef } from 'vue'
  import VideoSampler from '@/components/VideoSampler.vue'

  const context = shallowRef<Context | null>(null)

  create_context().then(created => {
    context.value = created
  })

  onBeforeUnmount(() => {
    context.value?.free()
  })
</script>

<style scoped>
.app-shell {
  min-height: 100vh;
  background: rgb(var(--v-theme-surface));
}
</style>
