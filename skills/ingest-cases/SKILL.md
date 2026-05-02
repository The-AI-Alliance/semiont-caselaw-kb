---
name: ingest-cases
description: Walk every `<corpus-name>/config.yaml` in the repo, fetch the source (HuggingFace `free-law/*` dataset rows or a Cornell LII opinion URL), and create one Semiont resource per case via yield.resource.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write
---

You are helping a user bootstrap a caselaw corpus into a Semiont knowledge base. This is the foundation skill — every other skill in this repo operates against the resources this one creates.

## What it does

1. Walks the repo for top-level subdirectories containing a `config.yaml`. Each config declares one corpus source.
2. Dispatches on the config's `handler` field:
   - `huggingface` — uses [`src/huggingface.ts`](../../src/huggingface.ts) to fetch dataset rows from the HuggingFace Datasets Server API and convert each row to `DocumentInfo`. Each case becomes one resource.
   - `cornell-lii` — uses [`src/legal-text.ts`](../../src/legal-text.ts) to fetch the opinion HTML, strip tags, and markdown-format. One case → one resource.
3. For each case: `yield.resource` with `format: 'text/markdown'` (or `text/plain` for HuggingFace dataset rows that aren't markdown-shaped), entity types `['Case', 'JudicialOpinion', ...]` plus any user-supplied tags from the config's `entityTypes` array.

Recognized config fields (per file):

| Field | Purpose |
|---|---|
| `name`, `displayName` | Corpus and resource-name display values |
| `handler` | `huggingface` or `cornell-lii` |
| `dataset`, `count`, `cacheFile` | HuggingFace-handler config |
| `url`, `cacheFile` | Cornell-LII-handler config |
| `entityTypes` | Additional entity-type tags applied to every resource from this corpus |
| `chunkSize` | (informational; large opinions are *not* split — the whole opinion becomes one resource) |

## SDK verbs

- `yield.resource` — one call per discovered case

## Tier-3 interactive checkpoint

Before bulk upload: `confirm` after showing per-corpus counts.

## Run it

**Prerequisite: the Semiont backend is running** — see [AGENTS.md › Backend setup](../../AGENTS.md#backend-setup).

```bash
HOST_ADDR=$(container run --rm node:24-alpine sh -c "ip route | awk '/default/{print \$3}'" 2>/dev/null | tr -d '[:space:]')

container run --rm -v "$(pwd):/work" -w /work \
  -e SEMIONT_API_URL=http://${HOST_ADDR}:4000 \
  -e SEMIONT_USER_EMAIL=admin@example.com \
  -e SEMIONT_USER_PASSWORD=<your-password> \
  node:24-alpine \
  sh -c 'npm install --silent --no-fund @semiont/sdk tsx yaml && npx tsx skills/ingest-cases/script.ts'
```

Note the additional `yaml` package — required for parsing the per-corpus configs.

Add `-e SEMIONT_INTERACTIVE=1 -it` to enable the confirm prompt.

## Guidance for the AI assistant

- **Re-running creates duplicates.** No deduplication. To start fresh, restart the backend stack.
- **The configs are user-editable.** A user wanting to swap in a different `free-law/*` dataset edits `caselaw/config.yaml`'s `dataset:` line; substituting a different Cornell LII opinion edits `citizens_united/config.yaml`'s `url:`. The skill doesn't know or care which dataset / opinion is in play.
- **Whole opinions become one resource.** The seeded `chunkSize` field in `citizens_united/config.yaml` is informational. The skills that follow operate on per-resource bodies; chunking would force every cross-reference to know which chunk a span lived in. If you need chunked navigation later, consider a follow-up skill that decomposes a Case into per-section LegalSection resources (similar to `semiont-legal-kb/build-section-graph`).
- **HuggingFace requests are unauthenticated.** Datasets-Server has rate limits — for a `count` of 100, a single page request returns all rows. If you bump `count` significantly higher you'll need pagination.
