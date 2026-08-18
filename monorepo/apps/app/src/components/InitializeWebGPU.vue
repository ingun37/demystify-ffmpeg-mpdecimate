<template>
  <v-empty-state
    v-if="error"
    icon="mdi-alert-circle-outline"
    :text="error"
    title="WebGPU is unavailable"
  />

  <v-empty-state v-else title="Initializing WebGPU…">
    <template #media>
      <v-progress-circular class="mb-4" indeterminate size="48" />
    </template>
  </v-empty-state>
</template>

<script lang="ts" setup>
  import type { WebGPUContext } from '@/stages'
  import { onMounted, ref } from 'vue'

  const emit = defineEmits<{
    ready: [context: WebGPUContext]
  }>()

  const error = ref<string | null>(null)

  onMounted(async () => {
    if (!navigator.gpu) {
      error.value = 'WebGPU is not supported by this browser.'
      return
    }

    const adapter = await navigator.gpu.requestAdapter()
    if (adapter === null) {
      error.value = 'No compatible WebGPU adapter is available.'
      return
    }

    const device = await adapter.requestDevice()
    emit('ready', { adapter, device, queue: device.queue })
  })
</script>
