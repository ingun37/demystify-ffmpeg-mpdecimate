<template></template>

<script lang="ts" setup>
  defineProps<{
    adapter: GPUAdapter
    device: GPUDevice
    queue: GPUQueue
  }>()
</script>
