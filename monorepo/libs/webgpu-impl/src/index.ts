import {Effect, Layer} from "effect"
import {
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
const COUNT_BYTE_LENGTH = 6 * Uint32Array.BYTES_PER_ELEMENT

export interface WebGPUBackendOptions {
    readonly width: number
    readonly height: number
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
    readonly comparisonPipeline: GPUComputePipeline
    readonly comparisonBindGroup: GPUBindGroup
    readonly comparisonParameters: GPUBuffer
    readonly comparisonCounts: GPUBuffer
    readonly comparisonReadback: GPUBuffer
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

const comparisonShader = `
struct Parameters {
  lo: i32,
  hi: i32,
  luma_width: u32,
  luma_height: u32,
  chroma_width: u32,
  chroma_height: u32,
};
@group(0) @binding(0) var current_y: texture_2d<f32>;
@group(0) @binding(1) var reference_y: texture_2d<f32>;
@group(0) @binding(2) var current_u: texture_2d<f32>;
@group(0) @binding(3) var reference_u: texture_2d<f32>;
@group(0) @binding(4) var current_v: texture_2d<f32>;
@group(0) @binding(5) var reference_v: texture_2d<f32>;
@group(0) @binding(6) var<uniform> parameters: Parameters;
// luma lo/hi, U lo/hi, V lo/hi
@group(0) @binding(7) var<storage, read_write> counts: array<atomic<u32>, 6>;

fn sad(current: texture_2d<f32>, reference: texture_2d<f32>, origin: vec2<u32>) -> f32 {
  var total = 0.0;
  for (var y = 0u; y < 8u; y++) {
    for (var x = 0u; x < 8u; x++) {
      let position = origin + vec2<u32>(x, y);
      total += abs(textureLoad(current, position, 0).r - textureLoad(reference, position, 0).r) * 255.0;
    }
  }
  return total;
}

fn countPlane(
  current: texture_2d<f32>,
  reference: texture_2d<f32>,
  id: vec2<u32>,
  loIndex: u32,
  size: vec2<u32>,
) {
  // FFmpeg scans complete 8x8 windows at x=8,12,... and y=0,4,... .
  let outputSize = vec2<u32>((size.x - 16u) / 4u + 1u, (size.y - 8u) / 4u + 1u);
  if (id.x >= outputSize.x || id.y >= outputSize.y) { return; }
  let value = sad(current, reference, vec2<u32>(8u, 0u) + id * 4u);
  if (value > f32(parameters.lo)) { atomicAdd(&counts[loIndex], 1u); }
  if (value > f32(parameters.hi)) { atomicAdd(&counts[loIndex + 1u], 1u); }
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let lumaSize = vec2<u32>(parameters.luma_width, parameters.luma_height);
  let chromaSize = vec2<u32>(parameters.chroma_width, parameters.chroma_height);
  countPlane(current_y, reference_y, id.xy, 0u, lumaSize);
  countPlane(current_u, reference_u, id.xy, 2u, chromaSize);
  countPlane(current_v, reference_v, id.xy, 4u, chromaSize);
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

const makeResources = (
    device: GPUDevice,
    options: WebGPUBackendOptions,
): WebGPUResources => {
    const {loThreshold, hiThreshold} = validateOptions(options)
    const lumaSize = {width: options.width, height: options.height}
    // Allocate chroma at full resolution so one layer supports 4:2:0, 4:2:2,
    // and 4:4:4 streams. Commands only address the frame's actual UV extent.
    const chromaSize = lumaSize
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
        const comparisonPipeline = device.createComputePipeline({
            layout: "auto",
            compute: {module: device.createShaderModule({code: comparisonShader}), entryPoint: "main"},
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
        const comparisonCounts = makeBuffer({
            size: COUNT_BYTE_LENGTH,
            usage: BUFFER_STORAGE | BUFFER_COPY_SRC | BUFFER_COPY_DST,
        })
        const comparisonReadback = makeBuffer({
            size: COUNT_BYTE_LENGTH,
            usage: BUFFER_MAP_READ | BUFFER_COPY_DST,
        })
        const comparisonBindGroup = device.createBindGroup({
            layout: comparisonPipeline.getBindGroupLayout(0),
            entries: [
                {binding: 0, resource: current.y.createView()},
                {binding: 1, resource: reference.y.createView()},
                {binding: 2, resource: current.u.createView()},
                {binding: 3, resource: reference.u.createView()},
                {binding: 4, resource: current.v.createView()},
                {binding: 5, resource: reference.v.createView()},
                {binding: 6, resource: {buffer: comparisonParameters}},
                {binding: 7, resource: {buffer: comparisonCounts}},
            ],
        })
        return {
            current, reference, lumaSize, chromaSize, planes, uvUploadBuffer, uvSizeBuffer,
            uvUploadBindGroup, uploadPipeline, uvUploadPipeline, comparisonPipeline,
            comparisonBindGroup, comparisonParameters, comparisonCounts,
            comparisonReadback, textures, buffers,
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
    const expected = input.plane === "Y" ? resources.lumaSize : input.size
    if (input.plane === "Y") assertSize(input.size, expected, input.plane)
    if (input.bytes.byteLength !== input.size.width * input.size.height) {
        throw new Error(`${input.plane} byte length does not match its dimensions.`)
    }
    if (input.size.width > resources.chromaSize.width || input.size.height > resources.chromaSize.height) {
        throw new Error(`${input.plane} plane is larger than the backend textures.`)
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
        let comparisonSize: PlaneSize | undefined
        const result = yield* record({
            enqueuePlaneWrite: input => Effect.try({
                try: () => {
                    encodeUpload(queue, encoder, resources, input)
                    if (input.plane !== "Y") comparisonSize = input.size
                },
                catch: cause => pipelineError(`Could not enqueue the ${input.plane} texture write.`, cause),
            }),
            enqueueUVDeinterleave: (input: InterleavedUVTextureWrite) => Effect.try({
                try: () => {
                    if (input.bytes.byteLength !== 2 * input.size.width * input.size.height) {
                        throw new Error("UV byte length does not match its dimensions.")
                    }
                    if (input.size.width > resources.chromaSize.width || input.size.height > resources.chromaSize.height) {
                        throw new Error("UV plane is larger than the backend textures.")
                    }
                    writePackedBytes(queue, resources.uvUploadBuffer, input.bytes)
                    queue.writeBuffer(resources.uvSizeBuffer, 0, new Uint32Array([input.size.width]))
                    const pass = encoder.beginComputePass()
                    pass.setPipeline(resources.uvUploadPipeline)
                    pass.setBindGroup(0, resources.uvUploadBindGroup)
                    dispatch(pass, input.size)
                    pass.end()
                    comparisonSize = input.size
                },
                catch: cause => pipelineError("Could not enqueue UV deinterleaving.", cause),
            }),
            enqueueComparison: () => Effect.try({
                try: () => {
                    if (comparisonSize === undefined) throw new Error("No chroma plane was uploaded.")
                    if (comparisonSize.width < 16 || comparisonSize.height < 8) {
                        throw new Error("SAD thresholding requires every plane to be at least 16x8.")
                    }
                    queue.writeBuffer(
                        resources.comparisonParameters,
                        16,
                        new Uint32Array([comparisonSize.width, comparisonSize.height]),
                    )
                    encoder.clearBuffer(resources.comparisonCounts)
                    const pass = encoder.beginComputePass()
                    pass.setPipeline(resources.comparisonPipeline)
                    pass.setBindGroup(0, resources.comparisonBindGroup)
                    dispatch(pass, resources.lumaSize)
                    pass.end()
                    encoder.copyBufferToBuffer(
                        resources.comparisonCounts, 0,
                        resources.comparisonReadback, 0,
                        COUNT_BYTE_LENGTH,
                    )
                    const size = comparisonSize
                    return {
                        read: Effect.tryPromise({
                            try: async () => {
                                await resources.comparisonReadback.mapAsync(MAP_READ)
                                try {
                                    const counts = new Uint32Array(resources.comparisonReadback.getMappedRange())
                                    const lumaLimit = Math.trunc(
                                        Math.floor(resources.lumaSize.width / 16) *
                                        Math.floor(resources.lumaSize.height / 16) *
                                        (options.fraction ?? 0.33),
                                    )
                                    const chromaLimit = Math.trunc(
                                        Math.floor(size.width / 16) * Math.floor(size.height / 16) *
                                        (options.fraction ?? 0.33),
                                    )
                                    return {
                                        isFrameKept: (counts[1] ?? 0) > 0 ||
                                            (counts[3] ?? 0) > 0 || (counts[5] ?? 0) > 0 ||
                                            (counts[0] ?? 0) > lumaLimit ||
                                            (counts[2] ?? 0) > chromaLimit ||
                                            (counts[4] ?? 0) > chromaLimit,
                                    }
                                } finally {
                                    resources.comparisonReadback.unmap()
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
