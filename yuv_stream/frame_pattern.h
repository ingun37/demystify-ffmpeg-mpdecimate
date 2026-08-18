#ifndef YUV_STREAM_FRAME_PATTERN_H
#define YUV_STREAM_FRAME_PATTERN_H

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace frame_pattern {

// Row-major 4x4 matrix acting on homogeneous RGB colors (r, g, b, 1).
using Mat4 = std::array<float, 16>;

constexpr Mat4 kIdentity = {1, 0, 0, 0,
                            0, 1, 0, 0,
                            0, 0, 1, 0,
                            0, 0, 0, 1};

struct TrsPair {
    Mat4 start;
    Mat4 end;
};

inline Mat4 Lerp(const Mat4& a, const Mat4& b, float t) {
    Mat4 out{};
    for (std::size_t i = 0; i < 16; ++i) out[i] = a[i] + (b[i] - a[i]) * t;
    return out;
}

// Applies m to (r, g, b, 1) and returns the transformed rgb (w is discarded).
inline std::array<float, 3> Apply(const Mat4& m, float r, float g, float b) {
    return {m[0] * r + m[1] * g + m[2] * b + m[3],
            m[4] * r + m[5] * g + m[6] * b + m[7],
            m[8] * r + m[9] * g + m[10] * b + m[11]};
}

// Parses two 4x4 matrices (32 whitespace-separated numbers, row-major,
// start matrix first). '#' starts a comment that runs to end of line.
inline TrsPair ParseTrsPair(std::istream& input) {
    std::vector<float> values;
    std::string token;
    std::string line;
    while (std::getline(input, line)) {
        if (const auto hash = line.find('#'); hash != std::string::npos) line.erase(hash);
        std::istringstream fields(line);
        while (fields >> token) {
            std::size_t used = 0;
            float value = 0.0f;
            try {
                value = std::stof(token, &used);
            } catch (const std::exception&) {
                throw std::invalid_argument("TRS file: not a number: '" + token + "'");
            }
            if (used != token.size())
                throw std::invalid_argument("TRS file: not a number: '" + token + "'");
            values.push_back(value);
        }
    }
    if (values.size() != 32)
        throw std::invalid_argument("TRS file: expected 32 numbers (two 4x4 matrices), got " +
                                    std::to_string(values.size()));
    TrsPair pair{};
    std::copy_n(values.begin(), 16, pair.start.begin());
    std::copy_n(values.begin() + 16, 16, pair.end.begin());
    return pair;
}

inline TrsPair LoadTrsPair(const std::string& path) {
    std::ifstream file(path);
    if (!file) throw std::runtime_error("TRS file: cannot open " + path);
    return ParseTrsPair(file);
}

inline std::uint8_t ToByte(float value) {
    return static_cast<std::uint8_t>(std::lround(std::clamp(value, 0.0f, 1.0f) * 255.0f));
}

// Circle pattern: a centered disc whose radius and color interpolate from
// (radius0, color0) to (radius1, color1) over the clip. Radii are in [0, 1],
// where 1 means the disc is inscribed in the frame (radius = min(w, h) / 2).
struct CirclePattern {
    float radius0;
    std::array<float, 3> color0;
    float radius1;
    std::array<float, 3> color1;
};

// Parses a color like "0x00aacc" (or "00aacc") into normalized RGB.
inline std::array<float, 3> ParseHexColor(const std::string& text) {
    std::string digits = text;
    if (digits.size() >= 2 && digits[0] == '0' && (digits[1] == 'x' || digits[1] == 'X'))
        digits.erase(0, 2);
    if (digits.size() != 6 ||
        digits.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos)
        throw std::invalid_argument("color: expected 6 hex digits like 0x00aacc, got '" + text + "'");
    const unsigned long value = std::stoul(digits, nullptr, 16);
    return {static_cast<float>((value >> 16) & 0xFF) / 255.0f,
            static_cast<float>((value >> 8) & 0xFF) / 255.0f,
            static_cast<float>(value & 0xFF) / 255.0f};
}

// Fills a packed RGB24 buffer for one frame of the circle pattern:
// black background, disc radius and color interpolated at
// t = frame_number / (length - 1).
inline std::vector<std::uint8_t> RenderCircleFrame(const CirclePattern& circle, int width,
                                                   int height, std::int64_t frame_number,
                                                   std::int64_t length) {
    const float t = length > 1 ? static_cast<float>(frame_number) / (length - 1) : 0.0f;
    const float radius =
        (circle.radius0 + (circle.radius1 - circle.radius0) * t) * std::min(width, height) * 0.5f;
    std::array<float, 3> color{};
    for (std::size_t i = 0; i < 3; ++i)
        color[i] = circle.color0[i] + (circle.color1[i] - circle.color0[i]) * t;
    const float center_x = (width - 1) * 0.5f;
    const float center_y = (height - 1) * 0.5f;
    std::vector<std::uint8_t> rgb8(static_cast<std::size_t>(width) * height * 3);
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            const float dx = x - center_x;
            const float dy = y - center_y;
            if (dx * dx + dy * dy > radius * radius) continue;
            const std::size_t offset = (static_cast<std::size_t>(y) * width + x) * 3;
            rgb8[offset] = ToByte(color[0]);
            rgb8[offset + 1] = ToByte(color[1]);
            rgb8[offset + 2] = ToByte(color[2]);
        }
    }
    return rgb8;
}

// Base color for a pixel before the color-space transform: a normalized
// gradient (u, v, u*v) with u = x/(w-1), v = y/(h-1).
inline std::array<float, 3> BaseColor(int x, int y, int width, int height) {
    const float u = width > 1 ? static_cast<float>(x) / (width - 1) : 0.0f;
    const float v = height > 1 ? static_cast<float>(y) / (height - 1) : 0.0f;
    return {u, v, u * v};
}

// Fills a packed RGB24 buffer (width * height * 3 bytes) for one frame:
// the base gradient transformed by the matrix interpolated at
// t = frame_number / (length - 1).
inline std::vector<std::uint8_t> RenderFrame(const TrsPair& trs, int width, int height,
                                             std::int64_t frame_number, std::int64_t length) {
    const float t = length > 1 ? static_cast<float>(frame_number) / (length - 1) : 0.0f;
    const Mat4 m = Lerp(trs.start, trs.end, t);
    std::vector<std::uint8_t> rgb8(static_cast<std::size_t>(width) * height * 3);
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            const auto base = BaseColor(x, y, width, height);
            const auto color = Apply(m, base[0], base[1], base[2]);
            const std::size_t offset = (static_cast<std::size_t>(y) * width + x) * 3;
            rgb8[offset] = ToByte(color[0]);
            rgb8[offset + 1] = ToByte(color[1]);
            rgb8[offset + 2] = ToByte(color[2]);
        }
    }
    return rgb8;
}

}  // namespace frame_pattern

#endif  // YUV_STREAM_FRAME_PATTERN_H
