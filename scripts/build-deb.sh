#!/bin/sh
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
BUILD_ROOT="${TMPDIR:-/tmp}/phis-builds/phis"
SOURCE_ROOT="${BUILD_ROOT}/src"
ARTIFACT_ROOT="${BUILD_ROOT}/artifacts"
PACKAGE_VERSION="$(dpkg-parsechangelog -l "${REPO_ROOT}/debian/changelog" -SVersion)"
HOST_ARCH="$(dpkg-architecture -qDEB_HOST_ARCH)"

# The package build only copies; everything it installs is built here, in the workspace, where the
# lockfile and @phis/contracts are. Build it with `pnpm build && pnpm build:cli` before packaging.
for artifact in .next/standalone .next/static dist/phis.mjs; do
  if [ ! -e "${REPO_ROOT}/${artifact}" ]; then
    printf 'missing %s -- run "pnpm build && pnpm build:cli" before building the package\n' \
      "${artifact}" >&2
    exit 1
  fi
done

rm -rf "${SOURCE_ROOT}"
rm -rf "${ARTIFACT_ROOT}"
mkdir -p "${SOURCE_ROOT}"
mkdir -p "${ARTIFACT_ROOT}"

cd "${REPO_ROOT}"
tar \
  --exclude-vcs \
  --exclude='./.next/cache' \
  --exclude='./node_modules' \
  --exclude='./debian/.debhelper' \
  --exclude='./debian/phis' \
  -cf - . | tar -xf - -C "${SOURCE_ROOT}"

cd "${SOURCE_ROOT}"
ARTIFACT_DIR="${ARTIFACT_ROOT}" \
  dpkg-buildpackage \
    -us \
    -uc \
    -b \
    --buildinfo-option="-u${ARTIFACT_ROOT}" \
    --buildinfo-file="${ARTIFACT_ROOT}/phis_${PACKAGE_VERSION}_${HOST_ARCH}.buildinfo" \
    --changes-option="-u${ARTIFACT_ROOT}" \
    --changes-file="${ARTIFACT_ROOT}/phis_${PACKAGE_VERSION}_${HOST_ARCH}.changes" \
    "$@"

printf 'Built Debian artifacts in %s\n' "${ARTIFACT_ROOT}"
