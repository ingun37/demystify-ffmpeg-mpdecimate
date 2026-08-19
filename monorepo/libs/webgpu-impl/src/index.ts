import {Effect, Layer} from "effect"
import {
    type ChromaSubsampling,
    chromaPlaneSize,
    type InterleavedUVTextureWrite,
    type Plane,
    type PlaneSize,
    type PlaneTextureWrite,
    YUVTextureCommandEncoder,
    type YUVTextureCommandEncoderService,
    YUVTexturePipelineError,
} from "interface"

const BUFFER_COPY_DST = 0x0008
const BUFFER_COPY_SRC = 0x0004
const BUFFER_MAP_READ = 0x0001
const BUFFER_STORAGE = 0x0080
const BUFFER_UNIFORM = 0x0040
const TEXTURE_COPY_DST = 0x0002
const TEXTURE_COPY_SRC = 0x0001
const TEXTURE_STORAGE = 0x0008
const TEXTURE_BINDING = 0x0004
const MAP_READ = 0x0001
const WORKGROUP_SIZE = 8
// One vec4<u32> of per-channel nonzero counts for each SAD output texture.
const COUNT_BYTE_LENGTH = 4 * Uint32Array.BYTES_PER_ELEMENT
const COUNT_TARGET_COUNT = 4
const READBACK_BYTE_LENGTH = COUNT_TARGET_COUNT * COUNT_BYTE_LENGTH

export interface WebGPUBackendOptions {
    readonly width: number
    readonly height: number
    /** Every incoming frame must use this subsampling scheme. */
    readonly chromaSubsampling: ChromaSubsampling
    /** FFmpeg's `lo` value. */
    readonly loThreshold?: number
    /** FFmpeg's `hi` value. */
    readonly hiThreshold?: number
    /** FFmpeg's `frac` value. */
    readonly fraction?: number
}

interface TextureSet {
    readonly y: GPUTexture
    readonly u: GPUTexture
    readonly v: GPUTexture
}

interface PlaneResources {
    readonly uploadBuffer: GPUBuffer
    readonly sizeBuffer: GPUBuffer
    readonly uploadBindGroup: GPUBindGroup
}

interface CountTarget {
    readonly texture: GPUTexture
    readonly countBuffer: GPUBuffer
    readonly bindGroup: GPUBindGroup
}

interface WebGPUResources {
    readonly current: TextureSet
    readonly reference: TextureSet
    readonly lumaSize: PlaneSize
    readonly chromaSize: PlaneSize
    readonly planes: Readonly<Record<Plane, PlaneResources>>
    readonly uvUploadBuffer: GPUBuffer
    readonly uvSizeBuffer: GPUBuffer
    readonly uvUploadBindGroup: GPUBindGroup
    readonly uploadPipeline: GPUComputePipeline
    readonly uvUploadPipeline: GPUComputePipeline
    readonly lumaSadPipeline: GPUComputePipeline
    readonly chromaSadPipeline: GPUComputePipeline
    readonly lumaSadBindGroup: GPUBindGroup
    readonly chromaSadBindGroup: GPUBindGroup
    readonly comparisonParameters: GPUBuffer
    readonly lumaWindowSize: PlaneSize
    readonly chromaWindowSize: PlaneSize
    /** SAD-thresholded luma windows over `lo`, white where different. */
    readonly lumaLoTexture: GPUTexture
    /** SAD-thresholded luma windows over `hi`, white where different. */
    readonly lumaHiTexture: GPUTexture
    /** SAD-thresholded chroma windows over `lo`; U in G, V in B. */
    readonly chromaLoTexture: GPUTexture
    /** SAD-thresholded chroma windows over `hi`; U in G, V in B. */
    readonly chromaHiTexture: GPUTexture
    readonly countPipeline: GPUComputePipeline
    /** Nonzero counting order: luma lo, luma hi, chroma lo, chroma hi. */
    readonly countTargets: ReadonlyArray<CountTarget>
    readonly countReadback: GPUBuffer
    readonly textures: ReadonlyArray<GPUTexture>
    readonly buffers: ReadonlyArray<GPUBuffer>
}

