cmake_minimum_required(VERSION 4.3)
project(yuv_stream)

set(CMAKE_CXX_STANDARD 26)

find_package(PkgConfig REQUIRED)
pkg_check_modules(FFMPEG REQUIRED IMPORTED_TARGET
        libavcodec libavfilter libavformat libavutil libswscale libswresample)
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

add_executable(create_test_video create_test_video.cpp)
target_link_libraries(create_test_video PRIVATE PkgConfig::FFMPEG)

find_package(GTest CONFIG QUIET)
if (NOT GTest_FOUND)
    include(FetchContent)
    FetchContent_Declare(googletest
            URL https://github.com/google/googletest/archive/refs/tags/v1.15.2.zip)
    set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
    FetchContent_MakeAvailable(googletest)
endif ()
enable_testing()
add_executable(frame_pattern_test frame_pattern_test.cpp)
target_link_libraries(frame_pattern_test PRIVATE GTest::gtest_main)
include(GoogleTest)
gtest_discover_tests(frame_pattern_test)

set(MPDECIMATE_PROTO_GEN_DIR ${CMAKE_CURRENT_BINARY_DIR}/mpdecimate_proto_gen)
file(MAKE_DIRECTORY ${MPDECIMATE_PROTO_GEN_DIR})
add_custom_command(
        OUTPUT ${MPDECIMATE_PROTO_GEN_DIR}/mpdecimate_service.pb.cc
        ${MPDECIMATE_PROTO_GEN_DIR}/mpdecimate_service.pb.h
        ${MPDECIMATE_PROTO_GEN_DIR}/mpdecimate_service.grpc.pb.cc
        ${MPDECIMATE_PROTO_GEN_DIR}/mpdecimate_service.grpc.pb.h
        COMMAND protobuf::protoc
        ARGS --cpp_out=${MPDECIMATE_PROTO_GEN_DIR} --grpc_out=${MPDECIMATE_PROTO_GEN_DIR}
        --plugin=protoc-gen-grpc=$<TARGET_FILE:gRPC::grpc_cpp_plugin>
        -I ${CMAKE_CURRENT_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}/mpdecimate_service.proto
        DEPENDS mpdecimate_service.proto
        COMMENT "Generating mpdecimate gRPC sources")

add_executable(mpdecimate_server
        mpdecimate_server.cpp
        ${MPDECIMATE_PROTO_GEN_DIR}/mpdecimate_service.pb.cc
        ${MPDECIMATE_PROTO_GEN_DIR}/mpdecimate_service.grpc.pb.cc)
target_include_directories(mpdecimate_server PRIVATE ${MPDECIMATE_PROTO_GEN_DIR})
target_link_libraries(mpdecimate_server PRIVATE
        PkgConfig::FFMPEG gRPC::grpc++ protobuf::libprotobuf)
