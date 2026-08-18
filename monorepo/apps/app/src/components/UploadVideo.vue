<template>
  <v-file-upload
    density="default"
    filter-by-type="video/*"
    icon="mdi-upload"
    title="Drag and drop video"
    @rejected="onRejected"
    @update:model-value="onUpload"
  />

  <v-snackbar v-model="isRejectionShown" color="error" :timeout="4000">
    Only video files are accepted.
  </v-snackbar>
</template>

<script lang="ts" setup>
  import type { UploadedVideo } from '@/stages'
  import { ref } from 'vue'

  const emit = defineEmits<{
    selected: [video: UploadedVideo]
  }>()

  const isRejectionShown = ref(false)

  function onUpload (files: File[] | File) {
    const file = Array.isArray(files) ? files[0] : files
    if (!file) return

    const element = document.createElement('video')
    element.preload = 'auto'
    const objectUrl = URL.createObjectURL(file)
    element.src = objectUrl
    element.load()
    emit('selected', { element, objectUrl })
  }

  function onRejected () {
    isRejectionShown.value = true
  }
</script>
