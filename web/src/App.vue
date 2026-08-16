<template>
  <v-app>
    <v-app-bar>
      <v-app-bar-title v-if="!hasVideo">mpdecimate playground</v-app-bar-title>

      <v-btn
        v-else
        prepend-icon="mdi-arrow-left"
        text="Back"
        @click="goBack"
      />

      <v-spacer />

      <v-btn text="About" @click="showAbout = true" />
    </v-app-bar>

    <v-main>
      <InitializeWebGPU v-if="webgpu === null" @ready="webgpu = $event" />

      <UploadVideo
        v-else
        :key="uploadSession"
        :adapter="webgpu.adapter"
        :device="webgpu.device"
        :queue="webgpu.queue"
        @video-selected="hasVideo = true"
      />
    </v-main>

    <v-dialog v-model="showAbout" max-width="760" scrollable>
      <v-card>
        <v-card-title class="d-flex align-center">
          About mpdecimate playground

          <v-spacer />

          <v-btn
            aria-label="Close About"
            icon="mdi-close"
            variant="text"
            @click="showAbout = false"
          />
        </v-card-title>

        <v-card-text class="about-content">

          <section aria-labelledby="how-it-works">

            <p>
              FFmpeg's <code>mpdecimate</code> filter is used to remove similar consecutive frames to remove static
              moments of the video. But to use the filter you need to adjust the parameters -- lo, hi, frac -- which are
              very unintuitive therefore hard to tune especially in the CLI setup.
              This playground visualizes how the mysterious parameters plays out.
            </p>

          </section>

          <v-divider />

          <section aria-labelledby="accuracy">
            <h2 id="accuracy">How accurate is it?</h2>

            <p>
              Checked items closely reproduce FFmpeg. Unchecked items are simplified,
              browser-dependent, or not implemented.
            </p>

            <div>
              <v-checkbox-btn :model-value="true" readonly>
                <template #label>
                  <span><strong>Planar YUV:</strong> luminance (Y) and chrominance (U and V) are compared separately.</span>
                </template>
              </v-checkbox-btn>

              <v-checkbox-btn :model-value="true" readonly>
                <template #label>
                  <span><strong>Chroma subsampling:</strong> color planes use their decoded dimensions for 4:2:0, 4:2:2, or 4:4:4 video.</span>
                </template>
              </v-checkbox-btn>

              <v-checkbox-btn :model-value="true" readonly>
                <template #label>
                  <span><strong>8 × 8 SAD:</strong> each block uses the sum of absolute pixel differences on FFmpeg's 0–255 byte scale.</span>
                </template>
              </v-checkbox-btn>

              <v-checkbox-btn :model-value="true" readonly>
                <template #label>
                  <span><strong>Window traversal:</strong> windows start at <code>x = 8</code>, <code>y = 0</code>, move four pixels at a time, and exclude partial edge windows.</span>
                </template>
              </v-checkbox-btn>

              <v-checkbox-btn :model-value="true" readonly>
                <template #label>
                  <span><strong>Threshold tests:</strong> SAD uses strict <code>&gt; lo</code> and <code>&gt; hi</code> comparisons, with defaults of 320 and 768.</span>
                </template>
              </v-checkbox-btn>

              <v-checkbox-btn :model-value="true" readonly>
                <template #label>
                  <span><strong>Exact <code>frac</code> formula:</strong> each plane uses <code>trunc((width / 16) × (height / 16) × frac)</code> and the strict <code>count &gt; threshold</code> test.</span>
                </template>
              </v-checkbox-btn>

              <v-checkbox-btn :model-value="false" readonly>
                <template #label>
                  <span><strong>Reference-frame state:</strong> FFmpeg's full keep/drop history and reference-frame selection are not simulated.</span>
                </template>
              </v-checkbox-btn>

              <v-checkbox-btn :model-value="false" readonly>
                <template #label>
                  <span><strong>Identical decoding:</strong> browser pixel-format conversion, color handling, and timestamps may differ from FFmpeg.</span>
                </template>
              </v-checkbox-btn>

              <v-checkbox-btn :model-value="false" readonly>
                <template #label>
                  <span><strong>Filtered output:</strong> the app visualizes decisions but does not create a decimated video.</span>
                </template>
              </v-checkbox-btn>
            </div>
          </section>

          <v-sheet class="limitations" color="warning" rounded="lg" variant="tonal">
            <h2>
              <v-icon icon="mdi-alert-outline" size="small" />
              Limits to keep in mind
            </h2>

            <ul>
              <li>This is a learning tool. It does not create a processed video file.</li>
              <li>The keep/drop label is a simplified preview, not a frame-perfect FFmpeg prediction.</li>
              <li>Browsers may decode frames differently from FFmpeg.</li>
              <li>Some codecs, pixel formats, and very small videos are not supported.</li>
              <li>A browser with WebCodecs and WebGPU support is required.</li>
            </ul>
          </v-sheet>

          <section aria-labelledby="open-source">
            <h2 id="open-source">Open source and contact</h2>

            <p>
              This app is open source. Read the code or report a problem on
              <a
                href="https://github.com/ingun37/mpdecimate-playground"
                rel="noopener noreferrer"
                target="_blank"
              >GitHub
                <v-icon icon="mdi-open-in-new" size="x-small" />
              </a>.
            </p>

            <p>Contact: <a href="mailto:ingun37@gmail.com">ingun37@gmail.com</a></p>
          </section>
        </v-card-text>

        <v-card-actions>
          <v-spacer />
          <v-btn text="Close" @click="showAbout = false" />
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-app>
</template>

<script lang="ts" setup>
  import { ref } from 'vue'
  import InitializeWebGPU, { type WebGPUContext } from '@/components/InitializeWebGPU.vue'
  import UploadVideo from '@/components/UploadVideo.vue'

  const webgpu = ref<WebGPUContext | null>(null)
  const hasVideo = ref(false)
  const showAbout = ref(false)
  const uploadSession = ref(0)

  function goBack () {
    hasVideo.value = false
    uploadSession.value++
  }
</script>

<style scoped>
.about-content {
  display: grid;
  gap: 1.5rem;
  line-height: 1.6;
}

.about-content h2 {
  margin-bottom: 0.75rem;
  font-size: 1.2rem;
  line-height: 1.3;
}

.about-content p,
.about-content ul,
.about-content ol {
  margin-bottom: 1rem;
}

.about-content li + li {
  margin-top: 0.6rem;
}

.steps {
  padding-left: 1.4rem;
}

.accuracy-list {
  display: grid;
  gap: 0.35rem;
}

.accuracy-list :deep(.v-selection-control) {
  align-items: start;
}

.accuracy-list :deep(.v-label) {
  padding-top: 0.15rem;
  opacity: 1;
}

.limitations {
  padding: 1rem 1.25rem;
}

.limitations ul {
  margin-bottom: 0;
}
</style>
