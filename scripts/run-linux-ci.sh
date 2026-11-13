#!/usr/bin/env bash
# Fetch a Node 24 runtime into WSL and run the suite with it.
#
# Why: the compatibility matrix must show Linux **on Node 24**, which is the
# declared floor. The WSL distribution ships Node 22, so this script downloads a
# Node 24 tarball into /tmp and runs the same commands the CI job runs.
set -euo pipefail

VERSION=$(curl -sS https://nodejs.org/dist/index.json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(r["version"] for r in d if r["version"].startswith("v24.")))')
echo "node version: $VERSION"

DEST=/tmp/node24
if [ ! -x "$DEST/bin/node" ]; then
  curl -sSLo /tmp/node24.tar.xz "https://nodejs.org/dist/${VERSION}/node-${VERSION}-linux-x64.tar.xz"
  mkdir -p "$DEST"
  tar -xJf /tmp/node24.tar.xz -C "$DEST" --strip-components=1
fi
export PATH="$DEST/bin:$PATH"
node --version

cd /mnt/e/__VIVE__/Documents/deepseek-harness/default-workspace/dsh-loci
node scripts/check-manifest.mjs
node --disable-warning=ExperimentalWarning --test "test/unit/*.test.mjs" "test/integration/*.test.mjs" 2>&1 | tail -8
node --disable-warning=ExperimentalWarning scripts/check-coverage.mjs
node --disable-warning=ExperimentalWarning scripts/bench.mjs --entries 2000 --queries 100
