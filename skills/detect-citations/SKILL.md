---
name: detect-citations
description: Run eyecite over each ingested case to identify legal citations, then create one `linking`-motivation reference annotation per citation with explicit text-position selectors. Each annotation stays unresolved; skill 6 (`ground-citations`) resolves them to actual case or statute resources.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write
---

You are helping the user build the citation layer over an ingested caselaw corpus. eyecite is the [Free Law Project](https://github.com/freelawproject/eyecite)'s deterministic regex/NLP citation extractor — orders of magnitude cheaper and more accurate than asking an LLM to do this.

This skill **does not** use `mark.assist`. The detection is deterministic; the annotations are recorded with their exact eyecite-reported byte positions.

## What it does

Three phases, orchestrated by [`run.sh`](run.sh):

1. **Fetch** — for each Case resource (or one specific `<resourceId>`), call `browse.resourceContent` and stage the body on disk at `.cache/citation-detection/<resourceId>.body`. Runs inside a Node container ([`fetch.ts`](fetch.ts)).
2. **Detect** — for each staged body, pipe it through the `semiont-eyecite` container. The Python script ([`detect_citations.py`](detect_citations.py)) reads stdin and writes a JSON citation list to stdout. The bash wrapper captures each into `<resourceId>.citations.json`.
3. **Emit** — read every `.citations.json` and call `mark.annotation` once per detected citation. Motivation `linking`; body carries a `tagging` TextualBody for `Citation` and a second one for the eyecite citation type (`FullCaseCitation`, `ShortCaseCitation`, `IdCitation`, `SupraCitation`, `FullLawCitation`, etc.). Runs inside a Node container ([`emit.ts`](emit.ts)).

Each annotation stays unresolved (no `SpecificResource` body item yet) — `ground-citations` (skill 6) walks them and resolves to actual cases / statutes.

## Why three phases instead of one script

`mark.assist`-based skills run as a single tsx call inside a Node container. This one can't — eyecite is Python, which lives in a separate container, and Apple's `container` runtime doesn't expose a socket for nested-container spawning. So the per-case `cat body | container run eyecite` step happens on the host between the two Node containers (which handle the SDK fetch and emit). The bash wrapper enforces the shape; the data flow is a textbook ingestion pipeline.

## SDK verbs

- `browse.resources`, `browse.resourceContent` (phase 1)
- `mark.annotation` × *N citations* (phase 3)

## Parameters

| Parameter | Type | Default | Purpose |
|---|---|---|---|
| `<resourceId>` | CLI arg (optional) | all Case resources | Restrict to one case |
| `SEMIONT_API_URL` | env | discovered via `HOST_ADDR` probe | Backend URL |
| `SEMIONT_USER_EMAIL` | env | `admin@example.com` | Auth |
| `SEMIONT_USER_PASSWORD` | env | `password` | Auth |
| `CONTAINER_RUNTIME` | env | `container` | Runtime to use (also `docker`/`podman`) |
| `EYECITE_IMAGE_TAG` | env | `semiont-eyecite:latest` | Override the eyecite image tag |

## Run it

**Prerequisites:**
1. `ingest-cases` has been run.
2. The eyecite container image is built (one-time):

```bash
container build -t semiont-eyecite:latest skills/detect-citations
```

Then:

```bash
bash skills/detect-citations/run.sh
```

Or against a single case:

```bash
bash skills/detect-citations/run.sh 55a7cf35c0fa4e83ba5250d24dfc39e2
```

The wrapper handles the three-phase dance. Output of each phase is logged.

## Output / on-disk artifacts

Intermediate files land in `.cache/citation-detection/` (already in `.gitignore`):

- `<resourceId>.body` — the markdown body fetched in phase 1
- `<resourceId>.citations.json` — eyecite's output for that case

The wrapper clears these at the start of each run so stale results from a prior invocation don't get re-emitted in phase 3.

## Guidance for the AI assistant

- **eyecite is deterministic.** Re-running on the same case produces the same citation set. But the skill creates *new* mark.annotation records each time — no dedup. Restart the backend or hand-delete prior annotations to start fresh.
- **One container invocation per case in phase 2.** ~200–400 ms of container startup per call. For a 100-case corpus, expect ~30–60 s of detection wall-time on top of LLM-free citation extraction. Batching multiple bodies through one eyecite invocation is a future optimization (requires changes to `detect_citations.py`'s stdin protocol).
- **Citation types matter for downstream skills.** `extract-statutory-refs` keys off the `FullLawCitation` / statutory subset; `ground-citations` handles `FullCaseCitation` / `ShortCaseCitation` / `IdCitation` / `SupraCitation`. The tag body on each annotation is what those skills read.
- **Spans use `TextPositionSelector`.** eyecite reports byte offsets in the source text. The annotation records both `start` and `end` so resolution doesn't need to re-scan the document text.
