<template>
  <v-dialog v-model="isOpen" max-width="480">
    <v-card title="About">
      <v-card-text>
        <p class="mb-4">
          This app visualizes how FFmpeg's
          <a
            href="https://ffmpeg.org/ffmpeg-filters.html#mpdecimate"
            rel="noopener"
            target="_blank"
          >mpdecimate filter</a>

          works. Upload a video and watch how the mysterious, unintuitive <code class="font-weight-bold">hi</code>,
          <code class="font-weight-bold">lo</code>,
          and <code class="font-weight-bold">frac</code> parameters
          play out in deciding whether each frame is kept or
          dropped.
        </p>

        <p class="text-title-medium mb-1">How accurate is it?</p>

        <p class="mb-4">
          The frame comparison is a faithful re-implementation of mpdecimate's
          algorithm, and it's
          verified against FFmpeg's actual mpdecimate output on every frame of hundreds of videos in automated
          integration tests. So it should be pretty accurate.
        </p>

        <p class="text-title-medium mb-1">Contact &amp; contributing</p>

        <p>
          Questions or feedback? Email the developer at
          <a href="mailto:ingun37@gmail.com">ingun37@gmail.com</a>.
          The source code is on
          <a
            href="https://github.com/ingun37/mpdecimate-playground"
            rel="noopener"
            target="_blank"
          >GitHub</a>
          — issues and pull requests are welcome.
        </p>

        <p class="text-title-medium mb-1">Security</p>

        <p class="mb-4">
          The comparison runs entirely in your browser on the GPU via
          WebGPU — no data leaves your machine.
        </p>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn text="Close" @click="isOpen = false" />
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts" setup>
  const isOpen = defineModel<boolean>({ required: true })
</script>
