---
name: assess-holdings
description: Flag the central holdings, dicta, the disposition (affirmed / reversed / remanded), and procedural posture statements in each judicial opinion. More focused than `tag-irac` — about identifying the load-bearing pieces of the opinion.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write
---

You are helping the user identify the spine of each judicial opinion — the holdings that bind, the dicta that don't, the procedural disposition, and the procedural posture (came up on appeal from X, certified question from Y).

This is more focused than `tag-irac` (which annotates *every* substantive paragraph). Use it when you want a smaller, sharper layer surfacing the most-cited bits of the opinion.

## What it does

For each Case resource (or one specific resource), runs `mark.assist({ motivation: 'assessing', instructions: ... })`. Each flagged span carries an assessing-motivation annotation noting which of the four categories it falls into:

- the **central holding(s)** — the legal conclusion(s) that decide the case
- **dicta** — judicial commentary not necessary to the decision
- the **disposition** — affirmed / reversed / vacated / remanded
- the **procedural posture** — how the case got here

## SDK verbs

- `browse.resources`, `mark.assist({ motivation: 'assessing', instructions: ... })`

## Parameters

| Parameter | Type | Default | Purpose |
|---|---|---|---|
| `<resourceId>` | CLI arg (optional) | all Case resources | Scope to one |
| `ASSESS_INSTRUCTIONS` | env var | the standard holdings/dicta/disposition/posture directive | Override |

## Tier-3 interactive checkpoint

Before run: prints target count + first line of the instruction text, asks `confirm`.

## Run it

**Prerequisite: `ingest-cases` has been run.**

```bash
HOST_ADDR=$(container run --rm node:24-alpine sh -c "ip route | awk '/default/{print \$3}'" 2>/dev/null | tr -d '[:space:]')

container run --rm -v "$(pwd):/work" -w /work \
  -e SEMIONT_API_URL=http://${HOST_ADDR}:4000 \
  -e SEMIONT_USER_EMAIL=admin@example.com \
  -e SEMIONT_USER_PASSWORD=<your-password> \
  node:24-alpine \
  sh -c 'npm install --silent --no-fund @semiont/sdk tsx && npx tsx skills/assess-holdings/script.ts'
```

Add `-e SEMIONT_INTERACTIVE=1 -it` for the confirm prompt.

## Guidance for the AI assistant

- **Holding vs. dicta is judgment.** The line is contested even among lawyers. The model's classification is a *first pass*; the assessing annotation makes the call queryable, not authoritative. Tier-3 interactive review for cases that matter.
- **Used by `subsequent-treatment` (skill 10).** When skill 10 walks citing cases, knowing what the *target* case actually held narrows the analysis to "is this citing case agreeing with / distinguishing / criticizing the holding?".
