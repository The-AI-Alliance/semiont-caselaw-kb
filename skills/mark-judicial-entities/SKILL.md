---
name: mark-judicial-entities
description: Detect Person, Judge, Plaintiff, Defendant, Petitioner, Respondent, Appellant, Appellee, Counsel, Court, Jurisdiction, Date, LegalStandard mentions across the case corpus. Tags spans for resolution by skill 9 (build-party-roster).
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write
---

You are helping the user detect formally-named judicial-entity mentions across a caselaw corpus.

This is one of three tier-1 marking skills for caselaw (alongside `tag-irac` and `assess-holdings`). It uses `mark.assist` with motivation `linking` to tag every named-entity span — the names that appear in the caption, the judges who write or join opinions, the parties to the litigation, and the counsel listed.

## What it does

For each Case resource (or one specific resource), runs `mark.assist({ motivation: 'linking', entityTypes: [...] })`. The default type list spans the thirteen entity types most useful for caselaw research.

## SDK verbs

- `browse.resources` — find Case targets
- `mark.assist({ motivation: 'linking', entityTypes: [...] })`

## Parameters

| Parameter | Type | Default | Purpose |
|---|---|---|---|
| `<resourceId>` | CLI arg (optional) | all Case resources | Scope to one |
| `ENTITY_TYPES` | env var | `Person,Judge,Plaintiff,Defendant,Petitioner,Respondent,Appellant,Appellee,Counsel,Court,Jurisdiction,Date,LegalStandard` | Override or extend |

## Tier-3 interactive checkpoint

Before run: prints target count + entity types, asks `confirm`.

## Run it

**Prerequisite: `ingest-cases` has been run.**

```bash
HOST_ADDR=$(container run --rm node:24-alpine sh -c "ip route | awk '/default/{print \$3}'" 2>/dev/null | tr -d '[:space:]')

container run --rm -v "$(pwd):/work" -w /work \
  -e SEMIONT_API_URL=http://${HOST_ADDR}:4000 \
  -e SEMIONT_USER_EMAIL=admin@example.com \
  -e SEMIONT_USER_PASSWORD=<your-password> \
  node:24-alpine \
  sh -c 'npm install --silent --no-fund @semiont/sdk tsx && npx tsx skills/mark-judicial-entities/script.ts'
```

Add `-e SEMIONT_INTERACTIVE=1 -it` for the confirm prompt.

## Guidance for the AI assistant

- **Annotations stay unresolved.** Skill 9 (`build-party-roster`) clusters and promotes to first-class `Party` resources, then binds these annotations.
- **Role tags survive on the Party resource.** When skill 9 promotes a Person → Party, the role-specific tags (`Judge`, `Plaintiff`, etc.) become entity types on the Party resource itself, enabling structured queries like "show me every case where this Party served as Judge."
- **Re-running adds annotations cumulatively.** No deduplication.
