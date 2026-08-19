# Project Rules

## Stack

- Framework: Vue 3 + Vite
- UI Library: Vuetify
- Enabled Features: ESLint

## General

- This is a Rush monorepo project: use `rushx` for scripts (`rushx dev`, `rushx type-check`, `rushx lint`), `rush add`
  for dependencies. Never call npm/pnpm directly.
- `effect` is pinned to the same version as the libs (`4.0.0-rc.110`). `interface` and `webgpu-impl` are
  `workspace:*` dependencies.

# Plan: wire `webgpu-impl` into the visualize stage

## Where things stand

The app is a linear stage machine (`src/stages.ts`): initialize WebGPU → upload video → detect chroma subsampling →
prepare resources → visualize. Everything up to and including stage transitions works. Two seams are waiting:

- `src/VisualizeResources.ts` builds a **mock** `encoderLive` layer that keeps every frame.
  `PrepareVisualize.vue` calls `createMockVisualizeResources`.
- `src/components/Visualize.vue` renders the full UI (video, lo/hi/frac controls, four canvases, kept/dropped chip)
  but has a `TODO` where the pipeline should run. Nothing processes frames yet.

## What `webgpu-impl` and `interface` provide today

- `WebGPUDiffTextures.layer(device, queue, options)` returns a `Layer` providing **three** services from one
  scoped set of GPU resources:
  - `YUVTextureCommandEncoder` (from `interface`) — what `writeYUVTextures` needs.
  - `WebGPUComparisonControls` — live lo/hi/frac updates (see its section below).
  - `WebGPUDiffTextures` — the four intermediate SAD textures for visualization: `lumaLo`, `lumaHi`, `chromaLo`,
    `chromaHi`. All are `rgba8unorm` with `TEXTURE_BINDING` usage, sized exactly one texel per complete 8×8 SAD
    window: `floor((planeWidth − 16) / 4) + 1` × `floor((planeHeight − 8) / 4) + 1`. Luma textures mark a differing
    window as white; chroma textures put U in G and V in B.
- `options: WebGPUBackendOptions` = `{ width, height, chromaSubsampling, loThreshold?, hiThreshold?, fraction? }`.
  `chromaSubsampling` is required; every plane must be ≥ 16×8 (for YUV420 that means the video must be ≥ 32×16).
- `writeYUVTextures(stream)` (from `interface`) consumes `Stream<IncomingYUVFrame>` and emits `WrittenYUVFrame`
  per frame with `isFrameKept` **and** `comparison: ComparisonResult` — per-plane window counts
  (`luma/u/v: { overLo, overHi }`) plus `lumaLoLimit` / `chromaLoLimit` (FFmpeg's `trunc((w/16)*(h/16)*frac)`).
  Use these for numeric readouts; do not recompute them in the app.
- `chromaPlaneSize(subsampling, width, height)` is exported from `interface` — delete the duplicate
  `getChromaPlaneSize` in `VisualizeResources.ts` and use it.
- Processing is strictly sequential: after a `WrittenYUVFrame` is emitted, the diff textures deterministically hold
  exactly that frame's result. Blit from a `Stream.tap` after emission and it can never tear.

## Dynamic parameters: `WebGPUComparisonControls`

The layer provides a **third** service, `WebGPUComparisonControls`, for live slider updates without rebuilding the
layer (decimation state and reference textures are preserved):

- `setThresholds(lo, hi)` — writes the two `i32` values into the comparison uniform buffer. Values must be safe
  integers; fails with `YUVTexturePipelineError` otherwise.
- `setFraction(fraction)` — updates the CPU-side `frac` used for the keep/drop decision and the reported
  `lumaLoLimit`/`chromaLoLimit`. Must be finite and non-negative.

Updates apply to the next processed frame (the pipeline is sequential, so there is never a frame in flight while
an update runs between frames). See the "applies threshold and fraction updates to the next frame" test in
`libs/webgpu-impl/test/index.test.ts` for a usage example.

## Design decision: seeking is intentionally not handled

FFmpeg has no seek concept: `mpdecimate` consumes a frame sequence and compares each frame against the last kept
one. A seek just makes the sequence the app feeds discontinuous, which is indistinguishable from a hard scene cut
— something the filter already handles naturally. Post-seek, one of two things happens, and both self-correct:

- The frame looks very different → kept, reference updated, business as usual.
- The frame looks similar → dropped, and keeps being dropped until the video changes — which is exactly what
  mpdecimate would decide for that frame sequence.

So the app does **nothing** on `@seeked`: no reference reset, no layer rebuild, no generation counter, no forced
"kept" chip. The old `web/` app's forced-keep-after-seek was an invented semantic with no FFmpeg counterpart;
showing the raw algorithm behavior (including the post-seek drop streak) is truer to the tool's purpose. This
also means the pipeline fiber, layer scope, frame queue, and blit bind groups are built exactly once on mount
and torn down exactly once on unmount — a `disposed` flag is the only async-completion guard needed. The UI
simply keeps showing the last comparison performed until the next frame processes.

## App implementation steps

### 1. `VisualizeResources.ts` — swap the mock for the real layer

- Keep the `VisualizeResources` shape but have `PrepareVisualize.vue` build the real thing:
  `encoderLive: WebGPUDiffTextures.layer(context.device, context.queue, { width, height, chromaSubsampling })`.
- Keep `createMockVisualizeResources` for tests/storybook-style use, but the app path uses the real factory.
- Validate up front: reject videos smaller than 32×16 (YUV420) with the existing error empty-state in
  `PrepareVisualize.vue`, since the backend throws at layer build time otherwise.

### 2. Frame source — `requestVideoFrameCallback` → `Stream<IncomingYUVFrame>`

- Predict the tightly packed byte length from plane sizes (`lumaW*lumaH + 2*chromaW*chromaH`); allocate one
  reusable `Uint8Array`. Do **not** use `VideoFrame.allocationSize()` for YUV frames (lesson from `web/`).
- In the callback: `new VideoFrame(videoElement)`, `await frame.copyTo(buffer)`, always `frame.close()` in a
  `finally`. `planeLayouts.length === 2` ⇒ `isUVInterleaved: true` (NV12), `3` ⇒ planar. Assemble
  `IncomingYUVFrame` from the layouts' offsets.
- Bridge callback → stream with an Effect `Queue` (`Queue.unbounded` or small bounded with backpressure drop):
  the rVFC handler offers frames; the pipeline is `writeYUVTextures(Stream.fromQueue(queue))`. Re-arm
  `requestVideoFrameCallback` only after the previous frame's processing completes (sequential GPU readback makes
  overlap pointless) — or accept queue growth and drop stale frames.