const uploadShader = `
@group(0) @binding(0) var<storage, read> bytes: array<u32>;
@group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> source_width: u32;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(output);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let index = id.y * source_width + id.x;
  let packed = bytes[index >> 2u];
  let shift = (index & 3u) * 8u;
  let sample = f32((packed >> shift) & 0xffu) / 255.0;
  textureStore(output, vec2<i32>(id.xy), vec4<f32>(sample, 0.0, 0.0, 1.0));
}`

const uvUploadShader = `
@group(0) @binding(0) var<storage, read> bytes: array<u32>;
@group(0) @binding(1) var u_output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var v_output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> source_width: u32;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(u_output);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let index = id.y * source_width + id.x;
  let packed = bytes[index >> 1u];
  let shift = (index & 1u) * 16u;
  let u = f32((packed >> shift) & 0xffu) / 255.0;
  let v = f32((packed >> (shift + 8u)) & 0xffu) / 255.0;
  textureStore(u_output, vec2<i32>(id.xy), vec4<f32>(u, 0.0, 0.0, 1.0));
  textureStore(v_output, vec2<i32>(id.xy), vec4<f32>(v, 0.0, 0.0, 1.0));
}`

const sadShaderCommon = `
struct Parameters {
  lo: i32,
  hi: i32,
  luma_width: u32,
  luma_height: u32,
  chroma_width: u32,
  chroma_height: u32,
};

fn sad(current: texture_2d<f32>, reference: texture_2d<f32>, origin: vec2<u32>) -> u32 {
  // Accumulate in integers so a SAD exactly equal to lo/hi ties the way
  // FFmpeg's strict > does, instead of drifting by float rounding.
  var total = 0u;
  for (var y = 0u; y < 8u; y++) {
    for (var x = 0u; x < 8u; x++) {
      let position = origin + vec2<u32>(x, y);
      let a = u32(textureLoad(current, position, 0).r * 255.0 + 0.5);
      let b = u32(textureLoad(reference, position, 0).r * 255.0 + 0.5);
      total += max(a, b) - min(a, b);
    }
  }
  return total;
}

fn passes_threshold(value: u32, threshold: i32) -> f32 {
  // FFmpeg reports a difference only when the SAD is strictly greater.
  return select(0.0, 1.0, value > u32(threshold));
}

// FFmpeg scans complete 8x8 windows at x=8,12,... and y=0,4,... .
fn window_output_size(size: vec2<u32>) -> vec2<u32> {
  return vec2<u32>((size.x - 16u) / 4u + 1u, (size.y - 8u) / 4u + 1u);
}`

// One texel per complete 8x8 luma window; the threshold result is white.
const lumaSadShader = `${sadShaderCommon}
@group(0) @binding(0) var current_y: texture_2d<f32>;
@group(0) @binding(1) var reference_y: texture_2d<f32>;
@group(0) @binding(2) var<uniform> parameters: Parameters;
@group(0) @binding(3) var lo_out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var hi_out: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let outputSize = window_output_size(vec2<u32>(parameters.luma_width, parameters.luma_height));
  if (id.x >= outputSize.x || id.y >= outputSize.y) { return; }
  let value = sad(current_y, reference_y, vec2<u32>(8u, 0u) + id.xy * 4u);
  let lo = passes_threshold(value, parameters.lo);
  let hi = passes_threshold(value, parameters.hi);
  textureStore(lo_out, vec2<i32>(id.xy), vec4<f32>(lo, lo, lo, 1.0));
  textureStore(hi_out, vec2<i32>(id.xy), vec4<f32>(hi, hi, hi, 1.0));
}`

