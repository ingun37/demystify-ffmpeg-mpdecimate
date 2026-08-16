# Project Rules

## General

- Use pnpm for running project commands.

## Stack

- Framework: Vue 3 + Vite
- UI Library: Vuetify
- Enabled Features: ESLint, Vuetify MCP

## Video/WebGPU pipeline

- Keep the application as an explicit sequence of Vue stages: initialize WebGPU, upload video, detect chroma
  subsampling, prepare GPU resources, then visualize. A stage only renders its successor after it has produced non-null,
  typed inputs.
- Preserve YUV data: do not introduce an intermediate RGB conversion when moving `VideoFrame` data into WebGPU
  resources.
- `ChromaSubsampling` lives in `src/ChromaSubsampling.ts`; use it instead of string literals. `VisualizeResources` lives
  in `src/VisualizeResources.ts` so additional WebGPU resources can be added without widening component props.
- Plane textures are two-dimensional `rgba8unorm` texture arrays with `TEXTURE_BINDING | STORAGE_BINDING` usage. Y is
  full video size; U/V are half width and half height for 4:2:0, half width/full height for 4:2:2, and full size for 4:
  4:4. Each shader writes the normalized plane value into the red channel. Keep the shared array length in
  `VisualizeResources`.
- Predict the tightly packed YUV byte length from the plane dimensions while preparing visualization resources; do not
  use
  `VideoFrame.allocationSize()` for YUV frames. Reuse that staging array for `VideoFrame.copyTo()` during playback.
- Playback copies the Y plane into the reusable `yBuffer`, then dispatches `y_map.wgsl` to normalize and write it into
  the current Y texture-array layer. For two-plane formats such as NV12, copy the interleaved chroma plane into the
  reusable `uvCombinedBuffer`, then dispatch `uv_deinterleave.wgsl` to normalize and write U/V into the matching layer.
  For three-plane formats, copy the separate U and V planes into reusable `uBuffer` and `vBuffer` resources, then reuse
  the straightforward `y_map.wgsl` pipeline with plane-specific bind groups to map them into `uTexture` and `vTexture`.
  Build both compute pipelines and bind groups in
  `PrepareVisualize.vue`, using `wgsl_reflect` for entry-point and binding discovery.
- The two texture-array layers represent the last kept reference frame and the current candidate frame. Upload the
  candidate into the current layer and compare it with the preceding layer. Advance the shared layer index with
  wraparound only when the completed `hi`/`lo` count readback classifies the candidate as kept. When it is dropped, do
  not advance: the next candidate must overwrite the dropped frame and compare against the same last-kept reference.
  Force the first processed frame to be kept as the initial reference. After a video seek, invalidate any in-flight
  pre-seek result and force the next processed frame to be kept as the new reference. FFmpeg's optional `max`
  consecutive-drop counter is intentionally not implemented.
- SAD thresholding is split by plane size. `sad_threshold_8x8_window_luminance.wgsl` compares only Y and writes the
  threshold result to RGB (white). `sad_threshold_8x8_window_chrominance.wgsl` compares U and V, which share native
  dimensions, and writes their results to G and B respectively. Never combine Y with chroma in one output grid.
  `rgba8unorm` loads must be multiplied by 255 before accumulation so SAD sums use FFmpeg's byte scale.
- These are windows, not kernels: each invocation evaluates one complete 8×8 region, starting at `x = 8`, then moving
  by four pixels in both axes (`y = 0, 4, ...`; `x = 8, 12, ...`). Allocate one compact output texel per valid window:
  `floor((planeWidth - 16) / 4) + 1` by `floor((planeHeight - 8) / 4) + 1`. Do not clamp edge samples, because partial
  windows are not part of FFmpeg's traversal.
- Both threshold shaders compare with strict `sad > threshold`, matching FFmpeg. The default thresholds are
  `lo = 64 * 5` (320) and `hi = 64 * 12` (768), stored as signed 32-bit uniform values. Create and expose distinct
  luma and chroma compute pipelines, reflected bind groups, and compact lo/hi output textures through
  `VisualizeResources`; dispatch both after all plane-upload passes and before submitting the command encoder.
