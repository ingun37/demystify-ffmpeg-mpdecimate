#include <grpcpp/grpcpp.h>

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <limits>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <unistd.h>
#include <vector>

#include "mpdecimate_service.grpc.pb.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
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
        char pattern[] = "/tmp/mpdecimate-server-XXXXXX";
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

struct FilterGraph {
    FilterGraph() : graph(avfilter_graph_alloc()) {}
    ~FilterGraph() { avfilter_graph_free(&graph); }
    FilterGraph(const FilterGraph&) = delete;
    FilterGraph& operator=(const FilterGraph&) = delete;

    AVFilterGraph* graph = nullptr;
    AVFilterContext* source = nullptr;
    AVFilterContext* sink = nullptr;
};

grpc::Status ValidateParams(const mpdecimateservice::MpdecimateParams& params) {
    if (params.has_keep() && params.keep() < 0)
        return {grpc::StatusCode::INVALID_ARGUMENT, "mpdecimate keep must be non-negative"};
    if (params.has_frac() && (params.frac() < 0.0F || params.frac() > 1.0F))
        return {grpc::StatusCode::INVALID_ARGUMENT, "mpdecimate frac must be between 0 and 1"};
    return grpc::Status::OK;
}

std::string FilterOptions(const mpdecimateservice::MpdecimateParams& params) {
    std::ostringstream options;
    bool first = true;
    auto append = [&](const char* name, auto value) {
        if (!first) options << ':';
        options << name << '=' << value;
        first = false;
    };
    if (params.has_max()) append("max", params.max());
    if (params.has_keep()) append("keep", params.keep());
    if (params.has_hi()) append("hi", params.hi());
    if (params.has_lo()) append("lo", params.lo());
    if (params.has_frac()) append("frac", params.frac());
    return options.str();
}

grpc::Status ConfigureFilter(
    FilterGraph& filter,
    const AVFrame& frame,
    const mpdecimateservice::MpdecimateParams& params) {
    if (!filter.graph)
        return {grpc::StatusCode::RESOURCE_EXHAUSTED, "cannot allocate filter graph"};

    const AVFilter* buffer = avfilter_get_by_name("buffer");
    const AVFilter* mpdecimate = avfilter_get_by_name("mpdecimate");
    const AVFilter* buffersink = avfilter_get_by_name("buffersink");
    if (!buffer || !mpdecimate || !buffersink)
        return {grpc::StatusCode::UNIMPLEMENTED, "required FFmpeg filters are unavailable"};

    const AVRational aspect = frame.sample_aspect_ratio.num > 0
                                ? frame.sample_aspect_ratio
                                : AVRational{1, 1};
    std::ostringstream source_options;
    source_options << "video_size=" << frame.width << 'x' << frame.height
                   << ":pix_fmt=" << frame.format
                   << ":time_base=1/1"
                   << ":pixel_aspect=" << aspect.num << '/' << aspect.den;

    int result = avfilter_graph_create_filter(
        &filter.source, buffer, "source", source_options.str().c_str(), nullptr, filter.graph);
    if (result < 0) return AvStatus("creating buffer source", result);

    AVFilterContext* decimate = nullptr;
    const std::string options = FilterOptions(params);
    result = avfilter_graph_create_filter(
        &decimate, mpdecimate, "mpdecimate", options.empty() ? nullptr : options.c_str(), nullptr, filter.graph);
    if (result < 0) return AvStatus("creating mpdecimate filter", result);
    result = avfilter_graph_create_filter(
        &filter.sink, buffersink, "sink", nullptr, nullptr, filter.graph);
    if (result < 0) return AvStatus("creating buffer sink", result);
    if ((result = avfilter_link(filter.source, 0, decimate, 0)) < 0)
        return AvStatus("linking buffer to mpdecimate", result);
    if ((result = avfilter_link(decimate, 0, filter.sink, 0)) < 0)
        return AvStatus("linking mpdecimate to sink", result);
    if ((result = avfilter_graph_config(filter.graph, nullptr)) < 0)
        return AvStatus("configuring filter graph", result);
    return grpc::Status::OK;
}