// U and V share dimensions, so their aligned windows land in G and B.
const chromaSadShader = `${sadShaderCommon}
@group(0) @binding(0) var current_u: texture_2d<f32>;
@group(0) @binding(1) var reference_u: texture_2d<f32>;
@group(0) @binding(2) var current_v: texture_2d<f32>;
@group(0) @binding(3) var reference_v: texture_2d<f32>;
@group(0) @binding(4) var<uniform> parameters: Parameters;
@group(0) @binding(5) var lo_out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(6) var hi_out: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let outputSize = window_output_size(vec2<u32>(parameters.chroma_width, parameters.chroma_height));
  if (id.x >= outputSize.x || id.y >= outputSize.y) { return; }
  let origin = vec2<u32>(8u, 0u) + id.xy * 4u;
  let u_value = sad(current_u, reference_u, origin);
  let v_value = sad(current_v, reference_v, origin);
  let lo_u = passes_threshold(u_value, parameters.lo);
  let lo_v = passes_threshold(v_value, parameters.lo);
  let hi_u = passes_threshold(u_value, parameters.hi);
  let hi_v = passes_threshold(v_value, parameters.hi);
  textureStore(lo_out, vec2<i32>(id.xy), vec4<f32>(0.0, lo_u, lo_v, 1.0));
  textureStore(hi_out, vec2<i32>(id.xy), vec4<f32>(0.0, hi_u, hi_v, 1.0));
}`

const nonzeroCountShader = `
@group(0) @binding(0) var input_texture: texture_2d<f32>;
// Four u32 values, in RGBA order. WGSL does not permit atomic vector
// components, so this buffer is the atomic representation of a vec4<u32>.
// Clear all four values to zero before dispatching this shader.
@group(0) @binding(1) var<storage, read_write> nonzero_counts: array<atomic<u32>, 4>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(input_texture);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let pixel = textureLoad(input_texture, id.xy, 0);
  if (pixel.r != 0.0) { atomicAdd(&nonzero_counts[0], 1u); }
  if (pixel.g != 0.0) { atomicAdd(&nonzero_counts[1], 1u); }
  if (pixel.b != 0.0) { atomicAdd(&nonzero_counts[2], 1u); }
  if (pixel.a != 0.0) { atomicAdd(&nonzero_counts[3], 1u); }
}`

const pipelineError = (message: string, cause?: unknown) =>
    new YUVTexturePipelineError({message, cause})

const validateOptions = (options: WebGPUBackendOptions) => {
    const loThreshold = options.loThreshold ?? 64 * 5
    const hiThreshold = options.hiThreshold ?? 64 * 12
    const fraction = options.fraction ?? 0.33
    if (!Number.isSafeInteger(options.width) || options.width < 16 ||
        !Number.isSafeInteger(options.height) || options.height < 8) {
        throw new Error("Frame dimensions must be safe integers and at least 16x8.")
    }
    if (!Number.isSafeInteger(loThreshold) || !Number.isSafeInteger(hiThreshold)) {
        throw new Error("The lo and hi thresholds must be safe integers.")
    }
    if (!Number.isFinite(fraction) || fraction < 0) {
        throw new Error("The fraction must be a finite non-negative number.")
    }
    return {loThreshold, hiThreshold, fraction}
}

const alignedBufferSize = (byteLength: number) => Math.ceil(byteLength / 4) * 4
const writePackedBytes = (queue: GPUQueue, buffer: GPUBuffer, bytes: Uint8Array<ArrayBufferLike>) => {
    if (bytes.byteLength % 4 === 0) {
        queue.writeBuffer(buffer, 0, bytes)
        return
    }
    const padded = new Uint8Array(alignedBufferSize(bytes.byteLength))
    padded.set(bytes)
    queue.writeBuffer(buffer, 0, padded)
}
const dispatch = (pass: GPUComputePassEncoder, size: PlaneSize) =>
    pass.dispatchWorkgroups(
        Math.ceil(size.width / WORKGROUP_SIZE),
        Math.ceil(size.height / WORKGROUP_SIZE),
    )

// FFmpeg scans complete 8x8 windows at x=8,12,... and y=0,4,... .
const sadWindowOutputSize = (size: PlaneSize): PlaneSize => ({
    width: Math.floor((size.width - 16) / 4) + 1,
    height: Math.floor((size.height - 8) / 4) + 1,
})

