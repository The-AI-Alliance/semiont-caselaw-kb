/**
 * mark-judicial-entities — detect formally-named entity spans across the
 * case corpus.
 *
 * mark.delegate with motivation 'linking', no descriptive references.
 * Targets Case resources only.
 *
 * Usage: tsx skills/mark-judicial-entities/script.ts [<resourceId>] [--interactive]
 */

import { SemiontSession, InMemorySessionStorage, httpKb, entityType, resourceId as ridBrand, type ResourceId } from '@semiont/sdk';
import { confirm, close as closeInteractive } from '../../src/interactive.js';
import { getMediaType } from '../../src/media-type.js';

const ENTITY_TYPES = (
  process.env.ENTITY_TYPES ??
  'Person,Judge,Plaintiff,Defendant,Petitioner,Respondent,Appellant,Appellee,Counsel,Court,Jurisdiction,Date,LegalStandard'
)
  .split(',')
  .map((t) => entityType(t.trim()));


async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const explicitResourceId = args[0];

  const gateway = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
  const session = await SemiontSession.signInDevice({
    kb: httpKb({
      id: 'caselaw-mark-judicial-entities',
      label: 'caselaw mark-judicial-entities',
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
  const semiont = session.client;

  try {
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
      `Will run mark.delegate (motivation: linking, ${ENTITY_TYPES.length} entity types) ` +
        `against ${targets.length} case(s).`,
    );

    const proceed = await confirm('Proceed?', true);
    if (!proceed) {
      console.log('Aborted.');
      closeInteractive();
      return;
    }

    let totalCreated = 0;
    for (const rId of targets) {
      const done = await semiont.mark.delegate(rId, { motivation: 'linking', entityTypes: ENTITY_TYPES });
      const n = done.result && 'persisted' in done.result ? done.result.persisted : 0;
      totalCreated += n;
      console.log(`  ${rId}: ${n} new annotations`);
    }

    console.log(`\nDone. Created ${totalCreated} judicial-entity annotations.`);
    closeInteractive();
  } finally {
    await session.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