- Cancel the pending rVFC on unmount; interrupt the pipeline fiber on unmount.

### 3. Run the pipeline with the layer scope owned by the component

- On mount, once: `Effect.runFork` of
  `writeYUVTextures(frames).pipe(Stream.tap(onFrame), Stream.runDrain, Effect.provide(resources.encoderLive))`.
  Providing the layer inside the forked program gives the fiber ownership of the GPU resources: interrupting the
  fiber releases them. Keep the fiber handle; `Fiber.interrupt` on unmount/discard.
- `onFrame(written)` updates Vue state: `isCurrentFrameKept`, and the six counts + two limits from
  `written.comparison` for readouts next to the sliders (`overLo > limit` / `overHi > 0` coloring, like the old
  web app).

### 4. Blit the diff textures to the four canvases

- Port `double_blit.wgsl` from `web/src/shaders/`: full-screen triangle-strip quad from `@builtin(vertex_index)`,
  fragment samples `lo`/`hi` textures and writes to two color targets. The app owns this pipeline, the sampler,
  and the canvas contexts — the backend only exposes textures.
- Access textures via the service: inside the same provided program,
  `const diff = yield* WebGPUDiffTextures` (available because `encoderLive` provides it). Build two bind groups:
  (lumaLo, lumaHi) and (chromaLo, chromaHi).
- Configure the four canvases once: `canvas.width/height = texture.width/height`,
  `getContext('webgpu').configure({ device, format: navigator.gpu.getPreferredCanvasFormat() })`. Since the
  textures are exactly window-grid sized, blit edge to edge — no UV scaling, no valid-region handling.
- In the `Stream.tap`, after updating counts, encode one render pass per pair with fresh
  `context.getCurrentTexture().createView()` (never cache swap-chain textures) and submit. Submission order after
  the comparison submit guarantees the pass sees the finished SAD results.
- The diff textures live for the whole layer scope (one per mount), so the bind groups are built once.

### 5. Threshold controls

- `v-slider`/`v-number-input` handlers call `WebGPUComparisonControls.setThresholds(lo, hi)` immediately
  (truncate to integers first), even while paused. Call `setFraction` on frac change — frac only affects the
  CPU-side decision and reported limits, so it applies on the next frame without any GPU write.
- Get the service the same way as the diff textures: `yield* WebGPUComparisonControls` inside the provided
  program, or run the update effect against the same layer-provided runtime the pipeline fiber uses.
- Never rebuild the layer for a parameter change — that would reset the reference frame.

### 6. Lifecycle handling

- Seeking needs no handler (see the design decision above): a post-seek frame is just the next frame in the
  stream, and an in-flight pre-seek `copyTo` that completes after the seek is just one more harmless frame.
- Guard async completions (`copyTo`, readback taps) with a single `disposed` flag set on unmount.
- On component unmount: interrupt fiber (releases GPU resources via scope), cancel rVFC, unconfigure canvas
  contexts.
- If `copyTo` fails, re-arm the rVFC before surfacing the error — a failed copy never reaches the pipeline's
  tap, so without this a transient decode hiccup stalls processing for good.

## Milestones (each independently verifiable)

1. **Pipeline runs**: real layer wired, frames flow, kept/dropped chip and count readouts update. Verify with
   `rushx dev` against a test video; counts change when content changes.
2. **Canvases live**: four diff textures blitted per processed frame.
3. **Controls + lifecycle**: sliders act immediately; seeking neither errors nor stalls the pipeline (the next
   frame simply compares against the pre-seek reference); no leaked fibers/callbacks on unmount (check with
   repeated stage discard/re-upload).
4. **Cross-check**: play one of the generated test videos from `libs/webgpu-impl/test/generated/` and compare
   kept-frame indices against `ffmpeg -vf mpdecimate` output at the same lo/hi/frac.

## Constraints carried over from the previous `web/` implementation

- Preserve YUV: never round-trip frame data through RGB.
- Every `VideoFrame` is closed exactly once; every pending `requestVideoFrameCallback` is cancelled on unmount.
- FFmpeg fidelity rules live in the libs (strict `>`, integer SAD, window traversal, per-plane frac limit) — the
  app must not reimplement any decimation math; it only displays what `ComparisonResult` reports.
