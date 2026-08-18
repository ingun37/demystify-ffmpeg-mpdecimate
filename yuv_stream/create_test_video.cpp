#include <algorithm>
#include <charconv>
#include <coroutine>
#include <functional>
#include <cstdint>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "frame_pattern.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/error.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>
}

namespace {

struct Rgb8Frame {
    std::int64_t frame_number;
    std::vector<std::uint8_t> rgb8;
};

class FrameGenerator {
public:
    struct promise_type {
        Rgb8Frame current;

        FrameGenerator get_return_object() {
            return FrameGenerator{std::coroutine_handle<promise_type>::from_promise(*this)};
        }
        std::suspend_always initial_suspend() noexcept { return {}; }
        std::suspend_always final_suspend() noexcept { return {}; }
        std::suspend_always yield_value(Rgb8Frame frame) noexcept {
            current = std::move(frame);
            return {};
        }
        void return_void() noexcept {}
        void unhandled_exception() { std::rethrow_exception(std::current_exception()); }
    };

    explicit FrameGenerator(std::coroutine_handle<promise_type> handle) : handle_(handle) {}
    FrameGenerator(const FrameGenerator&) = delete;
    FrameGenerator(FrameGenerator&& other) noexcept : handle_(std::exchange(other.handle_, {})) {}
    ~FrameGenerator() { if (handle_) handle_.destroy(); }

    class Iterator {
    public:
        explicit Iterator(std::coroutine_handle<promise_type> handle) : handle_(handle) {}
        Iterator& operator++() { handle_.resume(); return *this; }
        const Rgb8Frame& operator*() const { return handle_.promise().current; }
        bool operator==(std::default_sentinel_t) const { return !handle_ || handle_.done(); }
    private:
        std::coroutine_handle<promise_type> handle_;
    };

    Iterator begin() { if (handle_) handle_.resume(); return Iterator{handle_}; }
    std::default_sentinel_t end() const { return {}; }

private:
    std::coroutine_handle<promise_type> handle_;
};

// Renders one RGB24 frame of the clip at the given frame number.
using FrameRenderer =
    std::function<std::vector<std::uint8_t>(std::int64_t frame_number, std::int64_t length)>;

// Yields RGB24 frames produced by the renderer for each frame of the clip.
FrameGenerator GenerateRgb8Frames(std::int64_t length, FrameRenderer render) {
    for (std::int64_t frame_number = 0; frame_number < length; ++frame_number) {
        co_yield Rgb8Frame{frame_number, render(frame_number, length)};
    }
}

std::string AvError(int code) {
    char text[AV_ERROR_MAX_STRING_SIZE]{};
    return av_make_error_string(text, sizeof(text), code);
}

void Check(int code, std::string_view operation) {
    if (code < 0) throw std::runtime_error(std::string(operation) + ": " + AvError(code));
}

int ParsePositive(std::string_view text, const char* name) {
    int value = 0;
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), value);
    if (error != std::errc{} || end != text.data() + text.size() || value <= 0)
        throw std::invalid_argument(std::string(name) + " must be a positive integer");
    return value;
}

void WriteVideo(const std::string& output_path, int width, int height, int length,
                const FrameRenderer& render) {
    AVFormatContext* raw_output = nullptr;
    Check(avformat_alloc_output_context2(&raw_output, nullptr, "mp4", output_path.c_str()),
          "creating MP4 container");
    auto free_output = [](AVFormatContext* value) {
        if (value) {
            if (!(value->oformat->flags & AVFMT_NOFILE) && value->pb) avio_closep(&value->pb);
            avformat_free_context(value);
        }
    };
    std::unique_ptr<AVFormatContext, decltype(free_output)> output(raw_output, free_output);
    output->avoid_negative_ts = AVFMT_AVOID_NEG_TS_MAKE_ZERO;

    const AVCodec* codec = avcodec_find_encoder(AV_CODEC_ID_H264);
    if (!codec) throw std::runtime_error("FFmpeg H.264 encoder is unavailable");
    AVStream* stream = avformat_new_stream(output.get(), nullptr);
    if (!stream) throw std::runtime_error("creating video stream failed");

    auto free_codec = [](AVCodecContext* value) { avcodec_free_context(&value); };
    std::unique_ptr<AVCodecContext, decltype(free_codec)> encoder(avcodec_alloc_context3(codec), free_codec);
    if (!encoder) throw std::runtime_error("allocating encoder failed");
    encoder->codec_id = codec->id;
    encoder->width = width;
    encoder->height = height;
    encoder->pix_fmt = AV_PIX_FMT_YUV420P;
    encoder->time_base = AVRational{1, 30};
    encoder->framerate = AVRational{30, 1};
    encoder->bit_rate = 2'000'000;
    encoder->gop_size = 30;
    encoder->max_b_frames = 0;
    if (output->oformat->flags & AVFMT_GLOBALHEADER) encoder->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    Check(avcodec_open2(encoder.get(), codec, nullptr), "opening encoder");
    Check(avcodec_parameters_from_context(stream->codecpar, encoder.get()), "copying encoder parameters");
    stream->time_base = encoder->time_base;

    if (!(output->oformat->flags & AVFMT_NOFILE))
        Check(avio_open(&output->pb, output_path.c_str(), AVIO_FLAG_WRITE), "opening output file");
    Check(avformat_write_header(output.get(), nullptr), "writing MP4 header");

    auto free_frame = [](AVFrame* value) { av_frame_free(&value); };
    std::unique_ptr<AVFrame, decltype(free_frame)> yuv(av_frame_alloc(), free_frame);
    if (!yuv) throw std::runtime_error("allocating frame failed");
    yuv->format = encoder->pix_fmt;
    yuv->width = width;
    yuv->height = height;
    Check(av_frame_get_buffer(yuv.get(), 32), "allocating YUV frame buffer");

    auto free_packet = [](AVPacket* value) { av_packet_free(&value); };
    std::unique_ptr<AVPacket, decltype(free_packet)> packet(av_packet_alloc(), free_packet);
    if (!packet) throw std::runtime_error("allocating packet failed");
    std::unique_ptr<SwsContext, decltype(&sws_freeContext)> converter(
        sws_getContext(width, height, AV_PIX_FMT_RGB24, width, height, encoder->pix_fmt,
                       SWS_BILINEAR, nullptr, nullptr, nullptr), sws_freeContext);
    if (!converter) throw std::runtime_error("creating RGB-to-YUV converter failed");

    auto drain = [&] {
        while (true) {
            const int result = avcodec_receive_packet(encoder.get(), packet.get());
            if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) return;
            Check(result, "encoding frame");
            av_packet_rescale_ts(packet.get(), encoder->time_base, stream->time_base);
            packet->duration = av_rescale_q(1, encoder->time_base, stream->time_base);
            packet->stream_index = stream->index;
            Check(av_interleaved_write_frame(output.get(), packet.get()), "writing encoded frame");
            av_packet_unref(packet.get());
        }
    };

    const std::size_t expected_size = static_cast<std::size_t>(width) * height * 3;
    for (const Rgb8Frame& rgb : GenerateRgb8Frames(length, render)) {
        if (rgb.rgb8.size() != expected_size)
            throw std::runtime_error("RGB coroutine yielded a buffer with the wrong size at frame " +
                                     std::to_string(rgb.frame_number));
        Check(av_frame_make_writable(yuv.get()), "making frame writable");
        const std::uint8_t* source[] = {rgb.rgb8.data()};
        const int source_stride[] = {width * 3};
        sws_scale(converter.get(), source, source_stride, 0, height, yuv->data, yuv->linesize);
        yuv->pts = rgb.frame_number;
        Check(avcodec_send_frame(encoder.get(), yuv.get()), "sending frame to encoder");
        drain();
    }
    Check(avcodec_send_frame(encoder.get(), nullptr), "flushing encoder");
    drain();
    Check(av_write_trailer(output.get()), "writing MP4 trailer");
}

}  // namespace

