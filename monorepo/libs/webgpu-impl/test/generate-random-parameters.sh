#!/usr/bin/env bash
# Generates the random parameter files consumed by generate-test-videos.sh.
# Writes case-N.trs.txt and circle-N.params.txt into test/parameters/.
# These outputs are tracked by git so every environment generates identical
# test videos from them.
#
# Usage: ./generate-random-parameters.sh [SEED]
set -euo pipefail

seed="${1:-51966}" # 0xCAFE
count=12

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output_dir="${script_dir}/parameters"

rm -rf "${output_dir}"
mkdir -p "${output_dir}"

for ((index = 0; index < count; ++index)); do
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
    }' > "${output_dir}/case-${index}.trs.txt"
done

for ((index = 0; index < count; ++index)); do
    # Random but subtle circle transition: a small radius drift and a small
    # per-channel color drift, so mpdecimate has borderline frames to drop
    # instead of every frame changing enough to be kept.
    awk -v seed="$((seed + count + index))" 'BEGIN {
        srand(seed)
        r0 = 0.2 + rand() * 0.6
        r1 = r0 + (rand() - 0.5) * 0.08
        if (r1 < 0) r1 = 0; if (r1 > 1) r1 = 1
        for (i = 0; i < 3; ++i) c0[i] = int(rand() * 256)
        for (i = 0; i < 3; ++i) {
            c1[i] = c0[i] + int((rand() - 0.5) * 24)
            if (c1[i] < 0) c1[i] = 0; if (c1[i] > 255) c1[i] = 255
        }
        printf "%.3f 0x%02x%02x%02x %.3f 0x%02x%02x%02x",
            r0, c0[0], c0[1], c0[2], r1, c1[0], c1[1], c1[2]
    }' > "${output_dir}/circle-${index}.params.txt"
done

echo "Generated ${count} affine and ${count} circle parameter files in ${output_dir}"
