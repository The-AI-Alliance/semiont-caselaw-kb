/**
 * detect-citations — phase 3: read the eyecite output for every staged
 * case, emit one `mark.annotation` per detected citation.
 *
 * Each annotation carries motivation `linking` and a `TextPositionSelector`
 * with the exact byte offsets eyecite reported. The body tags the eyecite
 * citation type (`FullCaseCitation`, `IdCitation`, etc.) and stamps the
 * entity-type `Citation` so `ground-citations` can pick them up.
 *
 * Usage: tsx skills/detect-citations/emit.ts <inDir>
 */

import { SemiontClient, resourceId as ridBrand } from '@semiont/sdk';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

// How much surrounding text to include in TextQuoteSelector.prefix /
// .suffix. Enough to disambiguate citation A from a textually-identical
// citation B elsewhere in the same opinion; small enough not to bloat
// the JSON. Matches the ~80-char window mark.assist uses.
const CONTEXT_WINDOW = 80;

interface DetectedCitation {
  text: string;
  start: number;
  end: number;
  type: string;
}

function summarizeByType(cs: DetectedCitation[]): string {
  const counts = new Map<string, number>();
  for (const c of cs) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}=${n}`)
    .join(', ');
}

async function main(): Promise<void> {
  const [inDir] = process.argv.slice(2);
  if (!inDir) {
    console.error('Usage: tsx emit.ts <inDir>');
    process.exit(2);
  }

  const files = readdirSync(inDir).filter((f) => f.endsWith('.citations.json'));
  if (files.length === 0) {
    console.log(`No .citations.json files in ${inDir}/. Did phase 2 run?`);
    return;
  }

  const semiont = await SemiontClient.signInHttp({
    baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
    email: process.env.SEMIONT_USER_EMAIL!,
    password: process.env.SEMIONT_USER_PASSWORD!,
  });

  let totalCreated = 0;
  let totalFailed = 0;

  for (const f of files) {
    const rIdStr = basename(f, '.citations.json');
    const rId = ridBrand(rIdStr);
    const raw = readFileSync(join(inDir, f), 'utf-8');
    const { citations } = JSON.parse(raw) as { citations: DetectedCitation[] };

    if (citations.length === 0) {
      console.log(`  ${rIdStr}: 0 citations`);
      continue;
    }

    // Load the matching body to populate TextQuoteSelector.prefix/.suffix.
    // Without these, annotation cards in the UI render with no visible
    // text — the body's `exact` carries the citation itself, prefix/suffix
    // give the surrounding context.
    const bodyPath = join(inDir, `${rIdStr}.body`);
    const body = existsSync(bodyPath) ? readFileSync(bodyPath, 'utf-8') : null;

    console.log(`  ${rIdStr}: ${citations.length} citation(s) — ${summarizeByType(citations)}`);

    for (const c of citations) {
      const prefix = body ? body.slice(Math.max(0, c.start - CONTEXT_WINDOW), c.start) : '';
      const suffix = body ? body.slice(c.end, c.end + CONTEXT_WINDOW) : '';
      try {
        await semiont.mark.annotation({
          target: {
            source: rId,
            selector: [
              { type: 'TextPositionSelector', start: c.start, end: c.end },
              { type: 'TextQuoteSelector', exact: c.text, prefix, suffix },
            ],
          },
          motivation: 'linking',
          body: [
            { type: 'TextualBody', purpose: 'tagging', value: 'Citation' },
            { type: 'TextualBody', purpose: 'tagging', value: c.type },
          ],
        });
        totalCreated++;
      } catch (err) {
        totalFailed++;
        console.warn(
          `    ! failed ${c.start}-${c.end} ("${c.text.slice(0, 40)}…"): ${(err as Error).message}`,
        );
      }
    }
  }

  console.log(`\nDone. Created ${totalCreated} citation annotation(s) (${totalFailed} failed).`);
  semiont.dispose();
}

main().catch((e) => { console.error(e); process.exit(1); });
