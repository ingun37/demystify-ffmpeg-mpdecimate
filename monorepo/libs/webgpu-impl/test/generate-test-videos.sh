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
    "${create_test_video}" "${output_dir}/case-${index}.mp4" \
        "${width}" "${height}" "${frames}" "${trs_file}"
done

echo "Generated ${count} videos (${width}x${height}, ${frames} frames) in ${output_dir}"
