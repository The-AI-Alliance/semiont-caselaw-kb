---
name: ground-citations
description: Walk every citation annotation from skill 2 and resolve each to a concrete resource — first by matching against the local corpus, then by querying CourtListener's Citation Lookup API. Cases not found locally are ingested as Case stubs from CourtListener metadata. Statutory citations are routed to skill 8 instead.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write
---

You are helping the user turn a corpus of citation annotations into a connected citation graph. After this skill, every reporter-style citation in every case is a clickable navigation link to a Case resource.

## What it does

For every unbound citation annotation produced by skill 2:

1. Skip annotations tagged `StatutoryCitation` — those route to skill 8 (`extract-statutory-refs`).
2. `gather.annotation` for surrounding context.
3. `match.search` against existing Case resources in the local corpus.
4. If a confident local match (score ≥ `MATCH_THRESHOLD`): `bind.body` the annotation to that case.
5. Otherwise: query [CourtListener's Citation Lookup API](https://www.courtlistener.com/help/api/rest/citation-lookup/) with the citation text. If a hit:
   - `yield.resource` a Case stub: title from CourtListener's `case_name`, body markdown carrying the case metadata + a CourtListener URL in an "External references" section, entity types `[Case, JudicialOpinion, CourtListenerStub]`.
   - `bind.body` the original annotation to the new Case resource.
6. Failed lookups: leave the annotation unresolved and add a `commenting` `TextualBody` to it noting the failure mode (no local match, no CourtListener match).

## SDK verbs

- `browse.resources`, `browse.annotations`, `gather.annotation`, `match.search`, `yield.resource`, `bind.body`

## Parameters

| Parameter | Type | Default | Purpose |
|---|---|---|---|
| `MATCH_THRESHOLD` | env var | 30 | Local-corpus match threshold |
| `RATE_LIMIT_DELAY_MS` | env var | 200 | Throttle CourtListener calls (ms between requests) |
| `COURTLISTENER_API_KEY` | env var | (none) | Optional; raises CourtListener rate-limit ceiling |
| `MAX_REMOTE_LOOKUPS` | env var | 100 | Cap on CourtListener queries per run (safety) |
| `SKIP_REMOTE` | env var | (off) | Set to `1` to skip CourtListener entirely (local-only resolution) |

## Tier-3 interactive checkpoint

Before run: prints citation count + estimated remote-lookup count, asks `confirm`. Per borderline match (interactive only): top candidates with scores; `[b]ind / [s]kip / [q]uit?`.

## Run it

**Prerequisites:**
- `detect-citations` (skill 2) has been run.
- (Recommended) `mark-judicial-entities` (skill 3) and `build-party-roster` (skill 9) have been run — improves match accuracy on local-corpus binding.

```bash
HOST_ADDR=$(container run --rm node:24-alpine sh -c "ip route | awk '/default/{print \$3}'" 2>/dev/null | tr -d '[:space:]')

container run --rm -v "$(pwd):/work" -w /work \
  -e SEMIONT_API_URL=http://${HOST_ADDR}:4000 \
  -e SEMIONT_USER_EMAIL=admin@example.com \
  -e SEMIONT_USER_PASSWORD=<your-password> \
  -e COURTLISTENER_API_KEY=<optional-key> \
  node:24-alpine \
  sh -c 'npm install --silent --no-fund @semiont/sdk tsx && npx tsx skills/ground-citations/script.ts'
```

Add `-e SEMIONT_INTERACTIVE=1 -it` for the per-match prompts.

## Guidance for the AI assistant

- **Local match before remote.** Cases in the same corpus often cite each other; checking the local corpus first avoids unnecessary CourtListener calls.
- **CourtListener cache is essential.** Results are cached to `.cache/courtlistener/` keyed by SHA-1 of the citation text. Re-runs are mostly local; the cache absorbs the rate-limit pressure.
- **MAX_REMOTE_LOOKUPS is a guardrail, not a quota.** A 100-case corpus averaging 30 citations each would generate ~3,000 lookups in a single run. The default cap of 100 keeps a first run small enough to spot-check the results before committing to a full run; raise it (or set `SKIP_REMOTE=1` for local-only resolution) once you've verified the binding logic on a sample.
- **Stub resources are intentionally minimal.** A CourtListener stub carries enough metadata to be navigable + cite-able but not the full opinion text. A future enhancement could fetch the full opinion HTML; for now the stub-plus-link pattern keeps the KB lightweight.
