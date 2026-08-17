# YUV texture pipeline interface

This package defines an Effect `Stream` pipeline for tightly packed YUV frames. It intentionally does not depend on WebGPU or another execution environment. A backend implements the `YUVTextureCommandEncoder` service, and an application provides that implementation when it runs the stream.

The pipeline performs this sequence for every frame:

1. Split the input into Y and chroma plane bytes.
2. Open a command batch through `YUVTextureCommandEncoder.submit`.
3. Enqueue the current Y/U/V texture writes, deinterleaving UV when necessary.
4. Enqueue comparison of the current textures with the reference textures.
5. Submit the batch and read the comparison result.
6. If the frame is kept, open another batch and copy current Y/U/V into reference Y/U/V.

The first frame follows the same path. It is compared with the initially empty reference textures and will normally be kept, establishing the reference for the next frame.

## Ownership

Responsibility is divided between three packages or layers:

- This interface package defines frame types, semantic commands, and stream behavior.
- A backend package creates resources and implements the commands. A WebGPU backend owns the `GPUTexture`, `GPUBuffer`, pipeline, bind group, command encoder, and readback details.
- The application chooses the backend and controls its lifetime by providing its `Layer` around the running stream.

Current and reference textures should be acquired once in the backend layer, not once per frame. Effect closes the layer scope when stream execution finishes, fails, or is interrupted.

## 1. Define backend resources

A WebGPU implementation will usually hold two texture sets plus the resources used by its compute passes:

```ts
interface TextureSet {
  readonly y: GPUTexture
  readonly u: GPUTexture
  readonly v: GPUTexture
}

interface WebGPUResources {
  readonly current: TextureSet
  readonly reference: TextureSet

  readonly comparisonPipeline: GPUComputePipeline
  readonly referenceCopyPipeline: GPUComputePipeline

  // Include staging, counter, and readback buffers and bind groups here.
}
```

The texture format and dimensions are backend concerns. The backend should ensure they match the frames accepted by the application.

## 2. Acquire them as scoped resources

Use `Effect.acquireRelease` to create and destroy the WebGPU resources. `Layer.effect` builds the service inside the layer's scope, so the `Scope` requirement is handled by the layer.

```ts
import { Effect, Layer } from "effect"
import {
  YUVTextureCommandEncoder,
  type YUVTextureCommandEncoderService,
  YUVTexturePipelineError,
} from "interface"

const acquireResources = (
  device: GPUDevice,
  width: number,
  height: number,
) => Effect.acquireRelease(
  Effect.try({
    try: (): WebGPUResources => ({
      current: createTextureSet(device, width, height),
      reference: createTextureSet(device, width, height),
      comparisonPipeline: createComparisonPipeline(device),
      referenceCopyPipeline: createReferenceCopyPipeline(device),
    }),
    catch: cause => new YUVTexturePipelineError({
      message: "Could not create WebGPU resources.",
      cause,
    }),
  }),
  resources => Effect.sync(() => {
    destroyTextureSet(resources.current)
    destroyTextureSet(resources.reference)
  }),
)
```

Newly created WebGPU textures are initially empty/zeroed for the purpose of the first comparison. If a backend cannot rely on that, explicitly clear the reference textures during acquisition.

## 3. Implement one command batch

`submit` must create a fresh backend command encoder for each call. The callback records semantic operations into that encoder. After the callback succeeds, finish and submit it.

```ts
const makeService = (
  device: GPUDevice,
  queue: GPUQueue,
  resources: WebGPUResources,
): YUVTextureCommandEncoderService => ({
  submit: record => Effect.gen(function* () {
    const encoder = device.createCommandEncoder()

    const result = yield* record({
      enqueuePlaneWrite: input => Effect.try({
        try: () => {
          stagePlaneBytes(queue, input)
          encodePlaneTextureWrite(encoder, resources.current, input)
        },
        catch: cause => new YUVTexturePipelineError({
          message: `Could not enqueue the ${input.plane} texture write.`,
          cause,
        }),
      }),

      enqueueUVDeinterleave: input => Effect.try({
        try: () => {
          stageInterleavedUVBytes(queue, input)
          encodeUVDeinterleave(encoder, resources.current, input.size)
        },
        catch: cause => new YUVTexturePipelineError({
          message: "Could not enqueue UV deinterleaving.",
          cause,
        }),
      }),

      enqueueComparison: () => Effect.try({
        try: () => {
          const readback = encodeComparison(
            encoder,
            resources.current,
            resources.reference,
          )

          return {
            // This Effect runs only after submit() below has returned.
            read: readComparisonResult(readback),
          }
        },
        catch: cause => new YUVTexturePipelineError({
          message: "Could not enqueue frame comparison.",
          cause,
        }),
      }),

      enqueueReferenceCopy: () => Effect.try({
        try: () => encodeReferenceCopy(
          encoder,
          resources.current,
          resources.reference,
        ),
        catch: cause => new YUVTexturePipelineError({
          message: "Could not enqueue the reference texture copy.",
          cause,
        }),
      }),
    })

    yield* Effect.try({
      try: () => queue.submit([encoder.finish()]),
      catch: cause => new YUVTexturePipelineError({
        message: "Could not submit WebGPU commands.",
        cause,
      }),
    })

    return result
  }),
})
```

