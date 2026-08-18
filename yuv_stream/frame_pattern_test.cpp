#include "frame_pattern.h"

#include <gtest/gtest.h>

#include <sstream>

namespace {

using frame_pattern::Apply;
using frame_pattern::kIdentity;
using frame_pattern::Lerp;
using frame_pattern::Mat4;
using frame_pattern::ParseTrsPair;
using frame_pattern::RenderFrame;
using frame_pattern::TrsPair;

TEST(Lerp, EndpointsAndMidpoint) {
    Mat4 zero{};
    Mat4 ones;
    ones.fill(1.0f);
    EXPECT_EQ(Lerp(zero, ones, 0.0f), zero);
    EXPECT_EQ(Lerp(zero, ones, 1.0f), ones);
    for (float value : Lerp(zero, ones, 0.5f)) EXPECT_FLOAT_EQ(value, 0.5f);
}

TEST(Apply, IdentityIsNoOp) {
    const auto rgb = Apply(kIdentity, 0.25f, 0.5f, 0.75f);
    EXPECT_FLOAT_EQ(rgb[0], 0.25f);
    EXPECT_FLOAT_EQ(rgb[1], 0.5f);
    EXPECT_FLOAT_EQ(rgb[2], 0.75f);
}

TEST(Apply, TranslationAddsOffset) {
    Mat4 m = kIdentity;
    m[3] = 0.1f;   // r += 0.1
    m[7] = 0.2f;   // g += 0.2
    m[11] = 0.3f;  // b += 0.3
    const auto rgb = Apply(m, 0.0f, 0.0f, 0.0f);
    EXPECT_FLOAT_EQ(rgb[0], 0.1f);
    EXPECT_FLOAT_EQ(rgb[1], 0.2f);
    EXPECT_FLOAT_EQ(rgb[2], 0.3f);
}

TEST(Apply, ScaleMultipliesChannels) {
    Mat4 m = kIdentity;
    m[0] = 2.0f;
    m[5] = 0.5f;
    const auto rgb = Apply(m, 0.4f, 0.4f, 0.4f);
    EXPECT_FLOAT_EQ(rgb[0], 0.8f);
    EXPECT_FLOAT_EQ(rgb[1], 0.2f);
    EXPECT_FLOAT_EQ(rgb[2], 0.4f);
}

TEST(ParseTrsPair, ReadsTwoMatricesWithComments) {
    std::ostringstream text;
    text << "# start matrix\n";
    for (int i = 0; i < 16; ++i) text << i << ' ';
    text << "\n# end matrix\n";
    for (int i = 0; i < 16; ++i) text << i + 16 << ' ';
    std::istringstream input(text.str());
    const TrsPair pair = ParseTrsPair(input);
    EXPECT_FLOAT_EQ(pair.start[0], 0.0f);
    EXPECT_FLOAT_EQ(pair.start[15], 15.0f);
    EXPECT_FLOAT_EQ(pair.end[0], 16.0f);
    EXPECT_FLOAT_EQ(pair.end[15], 31.0f);
}

TEST(ParseTrsPair, RejectsWrongCountAndGarbage) {
    std::istringstream too_few("1 2 3");
    EXPECT_THROW(ParseTrsPair(too_few), std::invalid_argument);
    std::istringstream garbage(
        "1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 nope "
        "1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1");
    EXPECT_THROW(ParseTrsPair(garbage), std::invalid_argument);
}

TEST(RenderFrame, HasExpectedSizeAndCorners) {
    const TrsPair identity{kIdentity, kIdentity};
    const int width = 4, height = 4;
    const auto rgb = RenderFrame(identity, width, height, 0, 10);
    ASSERT_EQ(rgb.size(), static_cast<std::size_t>(width * height * 3));
    // Top-left base color is (0, 0, 0); bottom-right is (1, 1, 1).
    EXPECT_EQ(rgb[0], 0);
    EXPECT_EQ(rgb[1], 0);
    EXPECT_EQ(rgb[2], 0);
    const std::size_t last = rgb.size() - 3;
    EXPECT_EQ(rgb[last], 255);
    EXPECT_EQ(rgb[last + 1], 255);
    EXPECT_EQ(rgb[last + 2], 255);
}

TEST(RenderFrame, InterpolatesBetweenMatrices) {
    // start: everything black; end: everything white (via translation).
    Mat4 black{};
    Mat4 white{};
    white[3] = white[7] = white[11] = 1.0f;
    const TrsPair trs{black, white};
    const int width = 2, height = 2;
    const std::int64_t length = 5;
    const auto first = RenderFrame(trs, width, height, 0, length);
    const auto middle = RenderFrame(trs, width, height, 2, length);
    const auto last = RenderFrame(trs, width, height, length - 1, length);
    for (auto byte : first) EXPECT_EQ(byte, 0);
    for (auto byte : middle) EXPECT_EQ(byte, 128);  // round(0.5 * 255)
    for (auto byte : last) EXPECT_EQ(byte, 255);
}

TEST(RenderFrame, SingleFrameClipUsesStartMatrix) {
    Mat4 white{};
    white[3] = white[7] = white[11] = 1.0f;
    const TrsPair trs{kIdentity, white};
    const auto rgb = RenderFrame(trs, 2, 2, 0, 1);
    EXPECT_EQ(rgb[0], 0);  // identity on (0,0,0), not the white end matrix
}

TEST(RenderFrame, OutputIsClampedToByteRange) {
    Mat4 hot = kIdentity;
    hot[3] = 10.0f;  // r way above 1.0
    Mat4 cold = kIdentity;
    cold[3] = -10.0f;  // r way below 0.0
    const auto bright = RenderFrame({hot, hot}, 2, 2, 0, 2);
    const auto dark = RenderFrame({cold, cold}, 2, 2, 0, 2);
    EXPECT_EQ(bright[0], 255);
    EXPECT_EQ(dark[0], 0);
}

TEST(ParseHexColor, ParsesWithAndWithoutPrefix) {
    const auto color = frame_pattern::ParseHexColor("0x00aacc");
    EXPECT_FLOAT_EQ(color[0], 0.0f);
    EXPECT_FLOAT_EQ(color[1], 0xaa / 255.0f);
    EXPECT_FLOAT_EQ(color[2], 0xcc / 255.0f);
    const auto bare = frame_pattern::ParseHexColor("FF0080");
    EXPECT_FLOAT_EQ(bare[0], 1.0f);
    EXPECT_FLOAT_EQ(bare[1], 0.0f);
    EXPECT_FLOAT_EQ(bare[2], 0x80 / 255.0f);
}

TEST(ParseHexColor, RejectsWrongLengthAndGarbage) {
    EXPECT_THROW(frame_pattern::ParseHexColor("0xabc"), std::invalid_argument);
    EXPECT_THROW(frame_pattern::ParseHexColor("0x00aagg"), std::invalid_argument);
    EXPECT_THROW(frame_pattern::ParseHexColor(""), std::invalid_argument);
}

TEST(RenderCircleFrame, FullRadiusFillsCenterNotCorners) {
    const frame_pattern::CirclePattern circle{1.0f, {1, 1, 1}, 1.0f, {1, 1, 1}};
    const int width = 8, height = 8;
    const auto rgb = frame_pattern::RenderCircleFrame(circle, width, height, 0, 2);
    ASSERT_EQ(rgb.size(), static_cast<std::size_t>(width * height * 3));
    const auto pixel = [&](int x, int y) {
        return rgb[(static_cast<std::size_t>(y) * width + x) * 3];
    };
    EXPECT_EQ(pixel(4, 4), 255);  // center is inside the disc
    EXPECT_EQ(pixel(0, 0), 0);    // corner stays background black
}

TEST(RenderCircleFrame, ZeroRadiusIsAllBlack) {
    const frame_pattern::CirclePattern circle{0.0f, {1, 1, 1}, 0.0f, {1, 1, 1}};
    const auto rgb = frame_pattern::RenderCircleFrame(circle, 4, 4, 0, 2);
    for (auto byte : rgb) EXPECT_EQ(byte, 0);
}

TEST(RenderCircleFrame, InterpolatesRadiusAndColor) {
    // Grows from nothing to inscribed while fading black -> white.
    const frame_pattern::CirclePattern circle{0.0f, {0, 0, 0}, 1.0f, {1, 1, 1}};
    const int width = 16, height = 16;
    const std::int64_t length = 3;
    const auto center = [&](const std::vector<std::uint8_t>& rgb) {
        return rgb[(static_cast<std::size_t>(height / 2) * width + width / 2) * 3];
    };
    const auto first = frame_pattern::RenderCircleFrame(circle, width, height, 0, length);
    const auto middle = frame_pattern::RenderCircleFrame(circle, width, height, 1, length);
    const auto last = frame_pattern::RenderCircleFrame(circle, width, height, 2, length);
    EXPECT_EQ(center(first), 0);     // radius 0: nothing drawn
    EXPECT_EQ(center(middle), 128);  // halfway: mid-gray disc covers the center
    EXPECT_EQ(center(last), 255);    // end: white disc
}

}  // namespace
