import {type ChildProcessWithoutNullStreams, spawn} from "node:child_process"
import {createReadStream, existsSync} from "node:fs"
import {join} from "node:path"
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

interface MpdecimateRequest {
    readonly params?: {
        readonly lo: number
        readonly hi: number
        readonly frac: number
    }
    readonly chunk?: VideoChunk
}

interface KeptFrame {
    readonly frame_number: number
}

interface MpdecimateServiceClient extends grpc.Client {
    decimate(): grpc.ClientDuplexStream<MpdecimateRequest, KeptFrame>
}

type FrameServiceClientConstructor = new (
    address: string,
    credentials: grpc.ChannelCredentials,
) => FrameServiceClient

type MpdecimateServiceClientConstructor = new (
    address: string,
    credentials: grpc.ChannelCredentials,
) => MpdecimateServiceClient

const testDirectory = fileURLToPath(new URL(".", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url))
const serverSourceDirectory = `${repositoryRoot}/yuv_stream`
const serverExecutable = `${serverSourceDirectory}/cmake-build-debug/yuv_stream`
const mpdecimateExecutable = `${serverSourceDirectory}/cmake-build-debug/mpdecimate_server`
const protoPath = `${serverSourceDirectory}/frame_service.proto`
const mpdecimateProtoPath = `${serverSourceDirectory}/mpdecimate_service.proto`
const serverAddress = "127.0.0.1:50051"
const mpdecimateAddress = "127.0.0.1:50052"

// These must match generate-test-videos.sh, which produces the videos
// consumed here. Run it once before the tests: ./test/generate-test-videos.sh
const generatedDirectory = join(testDirectory, "generated")
const videoWidth = 64
const videoHeight = 64
const videoFrames = 12
const testCaseCount = 12
// One set of random affine color-transform videos and one set of random
// growing/shrinking circle videos, both produced by generate-test-videos.sh.
const videoPaths = ["case", "circle"].flatMap(prefix => Array.from(
    {length: testCaseCount},
    (_, index) => join(generatedDirectory, `${prefix}-${index}.mp4`),
))

interface MpdecimateParams {
    readonly lo: number
    readonly hi: number
    readonly frac: number
}

// FFmpeg's mpdecimate defaults are lo=64*5, hi=64*12, frac=0.33. The other
// sets skew towards dropping (loose) and keeping (strict) more frames.
const parameterSets: ReadonlyArray<MpdecimateParams> = [
    {lo: 320, hi: 768, frac: 0.33},
    {lo: 64, hi: 192, frac: 0.1},
    {lo: 640, hi: 1536, frac: 0.66},
    {lo: 320, hi: 768, frac: 1},
]

const testCases = videoPaths.flatMap((videoPath, videoIndex) =>
    parameterSets.map(params => ({videoPath, videoIndex, ...params})),
)

const waitForReady = (client: grpc.Client) => new Promise<void>((resolve, reject) => {
    client.waitForReady(Date.now() + 10_000, error => error ? reject(error) : resolve())
})