Do not reuse the command encoder after the callback. Do not submit if recording fails.

`queue.writeBuffer` is not recorded into a `GPUCommandEncoder`, but staging calls may still occur inside the callback. Keeping them there centralizes the per-frame ordering and ownership.

## 4. Implement comparison readback

`enqueueComparison` must enqueue all comparison, counter, and buffer-copy commands needed for readback. It returns a `ComparisonReadback`, but must not try to read the result while the callback is still recording: the command batch has not been submitted yet.

The returned `read` Effect should wait for/map the readback buffer and calculate the mpdecimate decision:

```ts
const readComparisonResult = (
  buffer: GPUBuffer,
) => Effect.tryPromise({
  try: async () => {
    await buffer.mapAsync(GPUMapMode.READ)

    try {
      const counts = readComparisonCounts(buffer.getMappedRange())
      const isFrameKept = counts.hasHiDifference || counts.hasLoDifferenceOverFrac
      return { isFrameKept }
    } finally {
      buffer.unmap()
    }
  },
  catch: cause => new YUVTexturePipelineError({
    message: "Could not read the frame comparison result.",
    cause,
  }),
})
```

The pipeline reads this Effect after `submit` completes. If `isFrameKept` is true, it calls `submit` again and enqueues `enqueueReferenceCopy`. A dropped frame therefore leaves the previous kept frame in the reference textures.

If the backend uses reusable readback buffers, sequential stream processing guarantees that the next frame does not begin until the current readback and possible reference copy finish.

## 5. Build the backend layer

Combine scoped acquisition with service construction:

```ts
const makeWebGPULayer = (
  device: GPUDevice,
  queue: GPUQueue,
  width: number,
  height: number,
) => Layer.effect(YUVTextureCommandEncoder)(
  acquireResources(device, width, height).pipe(
    Effect.map(resources => makeService(device, queue, resources)),
  ),
)
```

The concrete textures live for exactly as long as this layer is provided.

## 6. Run the pipeline from the application

The application supplies `Stream<IncomingYUVFrame>` and provides the backend layer:

```ts
import { Effect, Stream } from "effect"
import {
  type IncomingYUVFrame,
  writeYUVTextures,
} from "interface"

declare const incomingFrames: Stream.Stream<IncomingYUVFrame>

const WebGPULive = makeWebGPULayer(
  device,
  queue,
  videoWidth,
  videoHeight,
)

const program = writeYUVTextures(incomingFrames).pipe(
  Stream.tap(frame => Effect.log(
    frame.isFrameKept ? "Frame kept" : "Frame dropped",
  )),
  Stream.runDrain,
  Effect.provide(WebGPULive),
)

await Effect.runPromise(program)
```

Providing the layer at this level means:

- resources are created when the application starts consuming the stream;
- the same current/reference textures are reused across frames;
- resources are released on normal completion, failure, or interruption;
- the interface package remains independent of WebGPU.

## Command order

For a dropped frame:

```text
open encoder
  write current Y/U/V
  compare current with reference
  copy comparison data to readback
submit
read comparison: dropped
leave reference unchanged
```

For a kept frame:

```text
open encoder
  write current Y/U/V
  compare current with reference
  copy comparison data to readback
submit
read comparison: kept

open encoder
  copy current Y/U/V to reference Y/U/V
submit
```

## Testing a backend

At minimum, verify that:

- planar input writes Y, U, and V before comparison;
- interleaved input writes Y and dispatches UV deinterleaving before comparison;
- the first frame is compared with the empty reference textures;
- kept frames copy current textures into reference textures;
- dropped frames do not change reference textures;
- a failed recording is not submitted;
- resource finalizers destroy every texture and buffer;
- interruption during streaming releases the scoped resources.

Run this package's checks through Rush:

```sh
rushx test
rushx build
```
