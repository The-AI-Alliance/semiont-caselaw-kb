#!/usr/bin/env bash
#
# detect-citations — host-side orchestration of the eyecite ingestion
# pipeline. Three phases:
#
#   1. Fetch each Case body via the SDK and stage it on disk.
#   2. Pipe each body through the semiont-eyecite container; capture
#      eyecite's JSON output per case.
#   3. Read the JSON and emit one mark.annotation per detected citation.
#
# Phase 1 and Phase 3 run inside a thin Node container (they're SDK calls).
# Phase 2 runs as a host-side loop, invoking the eyecite container once per
# case. This shape exists because Apple's `container` runtime doesn't
# expose a socket — a Node container can't spawn another container, so
# the bash wrapper handles the container-to-container orchestration.
#
# Usage:
#   bash skills/detect-citations/run.sh [<resourceId>]
#
# Environment (defaults match the local backend):
#   SEMIONT_API_URL          (default: discovered via HOST_ADDR probe)
#   SEMIONT_USER_EMAIL       (default: admin@example.com)
#   SEMIONT_USER_PASSWORD    (default: password)
#   CONTAINER_RUNTIME        (default: container; can be docker/podman)
#   EYECITE_IMAGE_TAG        (default: semiont-eyecite:latest)
#
# Prerequisites:
#   1. `ingest-cases` has been run.
#   2. The eyecite image is built:
#        container build -t semiont-eyecite:latest skills/detect-citations
#
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

RID="${1:-}"
RUNTIME="${CONTAINER_RUNTIME:-container}"
IMAGE="${EYECITE_IMAGE_TAG:-semiont-eyecite:latest}"
CACHE_DIR=".cache/citation-detection"

# HOST_ADDR for the inner Node containers to reach the host's Semiont
# backend. Same trick start.sh uses.
HOST_ADDR=$(${RUNTIME} run --rm node:24-alpine sh -c "ip route | awk '/default/{print \$3}'" 2>/dev/null | tr -d '[:space:]')
SEMIONT_API_URL="${SEMIONT_API_URL:-http://${HOST_ADDR}:4000}"
SEMIONT_USER_EMAIL="${SEMIONT_USER_EMAIL:-admin@example.com}"
SEMIONT_USER_PASSWORD="${SEMIONT_USER_PASSWORD:-password}"

mkdir -p "${CACHE_DIR}"
# Start from a clean cache so stale .citations.json from a previous run
# don't get re-emitted.
rm -f "${CACHE_DIR}"/*.body "${CACHE_DIR}"/*.citations.json 2>/dev/null || true

echo "=== Phase 1: fetch case bodies via SDK ==="
${RUNTIME} run --rm \
  -v "$(pwd):/work" -w /work \
  -e SEMIONT_API_URL="${SEMIONT_API_URL}" \
  -e SEMIONT_USER_EMAIL="${SEMIONT_USER_EMAIL}" \
  -e SEMIONT_USER_PASSWORD="${SEMIONT_USER_PASSWORD}" \
  node:24-alpine \
  sh -c "npm install --silent --no-fund @semiont/sdk tsx 2>&1 | tail -3 && npx tsx skills/detect-citations/fetch.ts ${CACHE_DIR} ${RID}"

echo ""
echo "=== Phase 2: eyecite per case ==="
shopt -s nullglob
bodies=( "${CACHE_DIR}"/*.body )
shopt -u nullglob
if [ ${#bodies[@]} -eq 0 ]; then
  echo "No bodies staged. Exiting."
  exit 0
fi
for body in "${bodies[@]}"; do
  out="${body%.body}.citations.json"
  cat "${body}" | ${RUNTIME} run --rm -i "${IMAGE}" > "${out}"
  n=$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['citations']))" "${out}")
  echo "  $(basename ${body} .body): ${n} citation(s)"
done

echo ""
echo "=== Phase 3: emit annotations via SDK ==="
${RUNTIME} run --rm \
  -v "$(pwd):/work" -w /work \
  -e SEMIONT_API_URL="${SEMIONT_API_URL}" \
  -e SEMIONT_USER_EMAIL="${SEMIONT_USER_EMAIL}" \
  -e SEMIONT_USER_PASSWORD="${SEMIONT_USER_PASSWORD}" \
  node:24-alpine \
  sh -c "npm install --silent --no-fund @semiont/sdk tsx 2>&1 | tail -3 && npx tsx skills/detect-citations/emit.ts ${CACHE_DIR}"
