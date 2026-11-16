---
name: tag-irac
description: Apply IRAC tags (Issue / Rule / Application / Conclusion) to substantive paragraphs in each case. Skip narrative and procedural text. Becomes the substrate for skill 11 (`doctrinal-trace`), which keys off Rule and Application paragraphs.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write
---

You are helping the user tag paragraphs in judicial opinions with their IRAC components — the canonical legal-analysis frame.

## What IRAC is

For non-lawyers reading along: IRAC is the standard frame for reading a judicial opinion.

- **Issue** — the legal question presented.
- **Rule** — the legal rule the court applies.
- **Application** — how the rule applies to the case's facts.
- **Conclusion** — the disposition / holding.

A well-written opinion makes IRAC structure explicit. Many opinions don't, and a single paragraph can blur the categories — the skill applies *at most one* tag per paragraph and skips paragraphs that are purely procedural or narrative.

## What it does

For each Case resource (or one specific resource), runs `mark.assist({ motivation: 'tagging', instructions: ..., entityTypes: ['Issue', 'Rule', 'Application', 'Conclusion'] })`. Each tagged span carries one of the four IRAC tags as its body.

## SDK verbs

- `browse.resources`, `mark.assist({ motivation: 'tagging', ... })`

## Parameters

| Parameter | Type | Default | Purpose |
|---|---|---|---|
| `<resourceId>` | CLI arg (optional) | all Case resources | Scope to one |
| `IRAC_INSTRUCTIONS` | env var | the standard IRAC tagging directive | Override |

## Tier-3 interactive checkpoint

Before run: prints target count, asks `confirm`.

## Run it

**Prerequisite: `ingest-cases` has been run.**

```bash
HOST_ADDR=$(container run --rm node:24-alpine sh -c "ip route | awk '/default/{print \$3}'" 2>/dev/null | tr -d '[:space:]')

container run --rm -v "$(pwd):/work" -w /work \
  -e SEMIONT_API_URL=http://${HOST_ADDR}:4000 \
  -e SEMIONT_USER_EMAIL=admin@example.com \
  -e SEMIONT_USER_PASSWORD=<your-password> \
  node:24-alpine \
  sh -c 'npm install --silent --no-fund @semiont/sdk tsx && npx tsx skills/tag-irac/script.ts'
```

Add `-e SEMIONT_INTERACTIVE=1 -it` for the confirm prompt.

## Guidance for the AI assistant

- **Quality scales with the model.** With a stronger backend model (Claude Opus / Sonnet), IRAC tagging is reasonably accurate; with smaller models, expect more mis-classifications. Spot-check a few cases interactively before running the corpus-wide pass.
- **The Rule + Application tags drive `doctrinal-trace`.** Skill 11 walks Rule paragraphs to find cases that articulate a doctrine, and Application paragraphs to see how the doctrine has been applied.
- **One tag per paragraph; not every paragraph gets one.** Procedural posture, factual narration, and meta-commentary stay un-tagged. Re-tuning the directive via `IRAC_INSTRUCTIONS` is how you change that policy.
