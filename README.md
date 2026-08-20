# mpdecimate playground

This web app visualizes how FFmpeg's
[mpdecimate filter](https://ffmpeg.org/ffmpeg-filters.html#toc-mpdecimate)
works. Upload a video and watch how the mysterious, unintuitive `hi`, `lo`,
and `frac` parameters play out in deciding whether each frame is kept or
dropped.

The frame comparison is a faithful re-implementation of mpdecimate's
algorithm, verified against FFmpeg's actual mpdecimate output on every frame
of hundreds of videos in automated integration tests. The comparison runs
entirely in your browser on the GPU via WebGPU — no data leaves your machine.

Questions or feedback? Email [ingun37@gmail.com](mailto:ingun37@gmail.com).
Issues and pull requests are welcome.

## Repository layout

- **`monorepo/`** — the TypeScript workspace, managed with
  [Rush](https://rushjs.io) and pnpm. Contains the web app and its libraries.

  - **`libs/interface`** — defines the backend-agnostic YUV frame pipeline: an
    [Effect](https://effect.website) `Stream` that, for every frame, writes
    the Y/U/V planes, compares them against the reference textures, and
    decides keep/drop. It deliberately has no WebGPU dependency; backends
    implement its `YUVTextureCommandEncoder` service. Tech stack: TypeScript,
    Effect, Vitest.

  - **`libs/webgpu-impl`** — the WebGPU backend for `interface`. Owns the GPU
    textures, compute pipelines (frame comparison, UV deinterleaving,
    reference copy), and readback buffers. Its integration tests stream test
    videos from the `yuv_stream` gRPC server and compare every keep/drop
    decision against FFmpeg's native mpdecimate output. Tech stack:
    TypeScript, Effect, WGSL compute shaders, Vitest (with the Node `webgpu`
    package), gRPC (`@grpc/grpc-js`).

  - **`apps/app`** — the web app itself. Decodes the uploaded video, feeds
    frames into the pipeline with the WebGPU backend, and visualizes the
    per-frame keep/drop decisions. Tech stack: Vue 3, Vuetify, Vite, Effect,
    TypeScript.

- **`yuv_stream/`** — native C++ tooling used for testing (not part of the
  deployed site). Tech stack: C++, CMake, FFmpeg libraries, gRPC/Protocol
  Buffers. It builds three targets:

  - `yuv_stream`: a gRPC server that decodes an uploaded video and streams
    back raw YUV frames.
  - `mpdecimate_server`: a gRPC server that runs FFmpeg's native mpdecimate
    filter and reports which frames it keeps — the ground truth for the
    integration tests.
  - `create_test_video`: generates synthetic H.264 test videos.

## How to test (monorepo)

Install dependencies once:

```sh
cd monorepo && rush install
```

### Unit tests

Run tests per package with `rushx` from the package directory:

```sh
cd monorepo/libs/interface && rushx test
cd monorepo/libs/webgpu-impl && rushx test
```

Or build and test everything:

```sh
cd monorepo && rush build
```

### Integration tests (webgpu-impl)

`monorepo/libs/webgpu-impl/test/yuv-stream.integration.test.ts` needs
pre-generated test videos. The random parameters that define them are tracked
by git in `monorepo/libs/webgpu-impl/test/parameters/`, so every environment
produces identical videos, but each environment must generate the videos
themselves.

1. Build the `create_test_video` tool:

   ```sh
   cmake --build yuv_stream/cmake-build-debug --target create_test_video
   ```

2. Generate the videos into `monorepo/libs/webgpu-impl/test/generated/`
   (untracked):

   ```sh
   monorepo/libs/webgpu-impl/test/generate-test-videos.sh
   ```

3. Run the tests:

   ```sh
   cd monorepo/libs/webgpu-impl && rushx test
   ```

Only re-run `monorepo/libs/webgpu-impl/test/generate-random-parameters.sh` if
you want to change the test data itself; commit the resulting `parameters/`
files so other environments stay consistent.
