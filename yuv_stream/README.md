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
