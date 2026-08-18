import {afterAll, beforeAll, describe, expect, it} from "vitest"
import {Effect, Stream} from "effect"
import {ChromaSubsampling, type IncomingYUVFrame, writeYUVTextures,} from "interface"
import {create, globals} from "webgpu"
import {makeWebGPULayer} from "../src/index.js"

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
        Effect.provide(makeWebGPULayer(device!, device!.queue, {
            width: WIDTH,
            height: HEIGHT,
        })),
        Effect.runPromise,
    )

describe("makeWebGPULayer", () => {
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
