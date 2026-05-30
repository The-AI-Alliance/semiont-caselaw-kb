/**
 * assess-holdings — flag holdings, dicta, disposition, procedural posture.
 *
 * Single mark.assist with motivation 'assessing'. More focused than
 * tag-irac; surfaces the load-bearing spans of each opinion.
 *
 * Usage: tsx skills/assess-holdings/script.ts [<resourceId>] [--interactive]
 */

import { SemiontSession, InMemorySessionStorage, type KnowledgeBase, resourceId as ridBrand, type ResourceId } from '@semiont/sdk';
import { confirm, close as closeInteractive } from '../../src/interactive.js';
import { createdCount } from '../../src/mark-result.js';

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
    id: 'caselaw-assess-holdings',
    label: 'caselaw assess-holdings',
    email,
    endpoint: { kind: 'http', host: u.hostname, port: Number(u.port) || 4000, protocol: u.protocol.replace(':', '') as 'http' | 'https' },
  };
  const session = await SemiontSession.signInHttp({ kb, storage: new InMemorySessionStorage(), baseUrl, email, password });
  const semiont = session.client;

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
    await session.dispose();
    closeInteractive();
    return;
  }

  const firstLine = INSTRUCTIONS.split('\n')[0];
  console.log(`Will run mark.assist (motivation: assessing) against ${targets.length} case(s).`);
  console.log(`  Focus: ${firstLine}`);
  const proceed = await confirm('Proceed?', true);
  if (!proceed) {
    console.log('Aborted.');
    await session.dispose();
    closeInteractive();
    return;
  }

  let totalCreated = 0;
  for (const rId of targets) {
    const progress = await semiont.mark.assist(rId, 'assessing', { instructions: INSTRUCTIONS });
    const n = createdCount(progress);
    totalCreated += n;
    console.log(`  ${rId}: ${n} flagged spans`);
  }

  console.log(`\nDone. Flagged ${totalCreated} holdings/dicta/disposition/posture spans.`);
  await session.dispose();
  closeInteractive();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