const makeResources = (
    device: GPUDevice,
    options: WebGPUBackendOptions,
): WebGPUResources => {
    const {loThreshold, hiThreshold} = validateOptions(options)
    const lumaSize = {width: options.width, height: options.height}
    const chromaSize = chromaPlaneSize(
        options.chromaSubsampling,
        options.width,
        options.height,
    )
    if (chromaSize.width < 16 || chromaSize.height < 8) {
        throw new Error("SAD thresholding requires chroma planes of at least 16x8.")
    }
    const textures: GPUTexture[] = []
    const buffers: GPUBuffer[] = []
    const textureUsage = TEXTURE_BINDING | TEXTURE_STORAGE | TEXTURE_COPY_SRC | TEXTURE_COPY_DST
    const makeTexture = (size: PlaneSize) => {
        const texture = device.createTexture({size, format: "rgba8unorm", usage: textureUsage})
        textures.push(texture)
        return texture
    }
    const makeSet = (): TextureSet => ({
        y: makeTexture(lumaSize),
        u: makeTexture(chromaSize),
        v: makeTexture(chromaSize),
    })
    const makeBuffer = (descriptor: GPUBufferDescriptor) => {
        const buffer = device.createBuffer(descriptor)
        buffers.push(buffer)
        return buffer
    }

    try {
        const current = makeSet()
        const reference = makeSet()
        const uploadPipeline = device.createComputePipeline({
            layout: "auto",
            compute: {module: device.createShaderModule({code: uploadShader}), entryPoint: "main"},
        })
        const uvUploadPipeline = device.createComputePipeline({
            layout: "auto",
            compute: {module: device.createShaderModule({code: uvUploadShader}), entryPoint: "main"},
        })
        const lumaSadPipeline = device.createComputePipeline({
            layout: "auto",
            compute: {module: device.createShaderModule({code: lumaSadShader}), entryPoint: "main"},
        })
        const chromaSadPipeline = device.createComputePipeline({
            layout: "auto",
            compute: {module: device.createShaderModule({code: chromaSadShader}), entryPoint: "main"},
        })
        const countPipeline = device.createComputePipeline({
            layout: "auto",
            compute: {module: device.createShaderModule({code: nonzeroCountShader}), entryPoint: "main"},
        })
        const planeEntries = (["Y", "U", "V"] as const).map(plane => {
            const size = plane === "Y" ? lumaSize : chromaSize
            const uploadBuffer = makeBuffer({
                size: alignedBufferSize(size.width * size.height),
                usage: BUFFER_STORAGE | BUFFER_COPY_DST,
            })
            const sizeBuffer = makeBuffer({size: 4, usage: BUFFER_UNIFORM | BUFFER_COPY_DST})
            device.queue.writeBuffer(sizeBuffer, 0, new Uint32Array([size.width]))
            const texture = plane === "Y" ? current.y : plane === "U" ? current.u : current.v
            const uploadBindGroup = device.createBindGroup({
                layout: uploadPipeline.getBindGroupLayout(0),
                entries: [
                    {binding: 0, resource: {buffer: uploadBuffer}},
                    {binding: 1, resource: texture.createView()},
                    {binding: 2, resource: {buffer: sizeBuffer}},
                ],
            })
            return [plane, {uploadBuffer, sizeBuffer, uploadBindGroup}] as const
        })
        const planes = Object.fromEntries(planeEntries) as unknown as Readonly<Record<Plane, PlaneResources>>
        const uvUploadBuffer = makeBuffer({
            size: alignedBufferSize(2 * chromaSize.width * chromaSize.height),
            usage: BUFFER_STORAGE | BUFFER_COPY_DST,
        })
        const uvSizeBuffer = makeBuffer({size: 4, usage: BUFFER_UNIFORM | BUFFER_COPY_DST})
        const uvUploadBindGroup = device.createBindGroup({
            layout: uvUploadPipeline.getBindGroupLayout(0),
            entries: [
                {binding: 0, resource: {buffer: uvUploadBuffer}},
                {binding: 1, resource: current.u.createView()},
                {binding: 2, resource: current.v.createView()},
                {binding: 3, resource: {buffer: uvSizeBuffer}},
            ],
        })
        const comparisonParameters = makeBuffer({size: 32, usage: BUFFER_UNIFORM | BUFFER_COPY_DST})
        const initialParameters = new ArrayBuffer(24)
        new Int32Array(initialParameters, 0, 2).set([loThreshold, hiThreshold])
        new Uint32Array(initialParameters, 8, 4).set([
            lumaSize.width, lumaSize.height, chromaSize.width, chromaSize.height,
        ])
        device.queue.writeBuffer(comparisonParameters, 0, initialParameters)

        const lumaWindowSize = sadWindowOutputSize(lumaSize)
        const chromaWindowSize = sadWindowOutputSize(chromaSize)
        const lumaLoTexture = makeTexture(lumaWindowSize)
        const lumaHiTexture = makeTexture(lumaWindowSize)
        const chromaLoTexture = makeTexture(chromaWindowSize)
        const chromaHiTexture = makeTexture(chromaWindowSize)

        const lumaSadBindGroup = device.createBindGroup({
            layout: lumaSadPipeline.getBindGroupLayout(0),
            entries: [
                {binding: 0, resource: current.y.createView()},
                {binding: 1, resource: reference.y.createView()},
                {binding: 2, resource: {buffer: comparisonParameters}},
                {binding: 3, resource: lumaLoTexture.createView()},
                {binding: 4, resource: lumaHiTexture.createView()},
            ],
        })
        const chromaSadBindGroup = device.createBindGroup({
            layout: chromaSadPipeline.getBindGroupLayout(0),
            entries: [
                {binding: 0, resource: current.u.createView()},
                {binding: 1, resource: reference.u.createView()},
                {binding: 2, resource: current.v.createView()},
                {binding: 3, resource: reference.v.createView()},
                {binding: 4, resource: {buffer: comparisonParameters}},
                {binding: 5, resource: chromaLoTexture.createView()},
                {binding: 6, resource: chromaHiTexture.createView()},
            ],
        })

        const makeCountTarget = (texture: GPUTexture): CountTarget => {
            const countBuffer = makeBuffer({
                size: COUNT_BYTE_LENGTH,
                usage: BUFFER_STORAGE | BUFFER_COPY_SRC | BUFFER_COPY_DST,
            })
            const bindGroup = device.createBindGroup({
                layout: countPipeline.getBindGroupLayout(0),
                entries: [
                    {binding: 0, resource: texture.createView()},
                    {binding: 1, resource: {buffer: countBuffer}},
                ],
            })
            return {texture, countBuffer, bindGroup}
        }
        const countTargets = [
            makeCountTarget(lumaLoTexture),
            makeCountTarget(lumaHiTexture),
            makeCountTarget(chromaLoTexture),
            makeCountTarget(chromaHiTexture),
        ]
        const countReadback = makeBuffer({
            size: READBACK_BYTE_LENGTH,
            usage: BUFFER_MAP_READ | BUFFER_COPY_DST,
        })

        return {
            current, reference, lumaSize, chromaSize, planes, uvUploadBuffer, uvSizeBuffer,
            uvUploadBindGroup, uploadPipeline, uvUploadPipeline,
            lumaSadPipeline, chromaSadPipeline, lumaSadBindGroup, chromaSadBindGroup,
            comparisonParameters, lumaWindowSize, chromaWindowSize,
            lumaLoTexture, lumaHiTexture, chromaLoTexture, chromaHiTexture,
            countPipeline, countTargets, countReadback,
            textures, buffers,
        }
    } catch (cause) {
        for (const texture of textures) texture.destroy()
        for (const buffer of buffers) buffer.destroy()
        throw cause
    }
}

