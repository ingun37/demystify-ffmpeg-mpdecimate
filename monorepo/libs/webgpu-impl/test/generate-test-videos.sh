#!/usr/bin/env bash
# Generates the random-TRS test videos consumed by yuv-stream.integration.test.ts.
# Writes case-N.trs.txt and case-N.mp4 into test/generated/.
#
# Usage: ./generate-test-videos.sh [SEED]
set -euo pipefail

seed="${1:-51966}" # 0xCAFE
count=12
width=64
height=64
frames=12

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../../.." && pwd)"
create_test_video="${repo_root}/yuv_stream/cmake-build-debug/create_test_video"
output_dir="${script_dir}/generated"

if [[ ! -x "${create_test_video}" ]]; then
    echo "error: ${create_test_video} not found." >&2
    echo "Build it first: cmake --build ${repo_root}/yuv_stream/cmake-build-debug --target create_test_video" >&2
    exit 1
fi

rm -rf "${output_dir}"
mkdir -p "${output_dir}"

for ((index = 0; index < count; ++index)); do
    trs_file="${output_dir}/case-${index}.trs.txt"
    # Two random affine color-space matrices: channel mixing in [-1, 1],
    # channel offsets in [-0.5, 0.5], homogeneous row fixed at 0 0 0 1.
    awk -v seed="$((seed + index))" 'BEGIN {
        srand(seed)
        for (m = 0; m < 2; ++m) {
            print (m == 0 ? "# start" : "# end")
            for (row = 0; row < 3; ++row)
                printf "%.3f %.3f %.3f %.3f\n",
                    rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1, rand() - 0.5
            print "0 0 0 1"
        }
    }' > "${trs_file}"
    "${create_test_video}" affine "${output_dir}/case-${index}.mp4" \
        "${width}" "${height}" "${frames}" "${trs_file}"
done

for ((index = 0; index < count; ++index)); do
    # Random but subtle circle transition: a small radius drift and a small
    # per-channel color drift, so mpdecimate has borderline frames to drop
    # instead of every frame changing enough to be kept.
    params="$(awk -v seed="$((seed + count + index))" 'BEGIN {
        srand(seed)
        r0 = 0.2 + rand() * 0.6
        r1 = r0 + (rand() - 0.5) * 0.08
        if (r1 < 0) r1 = 0; if (r1 > 1) r1 = 1
        c = 0
        for (i = 0; i < 3; ++i) c0[i] = int(rand() * 256)
        for (i = 0; i < 3; ++i) {
            c1[i] = c0[i] + int((rand() - 0.5) * 24)
            if (c1[i] < 0) c1[i] = 0; if (c1[i] > 255) c1[i] = 255
        }
        printf "%.3f 0x%02x%02x%02x %.3f 0x%02x%02x%02x",
            r0, c0[0], c0[1], c0[2], r1, c1[0], c1[1], c1[2]
    }')"
    echo "${params}" > "${output_dir}/circle-${index}.params.txt"
    # shellcheck disable=SC2086
    "${create_test_video}" circle "${output_dir}/circle-${index}.mp4" \
        "${width}" "${height}" "${frames}" ${params}
done

echo "Generated ${count} affine and ${count} circle videos (${width}x${height}, ${frames} frames) in ${output_dir}"
