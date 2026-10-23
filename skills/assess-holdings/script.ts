/**
 * assess-holdings — flag holdings, dicta, disposition, procedural posture.
 *
 * Single mark.delegate with motivation 'assessing'. More focused than
 * tag-irac; surfaces the load-bearing spans of each opinion.
 *
 * Usage: tsx skills/assess-holdings/script.ts [<resourceId>] [--interactive]
 */

import { SemiontSession, InMemorySessionStorage, httpKb, resourceId as ridBrand, type ResourceId } from '@semiont/sdk';
import { confirm, close as closeInteractive } from '../../src/interactive.js';
import { getMediaType } from '../../src/media-type.js';

const DEFAULT_INSTRUCTIONS = `
Identify and flag the spine of this judicial opinion. For each, quote the language and
note which of the four categories it falls into:
  - holding: the legal conclusion(s) that decide the case (the bound rule)
  - dicta: judicial commentary not necessary to the decision
  - disposition: affirmed / reversed / vacated / remanded / dismissed
  - procedural-posture: how the case got here (appeal from X, certified question, etc.)
Skip narrative paragraphs and quoted authority.
`.trim();

const INSTRUCTIONS = process.env.ASSESS_INSTRUCTIONS ?? DEFAULT_INSTRUCTIONS;


async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const explicitResourceId = args[0];

  const gateway = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
  const opened = await SemiontSession.signInDevice({
    kb: httpKb({
      id: 'caselaw-assess-holdings',
      label: 'caselaw assess-holdings',
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

    const firstLine = INSTRUCTIONS.split('\n')[0];
    console.log(`Will run mark.delegate (motivation: assessing) against ${targets.length} case(s).`);
    console.log(`  Focus: ${firstLine}`);
    const proceed = await confirm('Proceed?', true);
    if (!proceed) {
      console.log('Aborted.');
      closeInteractive();
      return;
    }

    let totalCreated = 0;
    for (const rId of targets) {
      const done = await semiont.mark.delegate(rId, { motivation: 'assessing', instructions: INSTRUCTIONS });
      const n = done.result && 'persisted' in done.result ? done.result.persisted : 0;
      totalCreated += n;
      console.log(`  ${rId}: ${n} flagged spans`);
    }

    console.log(`\nDone. Flagged ${totalCreated} holdings/dicta/disposition/posture spans.`);
    closeInteractive();
  } finally {
    opened.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
