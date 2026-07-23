# AGENTS.md — semiont-caselaw-kb (and any caselaw KB)

This is a caselaw-flavored Semiont knowledge base. The corpus is real public-domain U.S. caselaw — state-supreme-court opinions from a HuggingFace `free-law/*` dataset, plus a U.S. Supreme Court opinion from Cornell LII. The skills detect citations (via eyecite), tag IRAC structure, ground citations to remote case lookups (via CourtListener), build precedent graphs, link cases to their statutory framework, classify subsequent treatment, and synthesize doctrinal-trace research memos.

If you're an AI assistant working in this repo, this file is your orientation. The skills are **corpus-generic** — swap in a different `free-law/*` dataset or a different Cornell LII opinion via the per-corpus YAML configs and the same skills work without modification.

## What's here

- **`<corpus-name>/config.yaml`** (one per corpus subdirectory) — declares the source (HuggingFace dataset id, or Cornell LII opinion URL) and processing options. Skill 1 (`ingest-cases`) reads these.
- **`src/`** — small helper modules:
  - `src/huggingface.ts` — HuggingFace `free-law/*` dataset client (rows API, document conversion)
  - `src/legal-text.ts` — Cornell LII opinion fetcher + markdown formatter
  - `src/courtlistener.ts` — REST client for the Free Law Project's CourtListener Citation Lookup API, with file-cache to stay under the free-tier rate limit
  - `src/uscode.ts` — US Code lookup against `uscode.house.gov` bulk XML, cached locally per title
  - `src/interactive.ts` — `confirm` / `pick` / `preview` helpers for tier-3 interactive checkpoints
- **`skills/detect-citations/`** — the only skill that's not a single `script.ts`. Ships a bash wrapper (`run.sh`) driving a three-phase pipeline: `fetch.ts` (Node) → `detect_citations.py` (Python, in the `semiont-eyecite` container) → `emit.ts` (Node). Plus a `Dockerfile` for the Python runtime.
- **`skills/`** — eleven skills, each shipping a `SKILL.md` plus a `script.ts` that uses `@semiont/sdk` against the running backend. (`detect-citations` is the exception — see above.)

| Skill | What it does | New SDK verbs |
|---|---|---|
| [`ingest-cases`](skills/ingest-cases/) | Read every `<corpus>/config.yaml`, declare the KB's entity-type vocabulary, fetch the source, create one resource per case | `frame.addEntityTypes`, `yield.resource` |
| [`detect-citations`](skills/detect-citations/) | Run eyecite over each case; record one annotation per citation | `mark.annotation` × *N* |
| [`mark-judicial-entities`](skills/mark-judicial-entities/) | Detect Person, Judge, Plaintiff, Defendant, Counsel, Court, Date, LegalStandard mentions | `mark.assist` (linking) |
| [`tag-irac`](skills/tag-irac/) | Apply IRAC tags (Issue / Rule / Application / Conclusion) to substantive paragraphs | `mark.assist` (tagging) |
| [`assess-holdings`](skills/assess-holdings/) | Flag the central holdings, dicta, disposition, procedural posture | `mark.assist` (assessing) |
| [`ground-citations`](skills/ground-citations/) | Resolve every citation to a local case or fetch from CourtListener | `+ gather.annotation`, `match.search`, `bind.body`, `yield.resource` |
| [`build-citation-graph`](skills/build-citation-graph/) | Synthesize a PrecedentGraph resource per case (cited-by, citing-of) | `+ yield.resource` per case |
| [`extract-statutory-refs`](skills/extract-statutory-refs/) | Resolve statutory citations to Statute resources fetched from US Code | `yield.resource`, `bind.body` |
| [`build-party-roster`](skills/build-party-roster/) | Promote Person/Judge/etc. mentions to Party resources, encode role bindings | `+ yield.fromAnnotation` |
| [`subsequent-treatment`](skills/subsequent-treatment/) | For a target case, classify the treatment in every citing case | `mark.assist` (tagging), `yield.resource` |
| [`doctrinal-trace`](skills/doctrinal-trace/) | Given a doctrine query, synthesize a research memo across the corpus | full pipeline composition |

## What is caselaw research, really?

Working legal research usually involves answering one of these:

1. **What does this case say?** — extracting holding from dicta, identifying the procedural posture, the rule, the issue (the IRAC frame).
2. **Is this case still good law?** — checking later citations for treatment (positive, distinguished, criticized, overruled). The function a citator provides.
3. **What's the citation network around this case?** — what it cites, what cites it, who's in its precedent neighborhood.
4. **What's the doctrinal evolution of issue X?** — tracing a legal idea across cases, finding foundational opinions, evolutionary milestones, current state.
5. **What statutes underpin this case?** — anchoring opinions to their statutory framework.
6. **Who are the recurring parties / judges / counsel?** — empirical patterns across a litigation domain.

