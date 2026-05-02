/**
 * detect-citations — run eyecite over each Case resource and record one
 * linking-motivation annotation per detected citation, keyed by exact
 * text position.
 *
 * Usage: tsx skills/detect-citations/script.ts [<resourceId>] [--interactive]
 */

import { SemiontClient, resourceId as ridBrand, type ResourceId } from '@semiont/sdk';
import { detectCitations, type DetectedCitation } from '../../src/eyecite.js';
import { confirm, close as closeInteractive } from '../../src/interactive.js';

function getMediaType(r: any): string | undefined {
  const reps = Array.isArray(r.representations)
    ? r.representations
    : r.representations
      ? [r.representations]
      : [];
  return reps[0]?.mediaType;
}

function summarizeByType(citations: DetectedCitation[]): string {
  const counts = new Map<string, number>();
  for (const c of citations) {
    counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${type}: ${n}`)
    .join(', ');
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
    console.log('No Case resources found. Run skills/ingest-cases/script.ts first.');
    semiont.dispose();
    closeInteractive();
    return;
  }

  console.log(`Will run eyecite against ${targets.length} case(s).`);
  console.log(
    `Container runtime: ${process.env.CONTAINER_RUNTIME ?? 'container'}; ` +
      `image: ${process.env.EYECITE_IMAGE_TAG ?? 'semiont-eyecite:latest'}.`,
  );

  let totalCreated = 0;
  let totalCases = 0;

  for (const rId of targets) {
    totalCases++;
    let body: string;
    try {
      body = await semiont.browse.resourceContent(rId);
    } catch (err) {
      console.warn(`  ! ${rId}: failed to fetch body: ${(err as Error).message}`);
      continue;
    }

    let citations: DetectedCitation[];
    try {
      citations = await detectCitations(body);
    } catch (err) {
      console.warn(`  ! ${rId}: eyecite failed: ${(err as Error).message}`);
      continue;
    }

    if (citations.length === 0) {
      console.log(`  ${rId}: 0 citations detected`);
      continue;
    }

    console.log(`  ${rId}: ${citations.length} citation(s) — ${summarizeByType(citations)}`);
    const proceed = await confirm(`Create ${citations.length} annotation(s) for this case?`, true);
    if (!proceed) {
      console.log(`  skipped ${rId}`);
      continue;
    }

    for (const c of citations) {
      try {
        await semiont.mark.annotation({
          target: {
            source: rId,
            selector: { type: 'TextPositionSelector', start: c.start, end: c.end },
          },
          motivation: 'linking',
          body: [
            { type: 'TextualBody', purpose: 'tagging', value: 'Citation' },
            { type: 'TextualBody', purpose: 'tagging', value: c.type },
          ],
        });
        totalCreated++;
      } catch (err) {
        console.warn(
          `    ! failed at offsets ${c.start}-${c.end} ("${c.text.slice(0, 40)}…"): ${(err as Error).message}`,
        );
      }
    }
  }

  console.log(
    `\nDone. ${totalCreated} citation annotation(s) created across ${totalCases} case(s).`,
  );
  semiont.dispose();
  closeInteractive();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
