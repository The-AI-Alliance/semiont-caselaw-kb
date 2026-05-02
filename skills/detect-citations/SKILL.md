---
name: detect-citations
description: Run eyecite over each ingested case to identify legal citations, then create one `linking`-motivation reference annotation per citation with explicit text-position selectors. Each annotation stays unresolved; skill 6 (`ground-citations`) resolves them to actual case or statute resources.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write
---

You are helping the user build the citation layer over an ingested caselaw corpus. eyecite is the [Free Law Project](https://github.com/freelawproject/eyecite)'s deterministic regex/NLP citation extractor — orders of magnitude cheaper and more accurate than asking an LLM to do this. The skill spawns a Python container with eyecite installed, pipes case text through `detect_citations.py`, and parses the JSON output into `mark.annotation` calls with `TextPositionSelector`s.

This skill **does not** use `mark.assist`. The detection is deterministic; the annotations are recorded with their exact eyecite-reported byte positions.

## What it does

For each Case resource (or one specific resource):

1. Fetch the case body via `browse.resourceContent`.
2. Spawn the eyecite container, pipe the body in via stdin, parse the JSON of detected citations.
3. For each citation: `mark.annotation` with motivation `linking`, body containing a `tagging` TextualBody that records the eyecite citation type (`FullCaseCitation`, `ShortCaseCitation`, `IdCitation`, `SupraCitation`, `StatutoryCitation`, etc.) and an `entity-type-tagging` TextualBody for `Citation`.

Each annotation stays unresolved (no `SpecificResource` body item yet) — `ground-citations` (skill 6) walks these annotations and resolves them.

## SDK verbs

- `browse.resources`, `browse.resourceContent`, `mark.annotation` × *N citations*

## Parameters

| Parameter | Type | Default | Purpose |
|---|---|---|---|
| `<resourceId>` | CLI arg (optional) | all Case resources | Restrict to one case |

## Tier-3 interactive checkpoint

Per case: prints citation count + type breakdown, asks `confirm` before bulk-creating annotations.

## Run it

**Prerequisites:**
1. `ingest-cases` (skill 1) has been run.
2. The eyecite container image is built:

```bash
container build -t semiont-eyecite:latest skills/detect-citations
```

(Substitute `docker build` / `podman build` if those are your runtime.)

Then:

```bash
HOST_ADDR=$(container run --rm node:24-alpine sh -c "ip route | awk '/default/{print \$3}'" 2>/dev/null | tr -d '[:space:]')

container run --rm -v "$(pwd):/work" -w /work \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e SEMIONT_API_URL=http://${HOST_ADDR}:4000 \
  -e SEMIONT_USER_EMAIL=admin@example.com \
  -e SEMIONT_USER_PASSWORD=<your-password> \
  -e CONTAINER_RUNTIME=docker \
  node:24-alpine \
  sh -c 'apk add --no-cache docker-cli && npm install --silent --no-fund @semiont/sdk tsx && npx tsx skills/detect-citations/script.ts'
```

The Docker socket mount is needed because `src/eyecite.ts` shells out to the container runtime to spawn the Python container *from within* the Node container. If you're running the Node script on the host directly (npm install + tsx on host, with Apple Container runtime), use:

```bash
SEMIONT_API_URL=http://localhost:4000 \
SEMIONT_USER_EMAIL=admin@example.com \
SEMIONT_USER_PASSWORD=<your-password> \
CONTAINER_RUNTIME=container \
npx tsx skills/detect-citations/script.ts
```

Add `-e SEMIONT_INTERACTIVE=1 -it` (or just `--interactive` for the host-direct path) to enable the per-case confirm prompt.

## Guidance for the AI assistant

- **eyecite is deterministic.** Re-running on the same case produces the same citation set. But re-running creates *duplicate annotations* — there's no dedup in this skill. Restart the backend or hand-delete the prior annotations to start fresh.
- **The Python container spawn happens once per case.** Image-already-built case: ~200–400 ms per spawn, dominated by container startup. For a 100-case corpus, expect ~30–60 s of detection wall-time.
- **Citation types matter for downstream skills.** `StatutoryCitation` annotations are routed to skill 8 (`extract-statutory-refs`) instead of skill 6. The type tag on each annotation is what skill 8 keys off of.
- **Spans use `TextPositionSelector`.** eyecite reports byte offsets in the source text. The annotation records both `start` and `end` so resolution doesn't need to re-scan the document text.