The Semiont SDK is well-suited for the structural questions (1, 3, 4, 5, 6). The skills below demonstrate that — turning a raw set of judicial opinions into a queryable network of Case, Statute, Party, PrecedentGraph, SubsequentTreatment, and DoctrinalTrace resources, all anchored back to the source paragraphs.

## Entity types used in this KB

- **Cases**: `Case`, `JudicialOpinion`, `SupremeCourt`, `StateCourt` (extensible per jurisdiction)
- **Statutory framework**: `Statute`, `Regulation`, `ConstitutionalProvision`
- **People & roles**: `Party` (umbrella; produced by `build-party-roster`), plus the role tags `Person`, `Judge`, `Plaintiff`, `Defendant`, `Petitioner`, `Respondent`, `Appellant`, `Appellee`, `Counsel`
- **Adjudicative bodies**: `Court`, `Jurisdiction`
- **Legal substance**: `LegalStandard`, `Doctrine`
- **Citations**: `Citation` (the citation-text annotation; resolves to `Case` or `Statute` after grounding)
- **Synthesized aggregates**: `PrecedentGraph`, `SubsequentTreatment`, `DoctrinalTrace`

## Tag schemas

This KB uses two controlled-vocabulary tag schemas applied via `mark.assist({ motivation: 'tagging', ... })`:

- **IRAC** (skill 4) — `Issue` / `Rule` / `Application` / `Conclusion`. Applied at the paragraph level. Skip narrative or procedural text.
- **Treatment** (skill 10) — `positive` / `negative` / `distinguished` / `criticized` / `overruled` / `neutral`. Applied to citation contexts in citing cases. Override via `TREATMENT_TAG_SCHEMA` env var if a different vocabulary is preferred.

## Worked example: a doctrinal trace against the seeded corpus

The seeded corpus includes a U.S. Supreme Court opinion (Cornell LII config in `citizens_united/`) and a sample of state-supreme-court opinions (HuggingFace config in `caselaw/`). After running:

1. `ingest-cases` → Case resources per opinion.
2. `detect-citations` → citation annotations on every reporter citation in every case.
3. `mark-judicial-entities` → annotations on judges, parties, counsel.
4. `tag-irac` → IRAC paragraph tags.
5. `assess-holdings` → the central-holding spans flagged.
6. `ground-citations` → citations bound to local cases or to fetched CourtListener stubs.
7. `extract-statutory-refs` → statutory citations bound to US Code Statute resources.
8. `build-citation-graph` → PrecedentGraph resource per case.
9. `subsequent-treatment` → classify how every citing case treats the target.
10. `doctrinal-trace` → given a doctrine query (whatever issue the seeded corpus naturally addresses — the U.S. Supreme Court opinion handles First-Amendment-as-applied-to-corporate-political-speech; the state-court sample covers a cross-section of state-law doctrines), synthesize a research memo.

The DoctrinalTrace memo is the demonstration: a queryable, sourced legal-research artifact that took skills 1–10 to produce. Specific cases / queries appear *only as illustrative names of the seeded data*; the skill bodies themselves take whatever the corpus contains and produce the same shape of memo.

## Working in containers — do not install npm packages on the host

This template assumes a containerized workflow. The backend stack runs in containers (`semiont start` brings it up); the skills run in containers too. There is **no need** to install Node, the SDK, eyecite, or any other tooling on the host machine.

Each skill's `SKILL.md` shows a `container run` invocation that mounts the repo, installs `@semiont/sdk` and `tsx` *inside* a throwaway container, then runs the skill's `script.ts`. See [`skills/ingest-cases/SKILL.md`](skills/ingest-cases/SKILL.md) for the full networking discussion (the `HOST_ADDR` discovery probe).

### Skill 2 needs a Python container

`detect-citations` is the one skill that needs more than a Node runtime — eyecite is Python-only. The skill ships its own [Dockerfile](skills/detect-citations/Dockerfile) that bakes Python 3.12 + eyecite + the `detect_citations.py` script into a single image. Build it once:

```bash
container build -t semiont-eyecite:latest skills/detect-citations
```

Then run [`skills/detect-citations/run.sh`](skills/detect-citations/run.sh), which orchestrates the three-phase pipeline: a Node container fetches case bodies via the SDK, a host-side `for` loop pipes each body through `container run --rm -i semiont-eyecite:latest`, and a second Node container emits one `mark.annotation` per detected citation. The wrapper honors `CONTAINER_RUNTIME` (defaults to `container`; substitute `docker` / `podman` as needed).

## Backend setup

Before running any skill, the Semiont backend stack must be up. Two paths:

