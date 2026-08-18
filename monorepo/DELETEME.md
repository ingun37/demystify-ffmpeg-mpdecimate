I'll build the scaffold in the monorepo app. Let me first look at what's already there — the app structure and the
effect/webgpu-impl packages from the recent commits.

Dependencies linked. Now writing the scaffold. Quick check that `Effect.void` and `Layer.succeed` curried form exist in
this effect v4 RC:

Now the App orchestration, and cleanup of the scaffold leftovers:

Lint passed with auto-fixes (import ordering). Now type-check:

Type-check is clean. Now let me verify the flow in the browser:

The server process seems to have died. Let me restart and check its logs:

The preview harness ran `pnpm install` itself, which fails in a Rush repo. I'll point the launch config directly at the
vite binary instead:

The preview harness insists on running `pnpm install` in the app directory, which doesn't work in a Rush workspace. I'll
start vite myself and attach the preview to the running server:

The full flow ran automatically: upload → chroma detection (4:2:0) → mock prepare → Visualize with all controls. Let me
check console errors and test the Back and About buttons:

The flow works. The screenshot shows placeholder squares where mdi icons should be — some resources 403'd. Let me check
which:

Found it: the fonts resolve into the Rush shared store at `common/temp/node_modules`, which is outside Vite's default
`fs.allow` root — so mdi/roboto fonts 403. Fixing the vite config:

Fonts load now. Re-running the flow and testing Back + About:

Icons render correctly. Testing the About dialog:

The dialog opened but looks mid-transition; let me re-screenshot:

About dialog works. Now close it and test the Back button:

Back works — returned to upload, back arrow hidden. Cleaning up the temp test video and finishing:

The scaffold is done and verified end-to-end in the browser: WebGPU init → video upload → chroma detection (4:2:0
detected on a test clip) → mock resource prep → the Visualize screen with sliders, info card, empty canvases, a working
Back button, and the empty About dialog. Lint and type-check are clean.

## Architecture

Instead of web/'s nested chain (each stage rendering its successor inside itself),
**[App.vue](monorepo/apps/app/src/App.vue) owns a flat stage state machine** defined
in [stages.ts](monorepo/apps/app/src/stages.ts):

```
initialize-webgpu → upload-video → detect-chroma-subsampling → prepare-visualize → visualize
```

Each stage variant is a discriminated union member carrying exactly the data produced so far (`context` → `+video` →
`+chromaSubsampling` → `+resources`), so a stage component can never render without its typed inputs. Stage components
are dumb: they emit one typed event (`ready` / `selected` / `detected` / `discard`) and App performs the transition.
That makes **Back** trivial — App releases the video (pause, unload, revoke object URL) and resets to `upload-video`;
the WebGPU context survives.

**The webgpu-impl seam** is [VisualizeResources.ts](monorepo/apps/app/src/VisualizeResources.ts):
`VisualizeResources.encoderLive` is an Effect `Layer<YUVTextureCommandEncoder>` — the exact service the `interface`
package's `writeYUVTextures` stream requires. Today it's a mock layer whose commands are no-ops and which classifies
every frame as kept; injecting the real backend later means swapping `createMockVisualizeResources` for
`makeWebGPULayer(device, …)` in [PrepareVisualize.vue](monorepo/apps/app/src/components/PrepareVisualize.vue) — nothing
else changes. I added `interface: workspace:*` to the app and ran `rush update` so the app reuses its
`ChromaSubsampling`/`PlaneSize` types instead of redefining them.

[Visualize.vue](monorepo/apps/app/src/components/Visualize.vue) is UI-only: lo/hi/frac sliders with `v-number-input`
steppers, video info list with a kept/dropped `v-chip`, and four empty canvases. A TODO marks where the frame stream
gets built and run against `resources.encoderLive`.

Vuetify usage: `v-app-bar` (back / About / theme cycle), `v-empty-state` + `v-progress-circular` for every loading/error
stage, `v-file-upload` with `filter-by-type` and a rejection `v-snackbar`, `v-dialog` for About, cards/lists/chips in
Visualize.

Two infrastructure fixes along the way: fonts (mdi + Roboto) 403'd because they resolve into Rush's shared store at
`common/temp/node_modules`, outside Vite's `fs.allow` — fixed in [vite.config.mts](monorepo/apps/app/vite.config.mts).
And the preview harness can't launch the server itself in a Rush repo (it insists on `pnpm install`), so
`.claude/launch.json` just attaches to `http://localhost:3000`. The dev server is still running in the background if you
want to click around.

One thing to note: the in-app browser evidently supports WebGPU, since the init stage succeeded and went straight to
upload — so real backend verification will also be possible in this setup.