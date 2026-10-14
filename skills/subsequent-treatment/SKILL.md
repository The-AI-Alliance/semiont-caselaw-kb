---
name: subsequent-treatment
description: For a target case, walk every citing case (via the inverse citation graph from skill 7) and classify the citing context as positive / negative / distinguished / criticized / overruled / neutral. Synthesize a SubsequentTreatment resource summarizing the target's treatment across the corpus.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write
---

You are helping the user produce a citator-style treatment report for a target case. Critical for "is this case still good law" research.

## What it does

Given the resource id of a target case:

1. Walk every `linking`-motivation `Citation` annotation across the corpus whose `SpecificResource` body resolves to the target case (i.e., every place this case is cited).
2. For each citing-case annotation:
   - `gather.annotation` to fetch a wide context window around the citation (default ±1500 chars).
   - `mark.delegate({ motivation: 'tagging', schemaId: 'legal-citation-treatment', categories: [...] })` against the citing case — a tagging job classifies its passages by the schema's categories: `positive` / `negative` / `distinguished` / `criticized` / `overruled` / `neutral`. A tagging job takes no instructions.
3. Aggregate the per-citation classifications into a markdown table.
4. `yield.resource` a **SubsequentTreatment resource** (entity types `[SubsequentTreatment, Aggregate]`) keyed to the target case, with the treatment table, a summary of the breakdown, and the supporting language for negative / criticized / overruled treatments highlighted.

## SDK verbs

- `browse.resources`, `browse.annotations`, `gather.annotation`, `mark.delegate` (tagging mode), `yield.resource`

## Parameters

| Parameter | Type | Default | Purpose |
|---|---|---|---|
| `<targetCaseResourceId>` | CLI arg | required | Which case's subsequent treatment to analyze |
| `TREATMENT_TAG_SCHEMA` | env var | `positive,negative,distinguished,criticized,overruled,neutral` | Override the controlled vocabulary |

## Tier-3 interactive checkpoint

Before run: prints citing-case count, asks `confirm`. Per citing case (interactive only): treatment-classification preview before saving.

## Run it

**Prerequisites:**
- `detect-citations` (skill 2) and `ground-citations` (skill 6) have been run.
- (Recommended) `assess-holdings` (skill 5) has been run on the target case — sharpens the model's understanding of what's being treated.

```bash
HOST_ADDR=$(container run --rm node:24-alpine sh -c "ip route | awk '/default/{print \$3}'" 2>/dev/null | tr -d '[:space:]')

container run --rm -v "$(pwd):/work" -w /work \
  -e SEMIONT_API_URL=http://${HOST_ADDR}:4000 \
  node:24-alpine \
  sh -c 'npm ci --no-audit --no-fund && npx tsx skills/subsequent-treatment/script.ts <targetCaseResourceId>'
```

The script prints an address: open it in a browser and approve the sign-in. [Signing in](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/SIGN-IN.md) has the other ways a script can sign in.

Add `-e SEMIONT_INTERACTIVE=1 -it` for the per-citation classification preview.

## Guidance for the AI assistant

- **Quality scales with model + context.** A bigger context window (`±1500` chars default) helps the model see the citation in its argumentative setting; smaller windows produce noisier classifications.
- **`overruled` is rare and consequential.** Overruling is the strongest negative treatment in U.S. caselaw — it means the citing case's holding repudiates the cited case's holding. Surfacing one in a corpus warrants a closer human read.
- **Re-running creates a new SubsequentTreatment resource.** The skill doesn't replace prior runs — successive runs over time can be diffed to see treatment shifts. List by created-at on the target case to see the evolution.
- **Treatment tags live on the citing-case annotations.** Each citing annotation accumulates a `tagging` body with the treatment value, so downstream tooling can ask "show me every place where case X has been negatively treated" by querying tags.
