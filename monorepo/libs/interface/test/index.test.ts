import {assert, describe, it} from "@effect/vitest"
import {Effect, Layer, Stream} from "effect"
import {
    ChromaSubsampling,
    type IncomingYUVFrame,
    writeYUVTextures,
    YUVTextureCommandEncoder,
    type YUVTextureCommandEncoderService,
    type YUVTextureCommands,
} from "../src/index.js"

describe("writeYUVTextures", () => {
    it.effect("compares every frame and copies only kept frames to the reference textures", () =>
        Effect.gen(function* () {
            const events: Array<string> = []
            const comparisonResults = [true, false]

            const commands: YUVTextureCommands = {
                enqueuePlaneWrite: ({plane}) => Effect.sync(() => {
                    events.push(`write:${plane}`)
                }),
                enqueueUVDeinterleave: () => Effect.sync(() => {
                    events.push("deinterleave:UV")
                }),
                enqueueComparison: () => Effect.sync(() => {
                    events.push("compare")
                    const isFrameKept = comparisonResults.shift()
                    if (isFrameKept === undefined) {
                        throw new Error("Missing fake comparison result")
                    }
                    return {
                        read: Effect.sync(() => {
                            events.push(`read:${isFrameKept ? "kept" : "dropped"}`)
                            const counts = {overLo: 0, overHi: isFrameKept ? 1 : 0}
                            return {
                                isFrameKept,
                                luma: counts,
                                u: counts,
                                v: counts,
                                lumaLoLimit: 0,
                                chromaLoLimit: 0,
                            }
                        }),
                    }
                }),
                enqueueReferenceCopy: () => Effect.sync(() => {
                    events.push("copy:reference")
                }),
            }

            const service: YUVTextureCommandEncoderService = {
                submit: record => Effect.gen(function* () {
                    events.push("open")
                    const result = yield* record(commands)
                    events.push("submit")
                    return result
                }),
            }

            const frame = (fill: number): IncomingYUVFrame => ({
                // 2x2 YUV420: four Y bytes, one U byte, and one V byte.
                videoFrameBytes: new Uint8Array(6).fill(fill),
                chromaSubsampling: ChromaSubsampling.YUV420,
                isUVInterleaved: false,
                frameWidth: 2,
                frameHeight: 2,
            })

            const output = yield* writeYUVTextures(Stream.make(frame(1), frame(2))).pipe(
                Stream.runCollect,
                Effect.provide(Layer.succeed(YUVTextureCommandEncoder)(service)),
            )

            assert.deepStrictEqual(output.map(({isFrameKept}) => isFrameKept), [true, false])
            assert.deepStrictEqual(events, [
                "open",
                "write:Y",
                "write:U",
                "write:V",
                "compare",
                "submit",
                "read:kept",
                "open",
                "copy:reference",
                "submit",
                "open",
                "write:Y",
                "write:U",
                "write:V",
                "compare",
                "submit",
                "read:dropped",
            ])
        }))
})
