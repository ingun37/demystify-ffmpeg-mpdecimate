import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process"
import {createReadStream} from "node:fs"
import {fileURLToPath} from "node:url"
import * as grpc from "@grpc/grpc-js"
import * as protoLoader from "@grpc/proto-loader"
import {afterAll, beforeAll, describe, expect, it} from "vitest"
import {Effect, Stream} from "effect"
import {ChromaSubsampling, type IncomingYUVFrame, writeYUVTextures} from "interface"
import {create, globals} from "webgpu"
import {makeWebGPULayer} from "../src/index.js"

interface VideoChunk {
    readonly data: Uint8Array
}

interface VideoMetadata {
    readonly width: number
    readonly height: number
    readonly chroma_subsampling: number
    readonly uv_interleaved: boolean
    readonly pixel_format: string
}

interface Plane {
    readonly data: Buffer
    readonly width: number
    readonly height: number
    readonly bytes_per_row: number
}

interface DecodedFrame {
    readonly planes: ReadonlyArray<Plane>
}

interface StreamMessage {
    readonly metadata?: VideoMetadata
    readonly frame?: DecodedFrame
}

interface FrameServiceClient extends grpc.Client {
    session(): grpc.ClientDuplexStream<VideoChunk, StreamMessage>
}

type FrameServiceClientConstructor = new (
    address: string,
    credentials: grpc.ChannelCredentials,
) => FrameServiceClient

const testDirectory = fileURLToPath(new URL(".", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url))
const serverSourceDirectory = `${repositoryRoot}/yuv_stream`
const serverExecutable = `${serverSourceDirectory}/cmake-build-debug/yuv_stream`
const protoPath = `${serverSourceDirectory}/frame_service.proto`
const videoPath = `${testDirectory}/out.mp4`
const serverAddress = "127.0.0.1:50051"

const waitForReady = (client: grpc.Client) => new Promise<void>((resolve, reject) => {
    client.waitForReady(Date.now() + 10_000, error => error ? reject(error) : resolve())
})

const writeVideo = async (call: grpc.ClientDuplexStream<VideoChunk, StreamMessage>) => {
    for await (const chunk of createReadStream(videoPath, {highWaterMark: 64 * 1024})) {
        if (!call.write({data: chunk})) {
            await new Promise<void>(resolve => call.once("drain", resolve))
        }
    }
    call.end()
}

const receiveVideo = (call: grpc.ClientDuplexStream<VideoChunk, StreamMessage>) =>
    new Promise<ReadonlyArray<StreamMessage>>((resolve, reject) => {
        const messages: Array<StreamMessage> = []
        call.on("data", message => messages.push(message))
        call.once("error", reject)
        call.once("end", () => resolve(messages))
    })

const chromaSubsampling = (value: number): ChromaSubsampling => {
    switch (value) {
        case 1: return ChromaSubsampling.YUV444
        case 2: return ChromaSubsampling.YUV422
        case 3: return ChromaSubsampling.YUV420
        default: throw new Error(`Unsupported chroma subsampling enum: ${value}`)
    }
}

describe("yuv_stream → WebGPU integration", () => {
    let device: GPUDevice
    let server: ChildProcessWithoutNullStreams
    let client: FrameServiceClient

    beforeAll(async () => {
        server = spawn(serverExecutable, [serverAddress])
        const stderr: Array<Buffer> = []
        server.stderr.on("data", chunk => stderr.push(chunk))
        server.once("exit", code => {
            if (code !== null && code !== 0) {
                console.error(`yuv_stream exited with ${code}: ${Buffer.concat(stderr).toString()}`)
            }
        })

        const definition = protoLoader.loadSync(protoPath, {
            keepCase: true,
            longs: Number,
            enums: Number,
            defaults: true,
            oneofs: true,
        })
        const loaded = grpc.loadPackageDefinition(definition) as unknown as {
            frameservice: {FrameService: FrameServiceClientConstructor}
        }
        client = new loaded.frameservice.FrameService(
            serverAddress,
            grpc.credentials.createInsecure(),
        )
        await waitForReady(client)

        Object.assign(globalThis, globals)
        const adapter = await create([]).requestAdapter()
        if (adapter === null) throw new Error("Dawn could not find a WebGPU adapter.")
        device = await adapter.requestDevice()
    }, 30_000)

    afterAll(() => {
        client?.close()
        server?.kill("SIGTERM")
        device?.destroy()
    })

    it("decodes out.mp4 and processes every YUV frame", async () => {
        const call = client.session()
        const received = receiveVideo(call)
        await writeVideo(call)
        const messages = await received

        const metadata = messages[0]?.metadata
        if (metadata === undefined) throw new Error("The first response was not video metadata.")
        expect(metadata).toMatchObject({
            width: 64,
            height: 64,
            chroma_subsampling: 3,
            uv_interleaved: false,
            pixel_format: "yuv420p",
        })

        const frames: Array<IncomingYUVFrame> = messages.slice(1).map(message => {
            if (message.frame === undefined) throw new Error("Received metadata after frame streaming began.")
            return {
                videoFrameBytes: Buffer.concat(message.frame.planes.map(plane => plane.data)),
                chromaSubsampling: chromaSubsampling(metadata.chroma_subsampling),
                isUVInterleaved: metadata.uv_interleaved,
                frameWidth: metadata.width,
                frameHeight: metadata.height,
            }
        })

        const processed = await writeYUVTextures(Stream.fromIterable(frames)).pipe(
            Stream.runCollect,
            Effect.provide(makeWebGPULayer(device, device.queue, {
                width: metadata.width,
                height: metadata.height,
            })),
            Effect.runPromise,
        )

        expect(frames).toHaveLength(12)
        expect(processed).toHaveLength(frames.length)
        expect(processed.every(frame =>
            frame.lumaSize.width === metadata.width &&
            frame.lumaSize.height === metadata.height
        )).toBe(true)
    }, 30_000)
})