class Service final : public mpdecimateservice::MpdecimateService::Service {
public:
    grpc::Status Decimate(
        grpc::ServerContext* context,
        grpc::ServerReaderWriter<mpdecimateservice::KeptFrame,
                                 mpdecimateservice::DecimateRequest>* stream) override {
        TempFile input;
        if (input.fd < 0)
            return {grpc::StatusCode::INTERNAL, std::string("cannot create temporary file: ") + std::strerror(errno)};

        std::optional<mpdecimateservice::MpdecimateParams> params;
        bool received_video = false;
        mpdecimateservice::DecimateRequest request;
        while (stream->Read(&request)) {
            if (request.has_params()) {
                if (params || received_video)
                    return {grpc::StatusCode::INVALID_ARGUMENT, "params must occur exactly once before video chunks"};
                grpc::Status status = ValidateParams(request.params());
                if (!status.ok()) return status;
                params = request.params();
                continue;
            }
            if (!request.has_chunk())
                return {grpc::StatusCode::INVALID_ARGUMENT, "request payload is missing"};
            if (!params)
                return {grpc::StatusCode::INVALID_ARGUMENT, "params must be sent before video chunks"};
            received_video = true;
            const std::string& bytes = request.chunk().data();
            const char* cursor = bytes.data();
            size_t remaining = bytes.size();
            while (remaining > 0) {
                const ssize_t written = write(input.fd, cursor, remaining);
                if (written < 0) {
                    if (errno == EINTR) continue;
                    return {grpc::StatusCode::INTERNAL, std::string("cannot store upload: ") + std::strerror(errno)};
                }
                cursor += written;
                remaining -= static_cast<size_t>(written);
            }
        }
        if (context->IsCancelled()) return {grpc::StatusCode::CANCELLED, "client cancelled"};
        if (!params) return {grpc::StatusCode::INVALID_ARGUMENT, "params were not provided"};
        if (!received_video) return {grpc::StatusCode::INVALID_ARGUMENT, "video is empty"};

        AVFormatContext* raw_format = nullptr;
        int result = avformat_open_input(&raw_format, input.path.c_str(), nullptr, nullptr);
        if (result < 0) return AvStatus("opening video", result);
        auto close_format = [](AVFormatContext* value) { avformat_close_input(&value); };
        std::unique_ptr<AVFormatContext, decltype(close_format)> format(raw_format, close_format);
        if ((result = avformat_find_stream_info(format.get(), nullptr)) < 0)
            return AvStatus("reading stream info", result);
        const int stream_index = av_find_best_stream(format.get(), AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
        if (stream_index < 0) return AvStatus("finding video stream", stream_index);

        AVStream* video = format->streams[stream_index];
        const AVCodec* codec = avcodec_find_decoder(video->codecpar->codec_id);
        if (!codec) return {grpc::StatusCode::UNIMPLEMENTED, "unsupported video codec"};
        auto free_codec = [](AVCodecContext* value) { avcodec_free_context(&value); };
        std::unique_ptr<AVCodecContext, decltype(free_codec)> decoder(avcodec_alloc_context3(codec), free_codec);
        if (!decoder) return {grpc::StatusCode::RESOURCE_EXHAUSTED, "cannot allocate decoder"};
        if ((result = avcodec_parameters_to_context(decoder.get(), video->codecpar)) < 0)
            return AvStatus("configuring decoder", result);
        if ((result = avcodec_open2(decoder.get(), codec, nullptr)) < 0)
            return AvStatus("opening decoder", result);

        auto free_packet = [](AVPacket* value) { av_packet_free(&value); };
        auto free_frame = [](AVFrame* value) { av_frame_free(&value); };
        std::unique_ptr<AVPacket, decltype(free_packet)> packet(av_packet_alloc(), free_packet);
        std::unique_ptr<AVFrame, decltype(free_frame)> decoded(av_frame_alloc(), free_frame);
        std::unique_ptr<AVFrame, decltype(free_frame)> kept(av_frame_alloc(), free_frame);
        if (!packet || !decoded || !kept)
            return {grpc::StatusCode::RESOURCE_EXHAUSTED, "cannot allocate decode buffers"};

        FilterGraph filter;
        bool filter_configured = false;
        std::uint64_t frame_number = 0;
        std::vector<std::int64_t> original_pts;

        auto drain_filter = [&]() -> grpc::Status {
            while (true) {
                result = av_buffersink_get_frame(filter.sink, kept.get());
                if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) return grpc::Status::OK;
                if (result < 0) return AvStatus("reading mpdecimate output", result);
                if (kept->pts < 0 || static_cast<std::uint64_t>(kept->pts) >= original_pts.size())
                    return {grpc::StatusCode::INTERNAL, "mpdecimate returned an unknown frame identifier"};

                mpdecimateservice::KeptFrame response;
                response.set_frame_number(static_cast<std::uint64_t>(kept->pts));
                response.set_pts(original_pts[static_cast<std::size_t>(kept->pts)]);
                response.set_time_base_num(video->time_base.num);
                response.set_time_base_den(video->time_base.den);
                if (!stream->Write(response))
                    return {grpc::StatusCode::CANCELLED, "client stopped reading"};
                av_frame_unref(kept.get());
            }
        };

        auto consume_decoded = [&]() -> grpc::Status {
            while (true) {
                result = avcodec_receive_frame(decoder.get(), decoded.get());
                if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) return grpc::Status::OK;
                if (result < 0) return AvStatus("decoding frame", result);
                if (!filter_configured) {
                    grpc::Status status = ConfigureFilter(filter, *decoded, *params);
                    if (!status.ok()) return status;
                    filter_configured = true;
                }
                original_pts.push_back(decoded->pts == AV_NOPTS_VALUE ? 0 : decoded->pts);
                decoded->pts = static_cast<std::int64_t>(frame_number++);
                result = av_buffersrc_add_frame_flags(filter.source, decoded.get(), AV_BUFFERSRC_FLAG_KEEP_REF);
                if (result < 0) return AvStatus("sending frame to mpdecimate", result);
                av_frame_unref(decoded.get());
                grpc::Status status = drain_filter();
                if (!status.ok()) return status;
            }
        };

