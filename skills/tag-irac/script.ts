/**
 * tag-irac — apply IRAC tags to substantive paragraphs in each case via the
 * registered `legal-irac` tag schema (packages/ontology/src/tag-schemas.ts).
 *
 * mark.assist with motivation 'tagging' requires a registered schemaId plus
 * the categories to apply. The worker validates both against the registry
 * and stamps the resulting annotation with a 'classifying'-purpose body
 * (the schema id) and a 'tagging'-purpose body (the chosen category).
 *
 * Usage: tsx skills/tag-irac/script.ts [<resourceId>] [--interactive]
 */

import { SemiontClient, resourceId as ridBrand, type ResourceId } from '@semiont/sdk';
import { confirm, close as closeInteractive } from '../../src/interactive.js';

const SCHEMA_ID = 'legal-irac';
const CATEGORIES = ['Issue', 'Rule', 'Application', 'Conclusion'];

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
    `Will run mark.assist (motivation: tagging, schemaId: ${SCHEMA_ID}, ` +
      `categories: ${CATEGORIES.join(', ')}) against ${targets.length} case(s).`,
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
      schemaId: SCHEMA_ID,
      categories: CATEGORIES,
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
