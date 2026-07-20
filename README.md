# Caselaw Knowledge Base

[![Lint](https://github.com/The-AI-Alliance/semiont-caselaw-kb/actions/workflows/lint.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont-caselaw-kb/actions/workflows/lint.yml?query=branch%3Amain)
[![License](https://img.shields.io/github/license/The-AI-Alliance/semiont-caselaw-kb)](https://github.com/The-AI-Alliance/semiont-caselaw-kb/blob/main/LICENSE)

Real United States case law — Supreme Court opinions and state appellate cases — formatted for citation tracking, annotation, and legal knowledge extraction with [Semiont](https://github.com/The-AI-Alliance/semiont).

## About This Dataset

This repository contains two subsets of real, public-domain U.S. case law:

- **[`citizens_united/`](citizens_united/)** — *Citizens United v. FEC*, the 2010 Supreme Court decision on campaign finance and First Amendment rights. Sourced from the [Cornell Legal Information Institute](https://www.law.cornell.edu/supct/html/08-205.ZS.html); ingested as a single resource per opinion (the `ingest-cases` skill does not split opinions into chunks).
- **[`caselaw/`](caselaw/)** — A 100-case sample of New Hampshire Supreme Court opinions, ingested as separate resources from the HuggingFace [`free-law/nh`](https://huggingface.co/datasets/free-law/nh) dataset.

Both subsets ship with citation detection enabled. The [`src/`](src/) directory contains TypeScript helpers — `courtlistener.ts` (Citation Lookup API client), `uscode.ts` (US Code bulk XML lookup), `huggingface.ts` and `legal-text.ts` (per-source ingestion helpers). The Python script [`skills/detect-citations/detect_citations.py`](skills/detect-citations/detect_citations.py) wraps the [eyecite](https://github.com/freelawproject/eyecite) library for high-precision legal-citation extraction (matching cases like *Bush v. Gore, 531 U.S. 98 (2000)* with their exact source text positions); the [`skills/detect-citations/run.sh`](skills/detect-citations/run.sh) bash wrapper drives the three-phase pipeline (fetch case bodies → run eyecite → emit annotations), and [`skills/detect-citations/Dockerfile`](skills/detect-citations/Dockerfile) packages the Python eyecite runtime.

This corpus is well-suited for entity recognition across cases, justices, parties, and statutes; building citation graphs across precedent; tracking doctrinal evolution; and demonstrating end-to-end legal knowledge graph construction with verifiable provenance.

## Skills

This repo ships eleven skills that build a layered caselaw-research KB on top of the Semiont SDK. See [AGENTS.md](AGENTS.md) for the full design discussion.

| Skill | What it does |
|---|---|
| [`ingest-cases`](skills/ingest-cases/SKILL.md) | Walk every `<corpus>/config.yaml`, fetch source (HuggingFace `free-law/*` or Cornell LII), create one resource per case. |
| [`detect-citations`](skills/detect-citations/SKILL.md) | Run eyecite over each case; record one annotation per citation with text-position selectors. |
| [`mark-judicial-entities`](skills/mark-judicial-entities/SKILL.md) | Detect Person, Judge, Plaintiff, Defendant, Counsel, Court, Date, LegalStandard mentions. |
| [`tag-irac`](skills/tag-irac/SKILL.md) | Apply IRAC tags (Issue / Rule / Application / Conclusion) to substantive paragraphs. |
| [`assess-holdings`](skills/assess-holdings/SKILL.md) | Flag central holdings, dicta, dispositions, procedural-posture statements. |
| [`ground-citations`](skills/ground-citations/SKILL.md) | Resolve each citation to a local Case resource or fetch from CourtListener; statutory citations route to skill 8. |
| [`build-citation-graph`](skills/build-citation-graph/SKILL.md) | Synthesize a PrecedentGraph resource per case summarizing its citation neighborhood. |
| [`extract-statutory-refs`](skills/extract-statutory-refs/SKILL.md) | Resolve statutory citations to Statute resources fetched from US Code bulk XML. |
| [`build-party-roster`](skills/build-party-roster/SKILL.md) | Promote every Person/Judge/Plaintiff/etc. mention to a canonical Party resource. |
| [`subsequent-treatment`](skills/subsequent-treatment/SKILL.md) | For a target case, classify how every citing case treats it (positive / negative / distinguished / criticized / overruled / neutral). |
| [`doctrinal-trace`](skills/doctrinal-trace/SKILL.md) | Capstone — given a doctrine query, synthesize a research memo across the corpus. |

## Quick Start

Explore this dataset using [Semiont](https://github.com/The-AI-Alliance/semiont), an open-source knowledge base platform for annotation and knowledge extraction.

This repo follows the same layout and startup flow as [`semiont-template-kb`](https://github.com/The-AI-Alliance/semiont-template-kb). See its README for full setup instructions:

- [Quick Start: Local](https://github.com/The-AI-Alliance/semiont-template-kb#quick-start-local) — run the Semiont stack on your machine via `semiont start`
- [Quick Start: Codespaces](https://github.com/The-AI-Alliance/semiont-template-kb#quick-start-codespaces) — launch a preconfigured stack in the cloud
- [Inference Configuration](https://github.com/The-AI-Alliance/semiont-template-kb#inference-configuration) — Ollama (local) vs. Anthropic (cloud) configs

### Open in Codespaces

**Prerequisites:** the [Semiont launcher](https://github.com/The-AI-Alliance/semiont/tree/main/apps/launcher) (`brew install the-ai-alliance/semiont/semiont`) and the [GitHub CLI (`gh`)](https://cli.github.com/), signed in with `gh auth login`.

> **Before creating:** add `ANTHROPIC_API_KEY` as a [user secret](https://github.com/settings/codespaces) with this repo selected. Otherwise the backend comes up but inference is non-functional until you add the secret and rebuild the container.

One command creates the codespace (or resumes the one you already have), waits for the stack to answer, forwards the KB to your machine, and prints the auto-generated admin credentials:

```bash
semiont start --runtime codespace --repo The-AI-Alliance/semiont-caselaw-kb
```

The browser runs **locally** and connects to any number of knowledge bases — cloud or local:

```bash
semiont start --service frontend
```

Open **http://localhost:3000** and add the KB in the **Knowledge Bases** panel, using the port and credentials the launcher printed (`semiont status` re-prints them). `semiont stop --repo The-AI-Alliance/semiont-caselaw-kb` halts billing and keeps your state; add `--delete` to destroy the codespace.

<details>
<summary>Without the launcher: the raw <code>gh</code> recipe</summary>

```bash
gh codespace create --repo The-AI-Alliance/semiont-caselaw-kb --machine premiumLinux
gh codespace ports forward 3000:3000 4000:4000   # leave running
gh codespace ssh -- cat '/workspaces/*/.devcontainer/admin.json' # in another terminal
#   (ssh lands in /home/vscode, not the workspace — hence the absolute,
#    quoted path: the quotes keep your shell from expanding it locally)
```

This forwards the codespace's own browser as well, so you open **http://localhost:3000** and sign in with those credentials. If `gh` rejects the forward with `must have admin rights to Repository`, grant the scope once: `gh auth refresh -h github.com -s codespace`.

</details>

## License

Apache 2.0 — See [LICENSE](LICENSE) for details.
