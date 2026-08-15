# Project Rules

## General
- Use pnpm for running project commands.

## Stack
- Framework: Vue 3 + Vite
- UI Library: Vuetify
- Enabled Features: ESLint, Vuetify MCP

## Video/WebGPU pipeline
- Keep the application as an explicit sequence of Vue stages: initialize WebGPU, upload video, detect chroma subsampling, prepare GPU resources, then visualize. A stage only renders its successor after it has produced non-null, typed inputs.
- Preserve YUV data: do not introduce an intermediate RGB conversion when moving `VideoFrame` data into WebGPU resources.
- `ChromaSubsampling` lives in `src/ChromaSubsampling.ts`; use it instead of string literals. `VisualizeResources` lives in `src/VisualizeResources.ts` so additional WebGPU resources can be added without widening component props.
- Plane textures are single-channel `r8unorm`: Y is full video size; U/V are half width and half height for 4:2:0, half width/full height for 4:2:2, and full size for 4:4:4. Allocate textures with `TEXTURE_BINDING | COPY_DST` usage.
- Every `VideoFrame` must be closed once it is no longer needed. Playback processing uses `HTMLVideoElement.requestVideoFrameCallback`; cancel a pending callback when its component unmounts.
- The current TypeScript DOM declarations provide WebGPU types but not the `GPUTextureUsage` value. Use typed spec flag values (`0x04 | 0x08` for `TEXTURE_BINDING | COPY_DST`) unless the WebGPU type setup is updated.

## Verification
- Run `pnpm type-check` and `pnpm lint` after changes.