const acquireResources = (
    device: GPUDevice,
    options: WebGPUBackendOptions,
) => Effect.acquireRelease(
    Effect.try({
        try: () => makeResources(device, options),
        catch: cause => pipelineError("Could not create WebGPU resources.", cause),
    }),
    resources => Effect.sync(() => {
        for (const texture of resources.textures) texture.destroy()
        for (const buffer of resources.buffers) buffer.destroy()
    }),
)

const assertSize = (actual: PlaneSize, expected: PlaneSize, label: string) => {
    if (actual.width !== expected.width || actual.height !== expected.height) {
        throw new Error(`${label} size ${actual.width}x${actual.height} does not match backend size ${expected.width}x${expected.height}.`)
    }
}

const encodeUpload = (
    queue: GPUQueue,
    encoder: GPUCommandEncoder,
    resources: WebGPUResources,
    input: PlaneTextureWrite,
) => {
    const expected = input.plane === "Y" ? resources.lumaSize : resources.chromaSize
    assertSize(input.size, expected, input.plane)
    if (input.bytes.byteLength !== input.size.width * input.size.height) {
        throw new Error(`${input.plane} byte length does not match its dimensions.`)
    }
    const plane = resources.planes[input.plane]
    queue.writeBuffer(plane.sizeBuffer, 0, new Uint32Array([input.size.width]))
    writePackedBytes(queue, plane.uploadBuffer, input.bytes)
    const pass = encoder.beginComputePass()
    pass.setPipeline(resources.uploadPipeline)
    pass.setBindGroup(0, plane.uploadBindGroup)
    dispatch(pass, input.size)
    pass.end()
}

