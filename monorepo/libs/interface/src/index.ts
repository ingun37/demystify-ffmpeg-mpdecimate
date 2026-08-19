import {Context, Data, Effect, Stream} from "effect"

export enum ChromaSubsampling {
    YUV420 = "4:2:0",
    YUV422 = "4:2:2",
    YUV444 = "4:4:4",
}

/** A tightly-packed YUV frame supplied by a library user. */
export interface IncomingYUVFrame {
    readonly videoFrameBytes: Uint8Array<ArrayBufferLike>
    readonly chromaSubsampling: ChromaSubsampling
    readonly isUVInterleaved: boolean
    readonly frameWidth: number
    readonly frameHeight: number
}

export type Plane = "Y" | "U" | "V"

export interface PlaneSize {
    readonly width: number
    readonly height: number
}

export interface PlaneTextureWrite {
    readonly plane: Plane
    readonly bytes: Uint8Array<ArrayBufferLike>
    readonly size: PlaneSize
}

export interface InterleavedUVTextureWrite {
    readonly bytes: Uint8Array<ArrayBufferLike>
    readonly size: PlaneSize
}

/** How many 8x8 SAD windows of one plane exceeded each threshold. */
export interface PlaneDiffCounts {
    readonly overLo: number
    readonly overHi: number
}

export interface ComparisonResult {
    readonly isFrameKept: boolean
    readonly luma: PlaneDiffCounts
    readonly u: PlaneDiffCounts
    readonly v: PlaneDiffCounts
    /** FFmpeg's `trunc((w/16)*(h/16)*frac)` for the luma plane. */
    readonly lumaLoLimit: number
    /** FFmpeg's `trunc((w/16)*(h/16)*frac)` for each chroma plane. */
    readonly chromaLoLimit: number
}

/** A comparison result that becomes readable after its command batch submits. */
export interface ComparisonReadback {
    readonly read: Effect.Effect<ComparisonResult, YUVTexturePipelineError>
}

/**
 * Commands that may be recorded while processing one frame. Implementations
 * decide whether these become WebGPU commands, CPU work, or something else.
 */
export interface YUVTextureCommands {
    readonly enqueuePlaneWrite: (
        input: PlaneTextureWrite,
    ) => Effect.Effect<void, YUVTexturePipelineError>
    readonly enqueueUVDeinterleave: (
        input: InterleavedUVTextureWrite,
    ) => Effect.Effect<void, YUVTexturePipelineError>
    readonly enqueueComparison: () => Effect.Effect<
        ComparisonReadback,
        YUVTexturePipelineError
    >
    readonly enqueueReferenceCopy: () => Effect.Effect<
        void,
        YUVTexturePipelineError
    >
}

/**
 * Owns the lifetime of a per-frame command batch.
 *
 * `submit` opens a batch, passes its recorder to `record`, and finishes and
 * submits the batch if recording succeeds. Implementations must treat the
 * recorder as valid only for the duration of the `record` callback.
 */
export interface YUVTextureCommandEncoderService {
    readonly submit: <A, E, R>(
        record: (commands: YUVTextureCommands) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | YUVTexturePipelineError, R>
}

export class YUVTextureCommandEncoder extends Context.Service<
    YUVTextureCommandEncoder,
    YUVTextureCommandEncoderService
>()("interface/YUVTextureCommandEncoder") {
}

export class YUVTexturePipelineError extends Data.TaggedError(
    "YUVTexturePipelineError",
)<{
    readonly message: string
    readonly cause?: unknown
}> {
}

export interface WrittenYUVFrame {
    readonly chromaSubsampling: ChromaSubsampling
    readonly lumaSize: PlaneSize
    readonly chromaSize: PlaneSize
    readonly isFrameKept: boolean
    /** The full per-plane counts behind `isFrameKept`, for visualization. */
    readonly comparison: ComparisonResult
}

const chromaSize = (
    subsampling: ChromaSubsampling,
    width: number,
    height: number,
): PlaneSize => {
    switch (subsampling) {
        case ChromaSubsampling.YUV420:
            return {width: Math.ceil(width / 2), height: Math.ceil(height / 2)}
        case ChromaSubsampling.YUV422:
            return {width: Math.ceil(width / 2), height}
        case ChromaSubsampling.YUV444:
            return {width, height}
    }
}

const writeFrame = Effect.fn("YUVTexturePipeline.writeFrame")(function* (
    frame: IncomingYUVFrame,
) {
    if (!Number.isSafeInteger(frame.frameWidth) || frame.frameWidth <= 0 ||
        !Number.isSafeInteger(frame.frameHeight) || frame.frameHeight <= 0) {
        return yield* Effect.fail(new YUVTexturePipelineError({
            message: "Frame dimensions must be positive safe integers.",
        }))
    }

    const lumaSize = {width: frame.frameWidth, height: frame.frameHeight}
    const uvSize = chromaSize(
        frame.chromaSubsampling,
        frame.frameWidth,
        frame.frameHeight,
    )
    const lumaByteLength = lumaSize.width * lumaSize.height
    const chromaByteLength = uvSize.width * uvSize.height
    const expectedByteLength = lumaByteLength + 2 * chromaByteLength

    if (frame.videoFrameBytes.byteLength !== expectedByteLength) {
        return yield* Effect.fail(new YUVTexturePipelineError({
            message: `Expected ${expectedByteLength} tightly-packed frame bytes, received ${frame.videoFrameBytes.byteLength}.`,
        }))
    }

    const yBytes = frame.videoFrameBytes.subarray(0, lumaByteLength)
    const commandEncoder = yield* YUVTextureCommandEncoder

    const recorded = yield* commandEncoder.submit(commands => Effect.gen(function* () {
        yield* commands.enqueuePlaneWrite({plane: "Y", bytes: yBytes, size: lumaSize})

        if (frame.isUVInterleaved) {
            const uvBytes = frame.videoFrameBytes.subarray(lumaByteLength)
            yield* commands.enqueueUVDeinterleave({bytes: uvBytes, size: uvSize})
        } else {
            const uEnd = lumaByteLength + chromaByteLength
            const uBytes = frame.videoFrameBytes.subarray(lumaByteLength, uEnd)
            const vBytes = frame.videoFrameBytes.subarray(uEnd)
            yield* commands.enqueuePlaneWrite({plane: "U", bytes: uBytes, size: uvSize})
            yield* commands.enqueuePlaneWrite({plane: "V", bytes: vBytes, size: uvSize})
        }

        const comparison = yield* commands.enqueueComparison()

        return {comparison}
    }))

    const comparison = yield* recorded.comparison.read

    if (comparison.isFrameKept) {
        yield* commandEncoder.submit(commands => commands.enqueueReferenceCopy())
    }

    return {
        chromaSubsampling: frame.chromaSubsampling,
        lumaSize,
        chromaSize: uvSize,
        isFrameKept: comparison.isFrameKept,
        comparison,
    } satisfies WrittenYUVFrame
})

/**
 * Sequentially writes incoming frames to Y, U, and V textures. The default
 * mapEffect concurrency of one preserves frame and GPU command order.
 */
export const writeYUVTextures = <E, R>(
    frames: Stream.Stream<IncomingYUVFrame, E, R>,
): Stream.Stream<
    WrittenYUVFrame,
    E | YUVTexturePipelineError,
    R | YUVTextureCommandEncoder
> => frames.pipe(
    Stream.mapEffect(writeFrame),
)
