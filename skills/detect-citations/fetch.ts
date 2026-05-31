/**
 * detect-citations — phase 1: fetch every Case resource's body and stage it
 * on disk for eyecite to process.
 *
 * Writes one `<resourceId>.body` file per Case under
 * `.cache/citation-detection/`. The bash wrapper (`run.sh`) then pipes each
 * body through the semiont-eyecite container; phase 3 (`emit.ts`) reads
 * the resulting `<resourceId>.citations.json` files and emits
 * `mark.annotation` calls.
 *
 * The phase split exists because Apple's `container` runtime doesn't expose
 * a socket the way Docker does — a Node container can't spawn another
 * container. So we orchestrate the per-case eyecite invocation from the
 * host (in bash), with thin Node containers on either side for SDK calls.
 *
 * Usage: tsx skills/detect-citations/fetch.ts <outDir> [<resourceId>]
 */

import { SemiontSession, InMemorySessionStorage, type KnowledgeBase, resourceId as ridBrand, type ResourceId } from '@semiont/sdk';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function getMediaType(r: any): string | undefined {
  const reps = Array.isArray(r.representations)
    ? r.representations
    : r.representations
      ? [r.representations]
      : [];
  return reps[0]?.mediaType;
}

async function main(): Promise<void> {
  const [outDir, explicitResourceId] = process.argv.slice(2);
  if (!outDir) {
    console.error('Usage: tsx fetch.ts <outDir> [<resourceId>]');
    process.exit(2);
  }

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const baseUrl = process.env.SEMIONT_API_URL ?? 'http://localhost:4000';
  const email = process.env.SEMIONT_USER_EMAIL!;
  const password = process.env.SEMIONT_USER_PASSWORD!;
  const u = new URL(baseUrl);
  const kb: KnowledgeBase = {
    id: 'caselaw-detect-citations-fetch',
    label: 'caselaw detect-citations-fetch',
    email,
    endpoint: { kind: 'http', host: u.hostname, port: Number(u.port) || 4000, protocol: u.protocol.replace(':', '') as 'http' | 'https' },
  };
  const session = await SemiontSession.signInHttp({ kb, storage: new InMemorySessionStorage(), baseUrl, email, password });
  const semiont = session.client;

  try {
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
      console.log('No Case resources found. Run skills/ingest-cases/script.ts first.');
      return;
    }

    console.log(`Fetching ${targets.length} case bod${targets.length === 1 ? 'y' : 'ies'} into ${outDir}/`);
    for (const rId of targets) {
      try {
        const body = await semiont.browse.resourceContent(rId);
        const path = join(outDir, `${rId}.body`);
        writeFileSync(path, body, 'utf-8');
        console.log(`  ${rId}: ${body.length} bytes`);
      } catch (err) {
        console.warn(`  ! ${rId}: failed to fetch body: ${(err as Error).message}`);
      }
    }
  } finally {
    await session.dispose();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
