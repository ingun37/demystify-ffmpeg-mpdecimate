# mpdecimate playground

This website visualizes how [mpdecimate filter](https://ffmpeg.org/ffmpeg-filters.html#toc-mpdecimate) works.

## How to test (monorepo)

The `monorepo/` workspace uses [Rush](https://rushjs.io). Install dependencies once:

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
produces identical videos — but each environment must generate the videos
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

## Visualization pipeline of @web project

```mermaid
flowchart TD
  UI["Video element + threshold controls"] -->|play| Schedule["requestVideoFrameCallback loop"]
  UI -->|lo / hi changed| Thresholds["Write thresholds to GPU buffers"]
  UI -->|seeked| Reset["Increment reference generation<br/>Force next frame kept"]

  Schedule --> Frame["Create VideoFrame"]
  Frame --> Copy["Copy Y / U / V planes to CPU frame buffer"]

  Copy --> YUpload["Upload Y plane"]
  Copy --> ChromaType{"Chroma plane layout"}

  YUpload --> YMap["Y map compute pass<br/>Y buffer → Y texture array"]

  ChromaType -->|Interleaved UV| UVUpload["Upload combined UV plane"]
  UVUpload --> Deinterleave["UV deinterleave compute pass<br/>→ U and V textures"]

  ChromaType -->|Separate U + V| UVSeparate["Upload U and V planes"]
  UVSeparate --> UVMap["Map U and V compute passes<br/>→ U and V textures"]

  YMap --> SAD["Luma SAD threshold compute pass"]
  Deinterleave --> ChromaSAD["Chroma SAD threshold compute pass"]
  UVMap --> ChromaSAD

  Thresholds --> SAD
  Thresholds --> ChromaSAD

  SAD --> LumaOutputs["Lo / Hi luma output textures"]
  ChromaSAD --> ChromaOutputs["Lo / Hi chroma output textures"]

  LumaOutputs --> Count["Four nonzero-count compute passes"]
  ChromaOutputs --> Count
  Count --> Readback["Copy count buffers → map/read on CPU"]

  LumaOutputs --> Blit["Double-blit render pass"]
  ChromaOutputs --> ChromaBlit["Chroma double-blit render pass"]
  Blit --> Canvases["Lo / Hi luma canvases"]
  ChromaBlit --> Canvases2["Lo / Hi chroma canvases"]

  Readback --> Decision{"Keep frame?"}
  Reset --> Decision
  Decision -->|First after seek, hi diff,<br/>or lo count exceeds frac threshold| Keep["Keep frame<br/>advance texture-array index"]
  Decision -->|Otherwise| Drop["Drop frame<br/>reuse reference index"]

  Keep --> Status["Update UI counts and kept/dropped status"]
  Drop --> Status
  Status --> Schedule
```
