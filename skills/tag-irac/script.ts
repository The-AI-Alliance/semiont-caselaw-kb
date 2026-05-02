/**
 * tag-irac — apply IRAC tags to substantive paragraphs in each case.
 *
 * mark.assist with motivation 'tagging' and a four-value tag schema
 * (Issue / Rule / Application / Conclusion). The model is instructed to
 * skip narrative/procedural paragraphs.
 *
 * Usage: tsx skills/tag-irac/script.ts [<resourceId>] [--interactive]
 */

import { SemiontClient, entityType, resourceId as ridBrand, type ResourceId } from '@semiont/sdk';
import { confirm, close as closeInteractive } from '../../src/interactive.js';

const DEFAULT_INSTRUCTIONS = `
For each substantive paragraph in this judicial opinion, apply one of:
  - Issue       (the legal question presented)
  - Rule        (the legal rule applied or articulated)
  - Application (the application of the rule to the facts)
  - Conclusion  (the disposition or holding)
Apply at most one tag per paragraph. Skip paragraphs that are:
  - factual narration of the case background
  - procedural posture / docket history
  - meta-commentary or footnote discussion
The tag value should be exactly one of "Issue", "Rule", "Application", "Conclusion".
`.trim();

const INSTRUCTIONS = process.env.IRAC_INSTRUCTIONS ?? DEFAULT_INSTRUCTIONS;
const IRAC_TAGS = ['Issue', 'Rule', 'Application', 'Conclusion'].map(entityType);

function getMediaType(r: any): string | undefined {
  const reps = Array.isArray(r.representations)
    ? r.representations
    : r.representations
      ? [r.representations]
      : [];
  return reps[0]?.mediaType;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const explicitResourceId = args[0];

  const semiont = await SemiontClient.signInHttp({
    baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
    email: process.env.SEMIONT_USER_EMAIL!,
    password: process.env.SEMIONT_USER_PASSWORD!,
  });

  let targets: ResourceId[];
  if (explicitResourceId) {
    targets = [ridBrand(explicitResourceId)];
  } else {
    const all = await semiont.browse.resources({ limit: 1000 });
    targets = all
      .filter((r) => {
        const isCase = (r.entityTypes ?? []).some((t) => t === 'Case');
        const mt = getMediaType(r);
        return isCase && (mt === 'text/markdown' || mt === 'text/plain');
      })
      .map((r) => ridBrand(r['@id']));
  }

  if (targets.length === 0) {
    console.log('No Case resources found.');
    semiont.dispose();
    closeInteractive();
    return;
  }

  console.log(
    `Will run mark.assist (motivation: tagging, IRAC schema) against ${targets.length} case(s).`,
  );
  const proceed = await confirm('Proceed?', true);
  if (!proceed) {
    console.log('Aborted.');
    semiont.dispose();
    closeInteractive();
    return;
  }

  let totalCreated = 0;
  for (const rId of targets) {
    const progress = await semiont.mark.assist(rId, 'tagging', {
      instructions: INSTRUCTIONS,
      entityTypes: IRAC_TAGS,
    });
    const n = progress.progress?.createdCount ?? 0;
    totalCreated += n;
    console.log(`  ${rId}: ${n} IRAC tags`);
  }

  console.log(`\nDone. Created ${totalCreated} IRAC-tagged annotations.`);
  semiont.dispose();
  closeInteractive();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
