---
name: extract-statutory-refs
description: Walk every StatutoryCitation annotation, parse it into title + section, fetch the statute body from US Code bulk XML, synthesize a Statute resource per unique section, and bind the original annotation to the Statute resource.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write
---

You are helping the user link the case layer to the statutory framework underneath it. Every `StatutoryCitation` produced by skill 2 (eyecite tags federal-code citations as such) gets resolved to a Statute resource carrying the actual statute text.

## What it does

For each unbound `StatutoryCitation` annotation:

1. Parse the citation into title + section components via [`src/uscode.ts`'s `parseUsCodeCitation`](../../src/uscode.ts).
2. If the parse succeeds (recognizable U.S. Code format like `5 U.S.C. § 552`):
   - Look up the section against `uscode.house.gov` bulk XML — `getUsCodeSection(title, section)`. The title's XML is fetched once and cached locally to `.cache/uscode/usc<NN>.xml`.
   - If found, `yield.resource` a Statute resource (entity types `[Statute, FederalStatute]`) — but only if no existing Statute resource for this title+section is already in the KB. Subsequent annotations citing the same section bind to the existing resource.
   - `bind.body` the original annotation to the Statute resource.
3. If the parse fails (state code, regulation, treaty, etc.): leave unresolved with a `commenting` `TextualBody` noting the failure mode. State-statute resolution is deferred.

## SDK verbs

- `browse.resources`, `browse.annotations`, `yield.resource`, `bind.body`

## Parameters

| Parameter | Type | Default | Purpose |
|---|---|---|---|
| (none — operates on every unbound StatutoryCitation annotation) | — | — | — |

## Tier-3 interactive checkpoint

Before fetch: prints unique-section count + estimated US Code title fetches, asks `confirm`. (US Code title XML files are cached after first fetch, so subsequent runs are local-only.)

## Run it

**Prerequisite: `detect-citations` (skill 2) has been run.**

```bash
HOST_ADDR=$(container run --rm node:24-alpine sh -c "ip route | awk '/default/{print \$3}'" 2>/dev/null | tr -d '[:space:]')

container run --rm -v "$(pwd):/work" -w /work \
  -e SEMIONT_API_URL=http://${HOST_ADDR}:4000 \
  -e SEMIONT_USER_EMAIL=admin@example.com \
  -e SEMIONT_USER_PASSWORD=<your-password> \
  node:24-alpine \
  sh -c 'npm install --silent --no-fund @semiont/sdk tsx && npx tsx skills/extract-statutory-refs/script.ts'
```

Add `-e SEMIONT_INTERACTIVE=1 -it` for the confirm prompt.

## Guidance for the AI assistant

- **Title XML fetches are heavy.** A single Title-of-the-United-States-Code XML can be 10–100+ MB. The skill caches each title after first fetch; second runs read locally.
- **Statute resources are reused.** Two cases citing `5 U.S.C. § 552` produce one Statute resource; both citation annotations bind to it. This is the desired graph shape: a statute is a node, citations are edges.
- **State citations stay unresolved.** Title-section parsing returns null for state citation forms (RSA, Cal. Civ. Code, etc.). A future `extract-state-statutory-refs` skill could partner with state-specific lookup APIs.
- **Bulk XML release point auto-discovery.** `src/uscode.ts` discovers the latest release point automatically by listing `https://uscode.house.gov/download/releasepoints/us/pl/`. If the listing format changes, the discovery breaks gracefully — fix the regex in `getLatestReleasePoint`.