const writeVideo = async (call: grpc.ClientDuplexStream<VideoChunk, StreamMessage>, videoPath: string) => {
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

const expectedKeptFrames = async (
    client: MpdecimateServiceClient,
    videoPath: string,
    params: MpdecimateParams,
) => {
    const call = client.decimate()
    const result = new Promise<ReadonlyArray<number>>((resolve, reject) => {
        const frameNumbers: Array<number> = []
        call.on("data", frame => frameNumbers.push(frame.frame_number))
        call.once("error", reject)
        call.once("end", () => resolve(frameNumbers))
    })
    call.write({params})
    for await (const chunk of createReadStream(videoPath, {highWaterMark: 64 * 1024})) {
        if (!call.write({chunk: {data: chunk}})) {
            await new Promise<void>(resolve => call.once("drain", resolve))
        }
    }
    call.end()
    return result
}

const chromaSubsampling = (value: number): ChromaSubsampling => {
    switch (value) {
        case 1:
            return ChromaSubsampling.YUV444
        case 2:
            return ChromaSubsampling.YUV422
        case 3:
            return ChromaSubsampling.YUV420
        default:
            throw new Error(`Unsupported chroma subsampling enum: ${value}`)
    }
}

describe("yuv_stream → WebGPU integration", () => {
    // Kept referenced for the whole suite: Dawn's AsyncRunner keeps scheduling
    // ProcessEvents() on this instance, and letting it be garbage-collected
    // while ticks are pending crashes the process (use-after-free).
    let gpu: ReturnType<typeof create>
    let device: GPUDevice
    let server: ChildProcessWithoutNullStreams
    let mpdecimateServer: ChildProcessWithoutNullStreams
    let client: FrameServiceClient
    let mpdecimateClient: MpdecimateServiceClient

    beforeAll(async () => {
        const missing = videoPaths.filter(path => !existsSync(path))
        if (missing.length > 0) {
            throw new Error(
                `Missing pre-generated test videos (e.g. ${missing[0]}). ` +
                "Run test/generate-test-videos.sh first.",
            )
        }

        server = spawn(serverExecutable, [serverAddress])
        mpdecimateServer = spawn(mpdecimateExecutable, [mpdecimateAddress])
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
            frameservice: { FrameService: FrameServiceClientConstructor }
        }
        client = new loaded.frameservice.FrameService(
            serverAddress,
            grpc.credentials.createInsecure(),
        )
        const mpdecimateDefinition = protoLoader.loadSync(mpdecimateProtoPath, {
            keepCase: true,
            longs: Number,
            enums: Number,
            defaults: true,
            oneofs: true,
        })
        const loadedMpdecimate = grpc.loadPackageDefinition(mpdecimateDefinition) as unknown as {
            mpdecimateservice: { MpdecimateService: MpdecimateServiceClientConstructor }
        }
        mpdecimateClient = new loadedMpdecimate.mpdecimateservice.MpdecimateService(
            mpdecimateAddress,
            grpc.credentials.createInsecure(),
        )
        await Promise.all([waitForReady(client), waitForReady(mpdecimateClient)])

        Object.assign(globalThis, globals)
        gpu = create([])
        const adapter = await gpu.requestAdapter()
        if (adapter === null) throw new Error("Dawn could not find a WebGPU adapter.")
        device = await adapter.requestDevice()
    }, 30_000)

    afterAll(() => {
        client?.close()
        mpdecimateClient?.close()
        server?.kill("SIGTERM")
        mpdecimateServer?.kill("SIGTERM")
        device?.destroy()
    })

    it.each(testCases)(
        "video $videoIndex with lo=$lo hi=$hi frac=$frac matches mpdecimate",
        async ({videoPath, lo, hi, frac, videoIndex}) => {
            console.log(`${videoIndex}. ${videoPath}\nlo ${lo}, hi ${hi}, frac ${frac}`)
            const call = client.session()

            const received = receiveVideo(call)
            await writeVideo(call, videoPath)
            const messages = await received

            const metadata = messages[0]?.metadata
            if (metadata === undefined) throw new Error("The first response was not video metadata.")
            expect(metadata).toMatchObject({
                width: videoWidth,
                height: videoHeight,
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
                    chromaSubsampling: chromaSubsampling(metadata.chroma_subsampling),
                    loThreshold: lo,
                    hiThreshold: hi,
                    fraction: frac,
                })),
                Effect.runPromise,
            )

            const expected = await expectedKeptFrames(mpdecimateClient, videoPath, {lo, hi, frac})
            const actual = Array.from(processed)
                .flatMap((frame, frameNumber) => frame.isFrameKept ? [frameNumber] : [])

            expect(frames).toHaveLength(videoFrames)
            expect(processed).toHaveLength(frames.length)
            expect(actual).toEqual(expected)
            const log = actual.map(x => x.toString()).join(' ');
            console.log(log)
            expect(processed.every(frame =>
                frame.lumaSize.width === metadata.width &&
                frame.lumaSize.height === metadata.height
            )).toBe(true)
        }, 30_000)
})
