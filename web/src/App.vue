<template>
  <v-app>
    <v-app-bar density="comfortable" flat>
      <template #prepend>
        <v-icon color="primary" icon="mdi-video-outline" size="28" />
      </template>

      <v-app-bar-title>
        <span class="font-weight-bold">Video frame sampler</span>

        <span class="text-medium-emphasis text-body-2 ml-3 d-none d-sm-inline">
          Choose an MP4 and play it to capture each displayed frame.
        </span>
      </v-app-bar-title>

      <template #append>
        <v-btn icon="mdi-theme-light-dark" @click="$vuetify.theme.cycle()" />
      </template>
    </v-app-bar>

    <v-main class="app-shell">
      <v-container class="py-6" fluid>
        <VideoSampler v-if="context" :context="context" />

        <div v-else class="text-center text-medium-emphasis py-10">
          <v-progress-circular color="primary" indeterminate size="48" />
          <p class="mt-3 mb-0">Initializing WebGPU…</p>
        </div>
      </v-container>
    </v-main>
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
