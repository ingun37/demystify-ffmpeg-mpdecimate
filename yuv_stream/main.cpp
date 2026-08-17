#include <grpcpp/grpcpp.h>
#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <memory>
#include <string>
#include <unistd.h>
#include "frame_service.grpc.pb.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/error.h>
#include <libavutil/pixdesc.h>
}

namespace {
std::string AvError(int code) {
    char text[AV_ERROR_MAX_STRING_SIZE]{};
    return av_make_error_string(text, sizeof(text), code);
}
grpc::Status AvStatus(const char* operation, int code) {
    return {grpc::StatusCode::INTERNAL, std::string(operation) + ": " + AvError(code)};
}

struct TempFile {
    TempFile() {
        char pattern[] = "/tmp/yuv-stream-XXXXXX";
        fd = mkstemp(pattern);
        if (fd >= 0) path = pattern;
    }
    ~TempFile() {
        if (fd >= 0) close(fd);
        if (!path.empty()) unlink(path.c_str());
    }
    int fd = -1;
    std::string path;
};

frameservice::ChromaSubsampling ChromaType(const AVPixFmtDescriptor& d) {
    if (d.nb_components < 3) return frameservice::CHROMA_SUBSAMPLING_UNSPECIFIED;
    if (d.log2_chroma_w == 0 && d.log2_chroma_h == 0) return frameservice::CHROMA_SUBSAMPLING_444;
    if (d.log2_chroma_w == 1 && d.log2_chroma_h == 0) return frameservice::CHROMA_SUBSAMPLING_422;
    if (d.log2_chroma_w == 1 && d.log2_chroma_h == 1) return frameservice::CHROMA_SUBSAMPLING_420;
    if (d.log2_chroma_w == 2 && d.log2_chroma_h == 0) return frameservice::CHROMA_SUBSAMPLING_411;
    if (d.log2_chroma_w == 2 && d.log2_chroma_h == 1) return frameservice::CHROMA_SUBSAMPLING_410;
    if (d.log2_chroma_w == 0 && d.log2_chroma_h == 1) return frameservice::CHROMA_SUBSAMPLING_440;
    return frameservice::CHROMA_SUBSAMPLING_UNSPECIFIED;
}

bool IsChromaPlane(const AVPixFmtDescriptor& d, int plane) {
    return d.comp[0].plane != plane &&
           ((d.nb_components > 1 && d.comp[1].plane == plane) ||
            (d.nb_components > 2 && d.comp[2].plane == plane));
}
int PlaneWidth(const AVPixFmtDescriptor& d, int plane, int width) {
    return IsChromaPlane(d, plane) ? AV_CEIL_RSHIFT(width, d.log2_chroma_w) : width;
}
int PlaneHeight(const AVPixFmtDescriptor& d, int plane, int height) {
    return IsChromaPlane(d, plane) ? AV_CEIL_RSHIFT(height, d.log2_chroma_h) : height;
}
int RowBytes(const AVPixFmtDescriptor& d, int plane, int width) {
    int result = 0;
    for (int i = 0; i < d.nb_components; ++i) {
        if (d.comp[i].plane != plane) continue;
        const int samples = (i == 1 || i == 2) ? AV_CEIL_RSHIFT(width, d.log2_chroma_w) : width;
        result = std::max(result, samples * d.comp[i].step);
    }
    return result;
}

class Service final : public frameservice::FrameService::Service {
public:
    grpc::Status Session(grpc::ServerContext* context,
        grpc::ServerReaderWriter<frameservice::StreamMessage, frameservice::VideoChunk>* stream) override {
        TempFile input;
        if (input.fd < 0) return {grpc::StatusCode::INTERNAL, std::strerror(errno)};
        frameservice::VideoChunk chunk;
        while (stream->Read(&chunk)) {
            const char* cursor = chunk.data().data();
            size_t left = chunk.data().size();
            while (left) {
                const ssize_t count = write(input.fd, cursor, left);
                if (count < 0) {
                    if (errno == EINTR) continue;
                    return {grpc::StatusCode::INTERNAL, std::strerror(errno)};
                }
                cursor += count;
                left -= static_cast<size_t>(count);
            }
        }
        if (context->IsCancelled()) return {grpc::StatusCode::CANCELLED, "client cancelled"};

        AVFormatContext* raw_format = nullptr;
        int result = avformat_open_input(&raw_format, input.path.c_str(), nullptr, nullptr);
        if (result < 0) return AvStatus("opening video", result);
        auto close_format = [](AVFormatContext* value) { avformat_close_input(&value); };
        std::unique_ptr<AVFormatContext, decltype(close_format)> format(raw_format, close_format);
        if ((result = avformat_find_stream_info(format.get(), nullptr)) < 0) return AvStatus("reading stream info", result);
        const int index = av_find_best_stream(format.get(), AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
        if (index < 0) return AvStatus("finding video stream", index);

        AVStream* video = format->streams[index];
        const AVCodec* codec = avcodec_find_decoder(video->codecpar->codec_id);
        if (!codec) return {grpc::StatusCode::UNIMPLEMENTED, "unsupported video codec"};
        auto free_decoder = [](AVCodecContext* value) { avcodec_free_context(&value); };
        std::unique_ptr<AVCodecContext, decltype(free_decoder)> decoder(avcodec_alloc_context3(codec), free_decoder);
        if (!decoder) return {grpc::StatusCode::RESOURCE_EXHAUSTED, "cannot allocate decoder"};
        if ((result = avcodec_parameters_to_context(decoder.get(), video->codecpar)) < 0) return AvStatus("configuring decoder", result);
        if ((result = avcodec_open2(decoder.get(), codec, nullptr)) < 0) return AvStatus("opening decoder", result);

        auto free_packet = [](AVPacket* value) { av_packet_free(&value); };
        auto free_frame = [](AVFrame* value) { av_frame_free(&value); };
        std::unique_ptr<AVPacket, decltype(free_packet)> packet(av_packet_alloc(), free_packet);
        std::unique_ptr<AVFrame, decltype(free_frame)> frame(av_frame_alloc(), free_frame);
        if (!packet || !frame) return {grpc::StatusCode::RESOURCE_EXHAUSTED, "cannot allocate decode buffers"};
        bool sent_metadata = false;

        auto drain = [&]() -> grpc::Status {
            while (true) {
                result = avcodec_receive_frame(decoder.get(), frame.get());
                if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) return grpc::Status::OK;
                if (result < 0) return AvStatus("decoding frame", result);
                const auto format_id = static_cast<AVPixelFormat>(frame->format);
                const AVPixFmtDescriptor* desc = av_pix_fmt_desc_get(format_id);
                if (!desc || desc->nb_components < 3 ||
                    (desc->flags & (AV_PIX_FMT_FLAG_RGB | AV_PIX_FMT_FLAG_HWACCEL | AV_PIX_FMT_FLAG_BITSTREAM)))
                    return {grpc::StatusCode::UNIMPLEMENTED, "decoded format is not software YUV"};

                if (!sent_metadata) {
                    frameservice::StreamMessage message;
                    auto* metadata = message.mutable_metadata();
                    metadata->set_width(frame->width);
                    metadata->set_height(frame->height);
                    metadata->set_chroma_subsampling(ChromaType(*desc));
                    metadata->set_uv_interleaved(desc->comp[1].plane == desc->comp[2].plane);
                    metadata->set_pixel_format(desc->name);
                    if (!stream->Write(message)) return {grpc::StatusCode::CANCELLED, "client stopped reading"};
                    sent_metadata = true;
                }

                frameservice::StreamMessage message;
                auto* output = message.mutable_frame();
                output->set_pts(frame->pts == AV_NOPTS_VALUE ? 0 : frame->pts);
                output->set_duration(frame->duration);
                output->set_key_frame((frame->flags & AV_FRAME_FLAG_KEY) != 0);
                for (int p = 0; p < AV_NUM_DATA_POINTERS && frame->data[p]; ++p) {
                    const int width = PlaneWidth(*desc, p, frame->width);
                    const int height = PlaneHeight(*desc, p, frame->height);
                    const int row_bytes = RowBytes(*desc, p, frame->width);
                    if (height <= 0 || row_bytes <= 0) continue;
                    auto* plane = output->add_planes();
                    plane->set_width(width);
                    plane->set_height(height);
                    plane->set_bytes_per_row(row_bytes);
                    std::string* bytes = plane->mutable_data();
                    bytes->resize(static_cast<size_t>(row_bytes) * height);
                    const uint8_t* source = frame->data[p];
                    const int stride = frame->linesize[p];
                    if (stride < 0) source += static_cast<ptrdiff_t>(height - 1) * -stride;
                    for (int row = 0; row < height; ++row)
                        std::memcpy(bytes->data() + static_cast<size_t>(row) * row_bytes,
                                    source + static_cast<ptrdiff_t>(row) * stride, row_bytes);
                }
                if (!stream->Write(message)) return {grpc::StatusCode::CANCELLED, "client stopped reading"};
                av_frame_unref(frame.get());
            }
        };

        while ((result = av_read_frame(format.get(), packet.get())) >= 0) {
            if (packet->stream_index == index) {
                result = avcodec_send_packet(decoder.get(), packet.get());
                if (result < 0) return AvStatus("sending packet", result);
                grpc::Status status = drain();
                if (!status.ok()) return status;
            }
            av_packet_unref(packet.get());
        }
        if (result != AVERROR_EOF) return AvStatus("reading video", result);
        if ((result = avcodec_send_packet(decoder.get(), nullptr)) < 0) return AvStatus("flushing decoder", result);
        grpc::Status status = drain();
        if (!status.ok()) return status;
        return sent_metadata ? grpc::Status::OK
                             : grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "video has no frames");
    }
};
}  // namespace

int main(int argc, char** argv) {
    const std::string address = argc > 1 ? argv[1] : "0.0.0.0:50051";
    Service service;
    grpc::ServerBuilder builder;
    builder.SetMaxSendMessageSize(-1);
    builder.SetMaxReceiveMessageSize(-1);
    builder.AddListeningPort(address, grpc::InsecureServerCredentials());
    builder.RegisterService(&service);
    std::unique_ptr<grpc::Server> server = builder.BuildAndStart();
    if (!server) return EXIT_FAILURE;
    std::cout << "FrameService listening on " << address << '\n';
    server->Wait();
}