- Apply `frac` independently to each plane using FFmpeg's exact integer threshold:
  `trunc(floor(planeWidth / 16) * floor(planeHeight / 16) * frac)`. A plane differs through the low threshold only when
  its number of windows with `sad > lo` is strictly greater than that threshold. Do not divide the count by the compact
  SAD output texture's texel count; the overlapping 8×8 window count is not the denominator FFmpeg uses.
- Threshold controls in `Visualize.vue` own numeric Vue state and use Vuetify's `v-number-input`. On every
  `update:model-value`, validate and truncate the value to an integer, update the matching Vue value, and immediately
  call `queue.writeBuffer()` with an `Int32Array` for `loThresholdBuffer` or `hiThresholdBuffer`. This must not wait for
  a new video frame: the next threshold dispatch should use the new uniform value even if playback is paused.
- Present threshold outputs with `double_blit.wgsl`: it owns the built-in full-screen quad, samples a lo/hi texture pair
  through one bind group, and writes them to fragment locations 0 and 1 in one render pass. Reuse its render pipeline
  with separate luma and chroma bind groups, and configure two luma canvases plus two chroma canvases in
  `Visualize.vue`. Each canvas pair uses its corresponding compact output dimensions and the preferred canvas format.
- Read each compute entry point's `workgroup_size` attribute with `wgsl_reflect` during resource preparation, store it
  in
  `VisualizeResources`, and use it to calculate dispatch counts. Do not duplicate WGSL workgroup dimensions in
  TypeScript.
- Every `VideoFrame` must be closed once it is no longer needed. Playback processing uses
  `HTMLVideoElement.requestVideoFrameCallback`; cancel a pending callback when its component unmounts.
- The current TypeScript DOM declarations provide WebGPU types but not the `GPUTextureUsage` and `GPUBufferUsage`
  values. Use typed spec flag values unless the WebGPU type setup is updated: `0x08 | 0x04` for plane texture
  `STORAGE_BINDING | TEXTURE_BINDING`, `0x80 | 0x08` for storage-buffer `STORAGE | COPY_DST`, and `0x40 | 0x08` for
  uniform-buffer `UNIFORM | COPY_DST`.

# The original `mpdecimate`

This app visualizes the *FFmpeg*'s *mpdecimate* filter. Here's the code snippet from the actual code

```c
/**
 * Return 1 if the two planes are different, 0 otherwise.
 */
static int diff_planes(AVFilterContext *ctx,
                       uint8_t *cur, int cur_linesize,
                       uint8_t *ref, int ref_linesize,
                       int w, int h)
{
    DecimateContext *decimate = ctx->priv;

    int x, y;
    int d, c = 0;
    int t = (w/16)*(h/16)*decimate->frac;

    /* compute difference for blocks of 8x8 bytes */
    for (y = 0; y < h-7; y += 4) {
        for (x = 8; x < w-7; x += 4) {
            d = decimate->sad(cur + y*cur_linesize + x, cur_linesize,
                              ref + y*ref_linesize + x, ref_linesize);
            if (d > decimate->hi) {
                av_log(ctx, AV_LOG_DEBUG, "%d>=hi ", d);
                return 1;
            }
            if (d > decimate->lo) {
                c++;
                if (c > t) {
                    av_log(ctx, AV_LOG_DEBUG, "lo:%d>=%d ", c, t);
                    return 1;
                }
            }
        }
    }

    av_log(ctx, AV_LOG_DEBUG, "lo:%d<%d ", c, t);
    return 0;
}

/**
 * Tell if the frame is different with respect to the reference frame ref.
 */
static int is_frame_different(AVFilterContext *ctx,
                              AVFrame *cur, AVFrame *ref)
{
    DecimateContext *decimate = ctx->priv;
    int plane;

    for (plane = 0; ref->data[plane] && ref->linesize[plane]; plane++) {
        /* use 8x8 SAD even on subsampled planes.  The blocks won't match up with
         * luma blocks, but hopefully nobody is depending on this to catch
         * localized chroma changes that wouldn't exceed the thresholds when
         * diluted by using what's effectively a larger block size.
         */
        int vsub = plane == 1 || plane == 2 ? decimate->vsub : 0;
        int hsub = plane == 1 || plane == 2 ? decimate->hsub : 0;
        if (diff_planes(ctx,
                        cur->data[plane], cur->linesize[plane],
                        ref->data[plane], ref->linesize[plane],
                        AV_CEIL_RSHIFT(ref->width, hsub),
                        AV_CEIL_RSHIFT(ref->height, vsub)))
            return 1;
    }

    return 0;
}
```

