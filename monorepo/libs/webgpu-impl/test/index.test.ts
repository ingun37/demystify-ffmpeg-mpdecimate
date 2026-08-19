import {afterAll, beforeAll, describe, expect, it} from "vitest"
import {Effect, Stream} from "effect"
import {ChromaSubsampling, type IncomingYUVFrame, writeYUVTextures,} from "interface"
import {create, globals} from "webgpu"
import {WebGPUDiffTextures} from "../src/index.js"

const WIDTH = 32
const HEIGHT = 16
const LUMA_BYTE_LENGTH = WIDTH * HEIGHT
const CHROMA_WIDTH = WIDTH / 2
const CHROMA_HEIGHT = HEIGHT / 2
const CHROMA_BYTE_LENGTH = CHROMA_WIDTH * CHROMA_HEIGHT

let device: GPUDevice | undefined

const planarFrame = (y: number, u: number, v: number): IncomingYUVFrame => {
    const bytes = new Uint8Array(LUMA_BYTE_LENGTH + 2 * CHROMA_BYTE_LENGTH)
    bytes.fill(y, 0, LUMA_BYTE_LENGTH)
    bytes.fill(u, LUMA_BYTE_LENGTH, LUMA_BYTE_LENGTH + CHROMA_BYTE_LENGTH)
    bytes.fill(v, LUMA_BYTE_LENGTH + CHROMA_BYTE_LENGTH)
    return {
        videoFrameBytes: bytes,
        chromaSubsampling: ChromaSubsampling.YUV420,
        isUVInterleaved: false,
        frameWidth: WIDTH,
        frameHeight: HEIGHT,
    }
}

const interleavedFrame = (y: number, u: number, v: number): IncomingYUVFrame => {
    const bytes = new Uint8Array(LUMA_BYTE_LENGTH + 2 * CHROMA_BYTE_LENGTH)
    bytes.fill(y, 0, LUMA_BYTE_LENGTH)
    for (let index = LUMA_BYTE_LENGTH; index < bytes.length; index += 2) {
        bytes[index] = u
        bytes[index + 1] = v
    }
    return {
        videoFrameBytes: bytes,
        chromaSubsampling: ChromaSubsampling.YUV420,
        isUVInterleaved: true,
        frameWidth: WIDTH,
        frameHeight: HEIGHT,
    }
}

const runFrames = (...frames: ReadonlyArray<IncomingYUVFrame>) =>
    writeYUVTextures(Stream.fromIterable(frames)).pipe(
        Stream.runCollect,
        Effect.provide(WebGPUDiffTextures.layer(device!, device!.queue, {
            width: WIDTH,
            height: HEIGHT,
            chromaSubsampling: ChromaSubsampling.YUV420,
        })),
        Effect.runPromise,
    )

// Reads all texels of an rgba8unorm texture as [r, g, b, a] rows.
const readTexels = async (texture: GPUTexture) => {
    const bytesPerRow = 256 // The copy's minimum row alignment.
    const buffer = device!.createBuffer({
        size: bytesPerRow * texture.height,
        usage: 0x0001 | 0x0008, // MAP_READ | COPY_DST
    })
    try {
        const encoder = device!.createCommandEncoder()
        encoder.copyTextureToBuffer(
            {texture},
            {buffer, bytesPerRow},
            {width: texture.width, height: texture.height},
        )
        device!.queue.submit([encoder.finish()])
        await buffer.mapAsync(0x0001) // MAP_READ
        const bytes = new Uint8Array(buffer.getMappedRange()).slice()
        return Array.from({length: texture.height}, (_, y) =>
            Array.from({length: texture.width}, (_, x) =>
                Array.from(bytes.subarray(y * bytesPerRow + 4 * x, y * bytesPerRow + 4 * x + 4)),
            ),
        )
    } finally {
        buffer.destroy()
    }
}

describe("WebGPUDiffTextures.layer", () => {
    // Kept referenced for the whole suite: Dawn's AsyncRunner keeps scheduling
    // ProcessEvents() on this instance, and letting it be garbage-collected
    // while ticks are pending crashes the process (use-after-free).
    let gpu: ReturnType<typeof create>

    beforeAll(async () => {
        Object.assign(globalThis, globals)
        gpu = create([])
        const adapter = await gpu.requestAdapter()
        if (adapter === null) throw new Error("Dawn could not find a WebGPU adapter.")
        device = await adapter.requestDevice()
    })

    afterAll(() => {
        device?.destroy()
    })

    it("uploads planar YUV and updates the reference only after kept frames", async () => {
        const result = await runFrames(
            planarFrame(0, 0, 0),
            planarFrame(255, 255, 255),
            planarFrame(255, 255, 255),
            planarFrame(0, 0, 0),
            planarFrame(0, 0, 0),
        )

        expect(result.map(frame => frame.isFrameKept)).toEqual([
            false,
            true,
            false,
            true,
            false,
        ])
    })

    it("exposes the SAD diff textures through WebGPUDiffTextures", async () => {
        const {lumaLo, chromaLo} = await Effect.gen(function* () {
            // Frame two differs from frame one in luma only, far over hi.
            yield* writeYUVTextures(Stream.make(
                planarFrame(0, 128, 128),
                planarFrame(255, 128, 128),
            )).pipe(Stream.runDrain)
            const diff = yield* WebGPUDiffTextures
            return {
                lumaLo: yield* Effect.promise(() => readTexels(diff.lumaLo)),
                chromaLo: yield* Effect.promise(() => readTexels(diff.chromaLo)),
            }
        }).pipe(
            Effect.provide(WebGPUDiffTextures.layer(device!, device!.queue, {
                width: WIDTH,
                height: HEIGHT,
                chromaSubsampling: ChromaSubsampling.YUV420,
            })),
            Effect.runPromise,
        )

        // One texel per complete 8x8 window: 32x16 luma -> 5x3, 16x8 chroma -> 1x1.
        expect(lumaLo).toHaveLength(3)
        expect(lumaLo[0]).toHaveLength(5)
        // Every luma window differs, drawn as white.
        expect(lumaLo.flat()).toEqual(Array(15).fill([255, 255, 255, 255]))
        // The chroma planes are identical: U (G) and V (B) stay zero.
        expect(chromaLo).toEqual([[[0, 0, 0, 255]]])
    })

    it("deinterleaves UV and compares both chroma planes", async () => {
        const result = await runFrames(
            interleavedFrame(0, 0, 0),
            interleavedFrame(0, 255, 0),
            interleavedFrame(0, 255, 0),
            interleavedFrame(0, 255, 255),
            interleavedFrame(0, 255, 255),
        )

        expect(result.map(frame => frame.isFrameKept)).toEqual([
            false,
            true,
            false,
            true,
            false,
        ])
    })
})
