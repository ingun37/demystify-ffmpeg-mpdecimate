<template>
  <div>
    <template v-if="error">{{ error }}</template>
    <template v-else>Initializing WebGPU…</template>
  </div>
</template>

<script lang="ts" setup>
  import { onMounted, ref } from 'vue'

  export interface WebGPUContext {
    adapter: GPUAdapter
    device: GPUDevice
    queue: GPUQueue
  }

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