## Explanation of the plane iteration

The loop iterates over every populated image plane in the reference frame:

```c
for (plane = 0; ref->data[plane] && ref->linesize[plane]; plane++)
```

It starts at plane 0 and continues while:

- `ref->data[plane]` points to plane data, and
- `ref->linesize[plane]` is nonzero.

For ordinary planar YUV:

| Format  | Plane 0      | Plane 1              | Plane 2              |
|---------|--------------|----------------------|----------------------|
| YUV444P | Y, full size | U, full size         | V, full size         |
| YUV422P | Y, full size | U, half width        | V, half width        |
| YUV420P | Y, full size | U, half width/height | V, half width/height |

Thus, for YUV420P, the loop invokes `diff_planes()` three times:

```text
plane 0: compare Y at width × height
plane 1: compare U at ceil(width/2) × ceil(height/2)
plane 2: compare V at ceil(width/2) × ceil(height/2)
```

The dimensions are selected here:

```c
int vsub = plane == 1 || plane == 2 ? decimate->vsub : 0;
int hsub = plane == 1 || plane == 2 ? decimate->hsub : 0;
```

and calculated with:

```c
AV_CEIL_RSHIFT(ref->width, hsub)
AV_CEIL_RSHIFT(ref->height, vsub)
```

For YUV420P, `hsub = 1` and `vsub = 1`, meaning division by two with rounding up.

### What `diff_planes()` compares

`diff_planes()` does not understand Y, U, or V semantically. It receives one byte array and treats it as a rectangular
plane of 8-bit samples. It calculates an 8×8 SAD—sum of absolute differences—at overlapping positions:

```c
d = sad(cur_block, cur_linesize, ref_block, ref_linesize);
```

If one block exceeds `hi`, or enough blocks exceed `lo`, the entire frame is considered different. A difference in any
one plane causes an immediate return:

```c
if (diff_planes(...))
    return 1;
```

### What about NV12?

You are correct that NV12 has two planes:

```text
plane 0: Y Y Y Y ...        width × height bytes
plane 1: U V U V U V ...    width × ceil(height/2) bytes
```

However, this filter does **not accept NV12 directly**. Its supported pixel formats are explicitly planar formats such
as `YUV420P`, `YUV422P`, and `YUV444P`:

```c
static const enum AVPixelFormat pix_fmts[] = {
    AV_PIX_FMT_YUV444P,
    AV_PIX_FMT_YUV422P,
    AV_PIX_FMT_YUV420P,
    ...
};
```

`AV_PIX_FMT_NV12` is absent. During filter-format negotiation, FFmpeg must convert NV12 to a supported format—normally
planar YUV420P—before `mpdecimate` receives it. Consequently, `diff_planes()` normally sees separate U and V planes, not
an interleaved NV12 chroma plane.

If NV12 were passed into this function anyway, the current logic would not handle it correctly:

- It would call `diff_planes()` for plane 1 only.
- `diff_planes()` would treat alternating U and V bytes as one generic byte plane.
- More importantly, it would pass `ceil(width/2)` as `w`, even though an NV12 chroma row contains approximately `width`
  bytes because every chroma position has both a U and a V byte.
- It would therefore examine only approximately half of each chroma row.

So this code’s subsampling logic assumes that planes 1 and 2 are separate planar chroma planes. Its advertised
pixel-format list enforces that assumption.
