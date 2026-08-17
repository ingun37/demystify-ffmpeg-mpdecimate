# YUV frame gRPC server

Build and run:

```sh
cmake -S . -B build -G Ninja
cmake --build build
./build/yuv_stream 0.0.0.0:50051
```

`FrameService.Session` is a bidirectional streaming RPC. The client sends the
encoded video as ordered `VideoChunk` messages and then half-closes its send
side. The server sends one `VideoMetadata` message followed by one `Frame`
message for every decoded video frame.

Frames retain FFmpeg's decoded pixel format. Each plane contains visible rows
packed without FFmpeg's alignment padding; `bytes_per_row` is therefore the
stride to use for the transmitted data. For semi-planar formats such as NV12,
the second plane contains interleaved UV samples and `uv_interleaved` is true.

The input is buffered in a temporary file before decoding. This lets FFmpeg
probe and seek in containers that require random access, at the cost of frames
starting only after the upload is complete.

## Test-video generator

`create_test_video` generates packed RGB8 frames and encodes them as a 30 fps
H.264 MP4:

```sh
./build/create_test_video output.mp4 640 480 300
```

The arguments are output path, width, height, and length in frames. Width and
height must be even because the encoder output is YUV420P. Customize
`GenerateRgb8Frames` in `create_test_video.cpp`; every yielded `Rgb8Frame`
contains both `frame_number` and the packed RGB byte buffer.

## mpdecimate server

`mpdecimate_server` runs FFmpeg's native `mpdecimate` filter and streams only
the frames kept by the filter:

```sh
./build/mpdecimate_server 0.0.0.0:50052
```

Open `MpdecimateService.Decimate`, send exactly one `MpdecimateParams` request,
then send the encoded video as ordered `VideoChunk` requests and half-close the
client stream. Unset parameters use FFmpeg's defaults. Each response contains
the kept frame's zero-based decoded frame number, original PTS, and stream time
base; pixel data is not returned.