float ParseUnitRadius(const std::string& text, const char* name) {
    std::size_t used = 0;
    float value = 0.0f;
    try {
        value = std::stof(text, &used);
    } catch (const std::exception&) {
        throw std::invalid_argument(std::string(name) + " must be a number in [0, 1]");
    }
    if (used != text.size() || value < 0.0f || value > 1.0f)
        throw std::invalid_argument(std::string(name) + " must be a number in [0, 1]");
    return value;
}

int Usage(const char* program) {
    std::cerr << "Usage: " << program
              << " TYPE OUTPUT.mp4 WIDTH HEIGHT LENGTH_IN_FRAMES [TYPE_ARGS...]\n"
                 "\n"
                 "TYPE 'affine' [TRS_FILE]:\n"
                 "  Gradient transformed by two interpolated color-space matrices.\n"
                 "  TRS_FILE holds 32 whitespace-separated numbers: two row-major 4x4\n"
                 "  matrices (start, then end); '#' comments allowed. Without it, both\n"
                 "  matrices default to identity.\n"
                 "\n"
                 "TYPE 'circle' RADIUS0 COLOR0 RADIUS1 COLOR1:\n"
                 "  Centered disc growing/shrinking from RADIUS0 to RADIUS1 (each in\n"
                 "  [0, 1], 1 = inscribed) while fading from COLOR0 to COLOR1\n"
                 "  (hex like 0x00aacc).\n";
    return EXIT_FAILURE;
}

int main(int argc, char** argv) {
    if (argc < 6) return Usage(argv[0]);
    try {
        const std::string_view type = argv[1];
        const int width = ParsePositive(argv[3], "width");
        const int height = ParsePositive(argv[4], "height");
        const int length = ParsePositive(argv[5], "length");
        if ((width & 1) || (height & 1))
            throw std::invalid_argument("width and height must be even for YUV 4:2:0 output");

        FrameRenderer render;
        if (type == "affine") {
            if (argc != 6 && argc != 7) return Usage(argv[0]);
            const frame_pattern::TrsPair trs =
                argc == 7
                    ? frame_pattern::LoadTrsPair(argv[6])
                    : frame_pattern::TrsPair{frame_pattern::kIdentity, frame_pattern::kIdentity};
            render = [=](std::int64_t frame_number, std::int64_t clip_length) {
                return frame_pattern::RenderFrame(trs, width, height, frame_number, clip_length);
            };
        } else if (type == "circle") {
            if (argc != 10) return Usage(argv[0]);
            const frame_pattern::CirclePattern circle{
                ParseUnitRadius(argv[6], "radius0"), frame_pattern::ParseHexColor(argv[7]),
                ParseUnitRadius(argv[8], "radius1"), frame_pattern::ParseHexColor(argv[9])};
            render = [=](std::int64_t frame_number, std::int64_t clip_length) {
                return frame_pattern::RenderCircleFrame(circle, width, height, frame_number,
                                                        clip_length);
            };
        } else {
            return Usage(argv[0]);
        }
        WriteVideo(argv[2], width, height, length, render);
    } catch (const std::exception& error) {
        std::cerr << "create_test_video: " << error.what() << '\n';
        return EXIT_FAILURE;
    }
}