### Local: `semiont start`

```bash
brew install the-ai-alliance/semiont/semiont   # once
semiont start
```

Then create the admin user you'll sign in with:

```bash
semiont useradd --email admin@example.com --password password --admin
```

Flags: `--config anthropic` for cloud inference (requires `ANTHROPIC_API_KEY`), `--no-observe` to skip the Jaeger sidecar (on by default; traces at http://localhost:16686), `--runtime` to force a container runtime. `--config`/`--runtime` are sticky — a bare `semiont start` repeats the last explicitly-passed values. `--help` lists all options.

### Codespaces

Open the repo in a Codespace — `post-create.sh` pulls the stack's images, `post-start.sh` brings it up, admin credentials are auto-generated into `.devcontainer/admin.json`. Print them: `cat .devcontainer/admin.json`. Forward the port: `gh codespace ports forward 4000:4000`.

## Parameterization and interactivity

Skills are parameterized in three tiers.

### Tier 1 — environment configuration

| Var | Purpose |
|---|---|
| `SEMIONT_API_URL` | Backend URL (default `http://localhost:4000`) |
| `SEMIONT_USER_EMAIL` | Authenticating user |
| `SEMIONT_USER_PASSWORD` | Authenticating user's password |
| `COURTLISTENER_API_KEY` | Optional; raises CourtListener rate-limit ceiling |
| `CONTAINER_RUNTIME` | `container` / `docker` / `podman` (default `container`) — used by `skills/detect-citations/run.sh` |
| `EYECITE_IMAGE_TAG` | Default `semiont-eyecite:latest` — override if you tag the image differently |

### Tier 2 — skill-invocation parameters

Per-skill env vars and CLI args. Most skills accept `MATCH_THRESHOLD` (default 30) for cluster-merge / candidate binding. Tier-1 mark skills accept `ENTITY_TYPES` to override the default type list. Instruction text for `tag-irac` / `assess-holdings` / `subsequent-treatment` is exposed as `IRAC_INSTRUCTIONS` / `ASSESS_INSTRUCTIONS` / `TREATMENT_TAG_SCHEMA` so users can retune focus without editing TypeScript. `subsequent-treatment` takes the target-case resourceId as a CLI arg; `doctrinal-trace` takes the doctrine query. See each skill's `SKILL.md` for specifics.

### Tier 3 — interactive checkpoints

Off by default (batch automation works as before). Enable per-run with `--interactive` (CLI flag) or `SEMIONT_INTERACTIVE=1` (env var). Skills pause at natural decision points and show what they found / what they're about to do, letting the user steer.

The same render-what-found logic runs in non-interactive mode — output goes to logs instead of pausing for input.

Tier-2 env vars can pre-answer tier-3 prompts (e.g., `MATCH_THRESHOLD=25` pre-answers cluster-merge confidence; `DOCTRINE_QUERY="qualified immunity"` pre-answers the doctrinal-trace query elicitation). The "interactive once, scripted thereafter" workflow falls out naturally.

CourtListener and US Code rate-limit considerations interact directly with tier-3 prompts: the "before batch fetch" checkpoint exists specifically so a user can preview the budget impact before committing to a run that consumes significant API quota.

## A primer on IRAC

If you're an agent unfamiliar with U.S. legal-analysis conventions: **IRAC** is the standard frame for reading judicial opinions. *Issue* — the legal question presented. *Rule* — the legal rule the court applies. *Application* — how the rule applies to the case's facts. *Conclusion* — the disposition / holding. Skill 4 tags substantive paragraphs with the corresponding IRAC component; skill 11 (`doctrinal-trace`) keys off the *Rule* + *Application* tags to follow doctrinal threads through the corpus.

## Background reading

| Where | What |
|---|---|
| [`@semiont/sdk` README](https://github.com/The-AI-Alliance/semiont/tree/main/packages/sdk) | The TypeScript surface — eight verbs (frame, yield, mark, match, bind, gather, browse, beckon) plus admin/auth/job. |
| [SDK Usage docs](https://github.com/The-AI-Alliance/semiont/tree/main/packages/sdk/docs) | Cache semantics, reactive model, state units, error handling. |
| [Semiont protocol docs](https://github.com/The-AI-Alliance/semiont/tree/main/docs/protocol) | The eight-flow framing. |
| [eyecite](https://github.com/freelawproject/eyecite) | The Python library used in skill 2. |
| [CourtListener API](https://www.courtlistener.com/api/) | The REST API used in skill 6 for citation grounding. |
| [US Code bulk XML](https://uscode.house.gov/download/) | Source of statutory text for skill 8. |
| [.plans/CASELAW-SKILLS.md](.plans/CASELAW-SKILLS.md) | The full design plan for these skills. |
