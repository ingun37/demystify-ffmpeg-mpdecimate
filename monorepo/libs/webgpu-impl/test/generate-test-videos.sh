#!/usr/bin/env bash
# Generates the test videos consumed by yuv-stream.integration.test.ts from
# the git-tracked parameter files in test/parameters/ (produced by
# generate-random-parameters.sh). Writes case-N.mp4 and circle-N.mp4 into
# test/generated/, which is not tracked by git — each environment generates
# its own videos from the shared parameters.
#
# Usage: ./generate-test-videos.sh
set -euo pipefail

width=64
height=64
frames=12

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../../.." && pwd)"
create_test_video="${repo_root}/yuv_stream/cmake-build-debug/create_test_video"
parameter_dir="${script_dir}/parameters"
output_dir="${script_dir}/generated"

if [[ ! -x "${create_test_video}" ]]; then
    echo "error: ${create_test_video} not found." >&2
    echo "Build it first: cmake --build ${repo_root}/yuv_stream/cmake-build-debug --target create_test_video" >&2
    exit 1
fi

if [[ ! -d "${parameter_dir}" ]]; then
    echo "error: ${parameter_dir} not found." >&2
    echo "Generate it first: ${script_dir}/generate-random-parameters.sh" >&2
    exit 1
fi

rm -rf "${output_dir}"
mkdir -p "${output_dir}"

affine_count=0
for trs_file in "${parameter_dir}"/case-*.trs.txt; do
    name="$(basename "${trs_file}" .trs.txt)"
    "${create_test_video}" affine "${output_dir}/${name}.mp4" \
        "${width}" "${height}" "${frames}" "${trs_file}"
    ((++affine_count))
done

circle_count=0
for params_file in "${parameter_dir}"/circle-*.params.txt; do
    name="$(basename "${params_file}" .params.txt)"
    params="$(cat "${params_file}")"
    # shellcheck disable=SC2086
    "${create_test_video}" circle "${output_dir}/${name}.mp4" \
        "${width}" "${height}" "${frames}" ${params}
    ((++circle_count))
done

echo "Generated ${affine_count} affine and ${circle_count} circle videos (${width}x${height}, ${frames} frames) in ${output_dir}"