        while ((result = av_read_frame(format.get(), packet.get())) >= 0) {
            if (packet->stream_index == stream_index) {
                result = avcodec_send_packet(decoder.get(), packet.get());
                if (result < 0) return AvStatus("sending packet to decoder", result);
                grpc::Status status = consume_decoded();
                if (!status.ok()) return status;
            }
            av_packet_unref(packet.get());
        }
        if (result != AVERROR_EOF) return AvStatus("reading video", result);
        if ((result = avcodec_send_packet(decoder.get(), nullptr)) < 0)
            return AvStatus("flushing decoder", result);
        grpc::Status status = consume_decoded();
        if (!status.ok()) return status;
        if (!filter_configured)
            return {grpc::StatusCode::INVALID_ARGUMENT, "video has no decoded frames"};
        if ((result = av_buffersrc_close(filter.source, static_cast<std::int64_t>(frame_number), 0)) < 0)
            return AvStatus("flushing mpdecimate", result);
        return drain_filter();
    }
};

}  // namespace

int main(int argc, char** argv) {
    const std::string address = argc > 1 ? argv[1] : "0.0.0.0:50052";
    Service service;
    grpc::ServerBuilder builder;
    builder.SetMaxReceiveMessageSize(-1);
    builder.AddListeningPort(address, grpc::InsecureServerCredentials());
    builder.RegisterService(&service);
    std::unique_ptr<grpc::Server> server = builder.BuildAndStart();
    if (!server) {
        std::cerr << "Failed to listen on " << address << '\n';
        return EXIT_FAILURE;
    }
    std::cout << "MpdecimateService listening on " << address << std::endl;
    server->Wait();
}
