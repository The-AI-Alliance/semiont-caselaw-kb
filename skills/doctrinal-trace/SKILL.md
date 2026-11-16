---
name: doctrinal-trace
description: Capstone. Given a doctrine query, trace the doctrine's development across the corpus and produce a research memo as a first-class KB resource. Pulls in IRAC tags (skill 4), the citation graph (skill 7), the party roster (skill 9), and subsequent-treatment classifications (skill 10) where available.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write
---

You are helping the user produce a legal research memo on a doctrine, doctrinal issue, or fact pattern, automatically composed from the prior layers' work.

## What it does

Given a `DOCTRINE_QUERY` (env var or CLI arg):

1. **Candidate cases** — `match.search` against Case resources with the doctrine query as text. Returns the top-N most-relevant cases.
2. **IRAC excerpts** — for each candidate, walks its `tagging`-motivation IRAC annotations. Filter to Rule and Application tags whose surface text references the doctrine.
3. **Foundational vs. evolutionary** — uses incoming-citation count from PrecedentGraph resources (skill 7) to identify foundational cases (high incoming-citation count). Cases that cite the foundational ones are evolutionary milestones.
4. **Treatment overlay** — for each foundational case, look up its SubsequentTreatment resource (skill 10) if one exists; surface negative / criticized / overruled treatments as caveats.
5. `yield.resource` a **DoctrinalTrace resource** (entity types `[DoctrinalTrace, Aggregate]`) with markdown structured as a legal-research memo:
   - Issue statement (the query)
   - Foundational cases (with IRAC excerpts + cite counts)
   - Evolutionary milestones (chronological)
   - Current state of the doctrine
   - Open questions (negatively-treated foundational cases, circuit splits if detectable, etc.)
   - Citation list

## SDK verbs

- `match.search`, `browse.resources`, `browse.annotations`, `gather.annotation`, `yield.resource`

## Parameters

| Parameter | Type | Default | Purpose |
|---|---|---|---|
| `DOCTRINE_QUERY` | env var or CLI arg | required | The doctrine / issue / fact pattern to trace |
| `MATCH_THRESHOLD` | env var | 30 | Candidate-case match threshold |
| `MAX_CANDIDATES` | env var | 15 | Cap on candidate cases pulled into the memo |

## Tier-3 interactive checkpoint

After candidate-case search: prints the top-N candidates with scores, asks `confirm` (or `pick` to narrow).

Before yield: prints memo preview (first 60 lines), asks `confirm`.

## Run it

**Prerequisites — most of the prior skills should have run.** Quality scales with how much of the pipeline has executed:

- **Required**: `ingest-cases`, `mark-judicial-entities`, `tag-irac`, `detect-citations`
- **Strongly recommended**: `ground-citations`, `build-citation-graph`
- **Optional**: `build-party-roster`, `subsequent-treatment` (per case of interest), `extract-statutory-refs`

```bash
HOST_ADDR=$(container run --rm node:24-alpine sh -c "ip route | awk '/default/{print \$3}'" 2>/dev/null | tr -d '[:space:]')

container run --rm -v "$(pwd):/work" -w /work \
  -e SEMIONT_API_URL=http://${HOST_ADDR}:4000 \
  -e SEMIONT_USER_EMAIL=admin@example.com \
  -e SEMIONT_USER_PASSWORD=<your-password> \
  -e DOCTRINE_QUERY='qualified immunity in state court' \
  node:24-alpine \
  sh -c 'npm install --silent --no-fund @semiont/sdk tsx && npx tsx skills/doctrinal-trace/script.ts'
```

Or pass the query as a CLI arg:

```bash
... npx tsx skills/doctrinal-trace/script.ts "First Amendment as applied to corporate political speech" ...
```

Add `-e SEMIONT_INTERACTIVE=1 -it` for the candidate-confirm and pre-yield preview.

## Guidance for the AI assistant

- **Memo quality is bounded by the pipeline.** Without skill 4 (`tag-irac`) the memo has no Rule/Application excerpts; without skill 7 (`build-citation-graph`) the foundational/evolutionary distinction collapses. The memo header notes which prior skills had run, so the reader knows what to discount.
- **The DoctrinalTrace resource is reproducible.** Re-run when the corpus grows and get an updated memo. Compare two memos by their `dateCreated` to see how the trace evolves.
- **Capstone, not citator-replacement.** The memo is a *first-pass research artifact* — it doesn't replace careful human reading of the foundational cases. The value is *speed* (a draft trace in minutes) and *recall* (every citing case in the corpus is surfaced, not just the ones the researcher remembered).
- **Negative-treatment surfacing matters.** If a foundational case has been overruled by a later case in the corpus (per skill 10), the memo's "open questions" section flags it. This is the closest the SDK comes to citator-style "is this still good law" output.
