/**
 * tag-irac — apply IRAC tags to substantive paragraphs in each case using
 * the `legal-irac` tag schema.
 *
 * Tag schemas are runtime-registered per KB (see semiont's
 * .plans/TAG-SCHEMAS-GAP.md). This skill self-registers `legal-irac`
 * before calling `mark.assist`; re-runs are silent at the projection
 * layer because the content matches.
 *
 * Usage: tsx skills/tag-irac/script.ts [<resourceId>] [--interactive]
 */

import { SemiontSession, InMemorySessionStorage, type KnowledgeBase, resourceId as ridBrand, type ResourceId } from '@semiont/sdk';
import { confirm, close as closeInteractive } from '../../src/interactive.js';
import { createdCount } from '../../src/mark-result.js';
import { LEGAL_IRAC_SCHEMA } from '../../src/tag-schemas.js';

const SCHEMA_ID = LEGAL_IRAC_SCHEMA.id;
const CATEGORIES = LEGAL_IRAC_SCHEMA.tags.map((t) => t.name);

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

  const baseUrl = process.env.SEMIONT_API_URL ?? 'http://localhost:4000';
  const email = process.env.SEMIONT_USER_EMAIL!;
  const password = process.env.SEMIONT_USER_PASSWORD!;
  const u = new URL(baseUrl);
  const kb: KnowledgeBase = {
    id: 'caselaw-tag-irac',
    label: 'caselaw tag-irac',
    email,
    endpoint: { kind: 'http', host: u.hostname, port: Number(u.port) || 4000, protocol: u.protocol.replace(':', '') as 'http' | 'https' },
  };
  const session = await SemiontSession.signInHttp({ kb, storage: new InMemorySessionStorage(), baseUrl, email, password });
  const semiont = session.client;

  try {
    // Register the schema before any mark.assist call. Idempotent — the
    // projection silently no-ops if the same content is already registered.
    await semiont.frame.addTagSchema(LEGAL_IRAC_SCHEMA);

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
      closeInteractive();
      return;
    }

    let totalCreated = 0;
    for (const rId of targets) {
      const progress = await semiont.mark.assist(rId, 'tagging', {
        schemaId: SCHEMA_ID,
        categories: CATEGORIES,
      });
      const n = createdCount(progress);
      totalCreated += n;
      console.log(`  ${rId}: ${n} IRAC tags`);
    }

    console.log(`\nDone. Created ${totalCreated} IRAC-tagged annotations.`);
    closeInteractive();
  } finally {
    await session.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
