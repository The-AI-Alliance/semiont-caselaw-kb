---
name: build-party-roster
description: Promote every Person, Judge, Plaintiff, Defendant, Petitioner, Respondent, Appellant, Appellee, Counsel mention to a canonical Party resource. Encode the per-case role as the Party resource's entity types.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write
---

You are helping the user build the **party roster** — the who's-who of the caselaw corpus — out of skill 3's entity annotations.

This is a tier-2 skill. It composes `gather.annotation` + `match.search` + `yield.fromAnnotation` + `bind.body`, similar to the legal-kb's `build-party-graph` and the gutenberg-kb's `build-character-articles` patterns.

Foundational for skill 11 (`doctrinal-trace`), which surfaces "judges who write on this issue" empirically from the roster.

## What it does

1. `browse.annotations` across Case resources; filter to `linking`-motivation annotations whose tagging body includes one of: `Person`, `Judge`, `Plaintiff`, `Defendant`, `Petitioner`, `Respondent`, `Appellant`, `Appellee`, `Counsel`.
2. Cluster annotations by canonical text (case-insensitive surface form).
3. For each cluster:
   - `gather.annotation` for context — same surname might refer to different parties across cases.
   - `match.search` for an existing Party resource with this name.
   - If a candidate scores ≥ `MATCH_THRESHOLD`: `bind.body` the annotation to it.
   - Otherwise: `yield.fromAnnotation` to synthesize a new `Party` resource with role tags as additional entity types (e.g., `[Party, Judge]` for a judge mention).

The Party resource's body markdown captures: full name, role(s) inferred from the annotations, and the cluster-size (number of case references).

## SDK verbs

- `browse.resources`, `browse.annotations`, `gather.annotation`, `match.search`, `yield.fromAnnotation`, `bind.body`

## Parameters

| Parameter | Type | Default | Purpose |
|---|---|---|---|
| `MATCH_THRESHOLD` | env var | 30 | Cluster-merge / candidate-binding threshold |

## Tier-3 interactive checkpoint

Before pass: prints cluster summary, asks `confirm`. Per cluster (interactive only): per-synthesis confirm with the candidate text.

## Run it

**Prerequisite: `mark-judicial-entities` (skill 3) has been run.**

```bash
HOST_ADDR=$(container run --rm node:24-alpine sh -c "ip route | awk '/default/{print \$3}'" 2>/dev/null | tr -d '[:space:]')

container run --rm -v "$(pwd):/work" -w /work \
  -e SEMIONT_API_URL=http://${HOST_ADDR}:4000 \
  -e SEMIONT_USER_EMAIL=admin@example.com \
  -e SEMIONT_USER_PASSWORD=<your-password> \
  node:24-alpine \
  sh -c 'npm install --silent --no-fund @semiont/sdk tsx && npx tsx skills/build-party-roster/script.ts'
```

Add `-e SEMIONT_INTERACTIVE=1 -it` for the per-cluster confirms.

## Guidance for the AI assistant

- **Same surname across cases is genuinely ambiguous.** "Judge Brown" in one case is not necessarily "Judge Brown" in another. The cluster step is exact-text; the match.search step's gather context is what disambiguates. Borderline scores benefit from interactive review.
- **Role tags promote to entity types.** A `Plaintiff`-tagged mention that synthesizes into a Party resource gets `[Party, Plaintiff]` entity types. A second mention of the same person as a `Defendant` (in a different case) appends `Defendant` to that Party resource's types — supporting "list every Party that's been both plaintiff and defendant" queries.
- **Foundation for `doctrinal-trace`.** Skill 11 walks the Party graph to surface judges-who-wrote-on-this-doctrine and counsel-who-recurred. Run this skill before skill 11.
