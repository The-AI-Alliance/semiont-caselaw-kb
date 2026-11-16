# register-tag-schemas

Register every tag schema this KB owns (`legal-irac`, `argument-toulmin`,
`legal-citation-treatment`) with the runtime registry. One-time bootstrap
for a fresh KB; re-running is harmless (identical re-registrations are
silent at the projection layer).

Skills that use a specific schema (`tag-irac`, `subsequent-treatment`)
also self-register the schemas they need, so this skill is mostly useful
for making the full schema set available to the TaggingPanel UI before
running any specific skill.

## When to run

- After standing up a fresh KB (no existing `__system__` events for tag schemas).
- After wiping the KB's state directory.
- Before opening the TaggingPanel UI on a KB that hasn't run any tagging skill yet.

## Usage

```sh
tsx skills/register-tag-schemas/script.ts
```

Requires `SEMIONT_API_URL`, `SEMIONT_USER_EMAIL`, `SEMIONT_USER_PASSWORD`
in the environment (same as every other skill in this KB).

## What gets registered

Schemas live in [`src/tag-schemas.ts`](../../src/tag-schemas.ts):

- **`legal-irac`** — Issue / Rule / Application / Conclusion (legal reasoning).
- **`argument-toulmin`** — Claim / Evidence / Warrant / Counterargument / Rebuttal (argumentation).
- **`legal-citation-treatment`** — positive / negative / distinguished / criticized / overruled / neutral (citator-style citation analysis).