const makeService = (
    device: GPUDevice,
    queue: GPUQueue,
    resources: WebGPUResources,
    options: WebGPUBackendOptions,
): YUVTextureCommandEncoderService => ({
    submit: record => Effect.gen(function* () {
        const encoder = device.createCommandEncoder()
        let isChromaUploaded = false
        const result = yield* record({
            enqueuePlaneWrite: input => Effect.try({
                try: () => {
                    encodeUpload(queue, encoder, resources, input)
                    if (input.plane !== "Y") isChromaUploaded = true
                },
                catch: cause => pipelineError(`Could not enqueue the ${input.plane} texture write.`, cause),
            }),
            enqueueUVDeinterleave: (input: InterleavedUVTextureWrite) => Effect.try({
                try: () => {
                    assertSize(input.size, resources.chromaSize, "UV")
                    if (input.bytes.byteLength !== 2 * input.size.width * input.size.height) {
                        throw new Error("UV byte length does not match its dimensions.")
                    }
                    writePackedBytes(queue, resources.uvUploadBuffer, input.bytes)
                    queue.writeBuffer(resources.uvSizeBuffer, 0, new Uint32Array([input.size.width]))
                    const pass = encoder.beginComputePass()
                    pass.setPipeline(resources.uvUploadPipeline)
                    pass.setBindGroup(0, resources.uvUploadBindGroup)
                    dispatch(pass, input.size)
                    pass.end()
                    isChromaUploaded = true
                },
                catch: cause => pipelineError("Could not enqueue UV deinterleaving.", cause),
            }),
            enqueueComparison: () => Effect.try({
                try: () => {
                    if (!isChromaUploaded) throw new Error("No chroma plane was uploaded.")

                    // Write the diff-thresholded windows into the SAD textures.
                    const sadPass = encoder.beginComputePass()
                    sadPass.setPipeline(resources.lumaSadPipeline)
                    sadPass.setBindGroup(0, resources.lumaSadBindGroup)
                    dispatch(sadPass, resources.lumaWindowSize)
                    sadPass.setPipeline(resources.chromaSadPipeline)
                    sadPass.setBindGroup(0, resources.chromaSadBindGroup)
                    dispatch(sadPass, resources.chromaWindowSize)
                    sadPass.end()

                    // Count each SAD texture's nonzero texels separately.
                    for (const target of resources.countTargets) {
                        encoder.clearBuffer(target.countBuffer)
                    }
                    const countPass = encoder.beginComputePass()
                    countPass.setPipeline(resources.countPipeline)
                    for (const target of resources.countTargets) {
                        countPass.setBindGroup(0, target.bindGroup)
                        dispatch(countPass, {width: target.texture.width, height: target.texture.height})
                    }
                    countPass.end()
                    resources.countTargets.forEach((target, index) => {
                        encoder.copyBufferToBuffer(
                            target.countBuffer, 0,
                            resources.countReadback, index * COUNT_BYTE_LENGTH,
                            COUNT_BYTE_LENGTH,
                        )
                    })

                    return {
                        read: Effect.tryPromise({
                            try: async () => {
                                await resources.countReadback.mapAsync(MAP_READ)
                                try {
                                    // Layout: [lumaLo, lumaHi, chromaLo, chromaHi]
                                    // RGBA counts; luma lives in R, U in G, V in B.
                                    const counts = new Uint32Array(resources.countReadback.getMappedRange())
                                    const lumaLoCount = counts[0] ?? 0
                                    const lumaHiCount = counts[4] ?? 0
                                    const uLoCount = counts[9] ?? 0
                                    const vLoCount = counts[10] ?? 0
                                    const uHiCount = counts[13] ?? 0
                                    const vHiCount = counts[14] ?? 0
                                    const lumaLoLimit = Math.trunc(
                                        Math.floor(resources.lumaSize.width / 16) *
                                        Math.floor(resources.lumaSize.height / 16) *
                                        (options.fraction ?? 0.33),
                                    )
                                    const chromaLoLimit = Math.trunc(
                                        Math.floor(resources.chromaSize.width / 16) *
                                        Math.floor(resources.chromaSize.height / 16) *
                                        (options.fraction ?? 0.33),
                                    )
                                    return {
                                        isFrameKept: lumaHiCount > 0 ||
                                            uHiCount > 0 || vHiCount > 0 ||
                                            lumaLoCount > lumaLoLimit ||
                                            uLoCount > chromaLoLimit ||
                                            vLoCount > chromaLoLimit,
                                        luma: {overLo: lumaLoCount, overHi: lumaHiCount},
                                        u: {overLo: uLoCount, overHi: uHiCount},
                                        v: {overLo: vLoCount, overHi: vHiCount},
                                        lumaLoLimit,
                                        chromaLoLimit,
                                    }
                                } finally {
                                    resources.countReadback.unmap()
                                }
                            },
                            catch: cause => pipelineError("Could not read the frame comparison result.", cause),
                        }),
                    }
                },
                catch: cause => pipelineError("Could not enqueue frame comparison.", cause),
            }),
            enqueueReferenceCopy: () => Effect.try({
                try: () => {
                    for (const plane of ["Y", "U", "V"] as const) {
                        const size = plane === "Y" ? resources.lumaSize : resources.chromaSize
                        const key = plane === "Y" ? "y" : plane === "U" ? "u" : "v"
                        encoder.copyTextureToTexture(
                            {texture: resources.current[key]},
                            {texture: resources.reference[key]},
                            size,
                        )
                    }
                },
                catch: cause => pipelineError("Could not enqueue the reference texture copy.", cause),
            }),
        })
        yield* Effect.try({
            try: () => queue.submit([encoder.finish()]),
            catch: cause => pipelineError("Could not submit WebGPU commands.", cause),
        })
        return result
    }),
})

/**
 * A scoped WebGPU implementation of `YUVTextureCommandEncoder`.
 *
 * The layer owns one current and one reference texture per Y/U/V plane. The
 * reference set is updated only after the interface pipeline keeps a frame.
 *
 * Comparison mirrors the web visualizer: SAD-threshold shaders write the
 * diff-thresholded windows into intermediate lo/hi textures (luma as white,
 * chroma with U in G and V in B), and a separate compute shader counts each
 * texture's nonzero texels. The intermediate textures stay alive between
 * frames so they can be blitted for visualization.
 */
export const makeWebGPULayer = (
    device: GPUDevice,
    queue: GPUQueue,
    options: WebGPUBackendOptions,
) => Layer.effect(YUVTextureCommandEncoder)(
    acquireResources(device, options).pipe(
        Effect.map(resources => makeService(device, queue, resources, options)),
    ),
)
