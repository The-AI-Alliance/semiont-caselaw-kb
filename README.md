# Caselaw Knowledge Base

Real United States case law — Supreme Court opinions and state appellate cases — formatted for citation tracking, annotation, and legal knowledge extraction with [Semiont](https://github.com/The-AI-Alliance/semiont).

## About This Dataset

This repository contains two subsets of real, public-domain U.S. case law:

- **[`citizens_united/`](citizens_united/)** — *Citizens United v. FEC*, the 2010 Supreme Court decision on campaign finance and First Amendment rights. Sourced from the [Cornell Legal Information Institute](https://www.law.cornell.edu/supct/html/08-205.ZS.html), chunked into ~5KB segments with a linked Table of Contents.
- **[`caselaw/`](caselaw/)** — A 100-case sample of New Hampshire Supreme Court opinions, ingested as separate resources from the HuggingFace [`free-law/nh`](https://huggingface.co/datasets/free-law/nh) dataset.

Both subsets ship with citation detection enabled. The [`src/`](src/) directory contains TypeScript helpers for legal citation handling (`legal-citations.ts`, `legal-text.ts`) and per-source handlers for Cornell LII and HuggingFace ingestion. The Python script [`detect_citations.py`](detect_citations.py) wraps the [eyecite](https://github.com/freelawproject/eyecite) library for high-precision legal-citation extraction (matching cases like *Bush v. Gore, 531 U.S. 98 (2000)* with their exact source text positions).

This corpus is well-suited for entity recognition across cases, justices, parties, and statutes; building citation graphs across precedent; tracking doctrinal evolution; and demonstrating end-to-end legal knowledge graph construction with verifiable provenance.

## Quick Start

Explore this dataset using [Semiont](https://github.com/The-AI-Alliance/semiont), an open-source knowledge base platform for annotation and knowledge extraction.

This repo follows the same layout and startup flow as [`semiont-template-kb`](https://github.com/The-AI-Alliance/semiont-template-kb). See its README for full setup instructions:

- [Quick Start: Local](https://github.com/The-AI-Alliance/semiont-template-kb#quick-start-local) — run the backend stack on your machine via `.semiont/scripts/start.sh`
- [Quick Start: Codespaces](https://github.com/The-AI-Alliance/semiont-template-kb#quick-start-codespaces) — launch a preconfigured backend in the cloud
- [Inference Configuration](https://github.com/The-AI-Alliance/semiont-template-kb#inference-configuration) — Ollama (local) vs. Anthropic (cloud) configs

### Open in Codespaces

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://github.com/codespaces/new/The-AI-Alliance/semiont-caselaw-kb)

> **Before launching:** add `ANTHROPIC_API_KEY` as a [user secret](https://github.com/settings/codespaces) with this repo selected. Otherwise the backend comes up but inference is non-functional until you add the secret and rebuild the container.

## License

Apache 2.0 — See [LICENSE](LICENSE) for details.
