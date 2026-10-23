/**
 * tag-irac — apply IRAC tags to substantive paragraphs in each case using
 * the `legal-irac` tag schema.
 *
 * Tag schemas are runtime-registered per KB (see semiont's
 * .plans/TAG-SCHEMAS-GAP.md). This skill self-registers `legal-irac`
 * before calling `mark.delegate`; re-runs are silent at the projection
 * layer because the content matches.
 *
 * Usage: tsx skills/tag-irac/script.ts [<resourceId>] [--interactive]
 */

import { SemiontSession, InMemorySessionStorage, httpKb, resourceId as ridBrand, type ResourceId } from '@semiont/sdk';
import { confirm, close as closeInteractive } from '../../src/interactive.js';
import { LEGAL_IRAC_SCHEMA } from '../../src/tag-schemas.js';
import { getMediaType } from '../../src/media-type.js';

const SCHEMA_ID = LEGAL_IRAC_SCHEMA.id;
const CATEGORIES = LEGAL_IRAC_SCHEMA.tags.map((t) => t.name);


async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const explicitResourceId = args[0];

  const gateway = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
  const opened = await SemiontSession.signInDevice({
    kb: httpKb({
      id: 'caselaw-tag-irac',
      label: 'caselaw tag-irac',
      host: gateway.hostname,
      port: Number(gateway.port) || 4000,
      protocol: gateway.protocol === 'https:' ? 'https' : 'http',
    }),
    storage: new InMemorySessionStorage(),
    onCode: ({ verificationUri, verificationUriComplete, userCode }) => {
      console.error(`Approve this script at ${verificationUriComplete ?? verificationUri}`);
      if (!verificationUriComplete) console.error(`Code: ${userCode}`);
    },
  });
  const semiont = opened.session.client;

  try {
    // Register the schema before any mark.delegate call. Idempotent — the
    // projection silently no-ops if the same content is already registered.
    await semiont.frame.addTagSchema(LEGAL_IRAC_SCHEMA);

    let targets: ResourceId[];
    if (explicitResourceId) {
      targets = [ridBrand(explicitResourceId)];
    } else {
      const all = (await semiont.browse.resources({ limit: 1000 }).fresh()).resources;
      targets = all
        .filter((r) => {
          const isCase = (r.entityTypes ?? []).some((t) => t === 'Case');
          const mt = getMediaType(r);
          return isCase && (mt === 'text/markdown' || mt === 'text/plain');
        })
        .map((r) => r['@id']);
    }

    if (targets.length === 0) {
      console.log('No Case resources found.');
      closeInteractive();
      return;
    }

    console.log(
      `Will run mark.delegate (motivation: tagging, schemaId: ${SCHEMA_ID}, ` +
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
      const done = await semiont.mark.delegate(rId, {
        motivation: 'tagging',
        schemaId: SCHEMA_ID,
        categories: CATEGORIES,
      });
      const n = done.result && 'persisted' in done.result ? done.result.persisted : 0;
      totalCreated += n;
      console.log(`  ${rId}: ${n} IRAC tags`);
    }

    console.log(`\nDone. Created ${totalCreated} IRAC-tagged annotations.`);
    closeInteractive();
  } finally {
    opened.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
