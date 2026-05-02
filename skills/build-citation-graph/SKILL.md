---
name: build-citation-graph
description: For every Case resource, synthesize a PrecedentGraph resource summarizing its citation neighborhood — cited-by count, citing-of count, named cases on each side, jurisdiction breakdown.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write
---

You are helping the user build the precedent network — what each case cites and what cites each case. After this skill, every Case resource has an associated **PrecedentGraph resource** in its sidebar that summarizes the citation neighborhood.

## What it does

For each Case resource (or one specific resource):

1. **Outgoing** — `browse.annotations(caseId)` for every `linking` annotation tagged `Citation` whose body resolves to another Case resource (skill 6's output). Collect those target Case ids.
2. **Incoming** — across the corpus, `browse.annotations(otherCaseId)` for every `linking` annotation that resolves to *this* case. Collect those source Case ids.
3. `yield.resource` a PrecedentGraph resource (entity types `[PrecedentGraph, Aggregate]`) with markdown body containing:
   - **Citation summary**: outgoing count, incoming count.
   - **Cases this case cites**: a markdown table listing target case names + their resourceIds.
   - **Cases citing this case**: a markdown table.
   - (Optional) **Jurisdiction breakdown**: a small histogram of citing-court entity types.

The PrecedentGraph is itself a resource — it lives next to the case it describes, queryable as `browse.resources({ entityType: 'PrecedentGraph' })`.

## SDK verbs

- `browse.resources`, `browse.annotations`, `yield.resource` (one PrecedentGraph per case)

## Parameters

| Parameter | Type | Default | Purpose |
|---|---|---|---|
| `<caseResourceId>` | CLI arg (optional) | all Case resources | Restrict to one case |

## Tier-3 interactive checkpoint

Before yield: prints case count + estimated graph-resource count, asks `confirm`.

## Run it

**Prerequisites: `detect-citations` (skill 2) and `ground-citations` (skill 6) have been run.** Without skill 6's grounding, citation annotations have no `SpecificResource` body items, and the graph is empty.

```bash
HOST_ADDR=$(container run --rm node:24-alpine sh -c "ip route | awk '/default/{print \$3}'" 2>/dev/null | tr -d '[:space:]')

container run --rm -v "$(pwd):/work" -w /work \
  -e SEMIONT_API_URL=http://${HOST_ADDR}:4000 \
  -e SEMIONT_USER_EMAIL=admin@example.com \
  -e SEMIONT_USER_PASSWORD=<your-password> \
  node:24-alpine \
  sh -c 'npm install --silent --no-fund @semiont/sdk tsx && npx tsx skills/build-citation-graph/script.ts'
```

Add `-e SEMIONT_INTERACTIVE=1 -it` for the confirm prompt.

## Guidance for the AI assistant

- **Re-running rebuilds the graphs.** Because the citation edges may have changed (new cases ingested, new citations bound), the safest path is delete-then-rebuild. The skill doesn't auto-delete — it creates new PrecedentGraph resources alongside existing ones. Hand-delete prior runs if you want a clean rebuild.
- **CourtListener stub cases get graphs too.** A stub case (synthesized by skill 6 from CourtListener metadata) is a Case resource and gets a PrecedentGraph showing what cites it locally — but its outgoing-citation row is empty (the stub's body has no citation annotations).
- **Foundational cases stand out.** A case with high incoming-citation count is a foundational case in the corpus. The graph makes this empirically queryable: sort PrecedentGraph resources by incoming-count, and the top entries are the doctrine's anchors.
