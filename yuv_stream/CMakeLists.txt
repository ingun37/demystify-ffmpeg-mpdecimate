cmake_minimum_required(VERSION 4.3)
project(yuv_stream)

set(CMAKE_CXX_STANDARD 26)

find_package(PkgConfig REQUIRED)
pkg_check_modules(FFMPEG REQUIRED IMPORTED_TARGET
        libavcodec libavformat libavutil libswscale libswresample)
find_package(Protobuf CONFIG REQUIRED)
find_package(gRPC CONFIG REQUIRED)
set(PROTO_GEN_DIR ${CMAKE_CURRENT_BINARY_DIR}/proto_gen)
file(MAKE_DIRECTORY ${PROTO_GEN_DIR})
add_custom_command(
        OUTPUT ${PROTO_GEN_DIR}/frame_service.pb.cc ${PROTO_GEN_DIR}/frame_service.pb.h
        ${PROTO_GEN_DIR}/frame_service.grpc.pb.cc ${PROTO_GEN_DIR}/frame_service.grpc.pb.h
        COMMAND protobuf::protoc
        ARGS --cpp_out=${PROTO_GEN_DIR} --grpc_out=${PROTO_GEN_DIR}
        --plugin=protoc-gen-grpc=$<TARGET_FILE:gRPC::grpc_cpp_plugin>
        -I ${CMAKE_CURRENT_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}/frame_service.proto
        DEPENDS frame_service.proto
        COMMENT "Generating gRPC sources from frame_service.proto")

add_executable(yuv_stream
        main.cpp
        ${PROTO_GEN_DIR}/frame_service.pb.cc
        ${PROTO_GEN_DIR}/frame_service.grpc.pb.cc)
target_link_libraries(yuv_stream PUBLIC PkgConfig::FFMPEG gRPC::grpc++ protobuf::libprotobuf)

target_include_directories(yuv_stream PUBLIC ${PROTO_GEN_DIR} ${CMAKE_CURRENT_SOURCE_DIR})
