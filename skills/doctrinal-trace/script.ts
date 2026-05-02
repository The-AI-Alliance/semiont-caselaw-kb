/**
 * doctrinal-trace — given a doctrine query, synthesize a research memo.
 *
 * Pulls candidate cases via match.search, gathers their IRAC tags,
 * ranks by incoming-citation count from PrecedentGraph resources,
 * overlays SubsequentTreatment classifications, and yields a single
 * DoctrinalTrace resource with the composed memo.
 *
 * Usage: tsx skills/doctrinal-trace/script.ts ["<doctrine query>"] [--interactive]
 */

import { SemiontClient, resourceId as ridBrand, type ResourceId } from '@semiont/sdk';
import { confirm, close as closeInteractive } from '../../src/interactive.js';

const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD ?? 30);
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES ?? 15);

interface CandidateCase {
  rId: ResourceId;
  rIdRaw: string;
  name: string;
  score: number;
  iracExcerpts: { tag: string; text: string }[];
  incomingCount: number;
  outgoingCount: number;
  negativeTreatments: string[];
}

function getMediaType(r: any): string | undefined {
  const reps = Array.isArray(r.representations)
    ? r.representations
    : r.representations
      ? [r.representations]
      : [];
  return reps[0]?.mediaType;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 80);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const queryArg = args.join(' ').trim();
  const query = queryArg || process.env.DOCTRINE_QUERY;
  if (!query) {
    console.error(
      'Usage: tsx skills/doctrinal-trace/script.ts "<doctrine query>" ' +
        '(or set DOCTRINE_QUERY env var)',
    );
    process.exit(1);
  }

  const semiont = await SemiontClient.signInHttp({
    baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
    email: process.env.SEMIONT_USER_EMAIL!,
    password: process.env.SEMIONT_USER_PASSWORD!,
  });

  const all = await semiont.browse.resources({ limit: 1000 });
  const cases = all.filter((r) => {
    const isCase = (r.entityTypes ?? []).some((t) => t === 'Case');
    const mt = getMediaType(r);
    return isCase && (mt === 'text/markdown' || mt === 'text/plain');
  });
  if (cases.length === 0) {
    console.log('No Case resources found.');
    semiont.dispose();
    closeInteractive();
    return;
  }

  // Step 1 — match.search across the corpus with the query as the search text.
  // We use the search filter on browse.resources for the first-pass selection;
  // it's coarser than match.search but doesn't need an annotation anchor.
  const filtered = await semiont.browse.resources({ limit: 100, search: query });
  const candidates: CandidateCase[] = filtered
    .filter((r) => (r.entityTypes ?? []).some((t) => t === 'Case'))
    .slice(0, MAX_CANDIDATES)
    .map((r) => ({
      rId: ridBrand(r['@id']),
      rIdRaw: r['@id'],
      name: r.name ?? r['@id'],
      score: 0,
      iracExcerpts: [],
      incomingCount: 0,
      outgoingCount: 0,
      negativeTreatments: [],
    }));

  if (candidates.length === 0) {
    // Fallback: take the top-N cases ordered by name and keep going. Empty
    // search shouldn't kill a memo — the reader still sees an empty trace
    // with the structure intact.
    cases.slice(0, MAX_CANDIDATES).forEach((r) => {
      candidates.push({
        rId: ridBrand(r['@id']),
        rIdRaw: r['@id'],
        name: r.name ?? r['@id'],
        score: 0,
        iracExcerpts: [],
        incomingCount: 0,
        outgoingCount: 0,
        negativeTreatments: [],
      });
    });
  }

  console.log(`Query: "${query}"`);
  console.log(`Top ${candidates.length} candidate case(s):`);
  for (const c of candidates) {
    console.log(`  - ${c.name}`);
  }

  const proceed = await confirm('Proceed with these candidates?', true);
  if (!proceed) {
    console.log('Aborted.');
    semiont.dispose();
    closeInteractive();
    return;
  }

  // Step 2 — gather IRAC excerpts (Rule + Application paragraphs) per candidate.
  console.log('\nGathering IRAC excerpts and citation-graph data...');
  for (const c of candidates) {
    const annotations = await semiont.browse.annotations(c.rId);
    for (const ann of annotations) {
      if (ann.motivation === 'tagging') {
        const tags = (ann.body ?? [])
          .filter((b: any) => b.type === 'TextualBody' && b.purpose === 'tagging')
          .flatMap((b: any) => (Array.isArray(b.value) ? b.value : [b.value]));
        if (tags.includes('Rule') || tags.includes('Application')) {
          const text = ann.target?.selector?.exact ?? '';
          if (text) {
            c.iracExcerpts.push({
              tag: tags.find((t: string) => t === 'Rule' || t === 'Application') ?? 'unknown',
              text: text.slice(0, 600),
            });
          }
        }
      }
      if (ann.motivation === 'linking') {
        const tags = (ann.body ?? [])
          .filter((b: any) => b.type === 'TextualBody' && b.purpose === 'tagging')
          .flatMap((b: any) => (Array.isArray(b.value) ? b.value : [b.value]));
        if (tags.includes('Citation')) {
          const targets = (ann.body ?? [])
            .filter((b: any) => b.type === 'SpecificResource' && b.purpose === 'linking')
            .map((b: any) => b.source as string);
          if (targets.length > 0) c.outgoingCount++;
        }
      }
    }
  }

  // Compute incoming-citation counts: walk every other Case's annotations and
  // count those whose body resolves to a candidate.
  const candidateIds = new Set(candidates.map((c) => c.rIdRaw));
  for (const r of cases) {
    if (candidateIds.has(r['@id'])) {
      // skip self-walk; candidates' own annotations were walked above
    }
    const annotations = await semiont.browse.annotations(ridBrand(r['@id']));
    for (const ann of annotations) {
      if (ann.motivation !== 'linking') continue;
      const tags = (ann.body ?? [])
        .filter((b: any) => b.type === 'TextualBody' && b.purpose === 'tagging')
        .flatMap((b: any) => (Array.isArray(b.value) ? b.value : [b.value]));
      if (!tags.includes('Citation')) continue;
      const targets = (ann.body ?? [])
        .filter((b: any) => b.type === 'SpecificResource' && b.purpose === 'linking')
        .map((b: any) => b.source as string);
      for (const t of targets) {
        if (candidateIds.has(t)) {
          const c = candidates.find((cc) => cc.rIdRaw === t);
          if (c) c.incomingCount++;
        }
      }
    }
  }

  // Surface negative SubsequentTreatment classifications per candidate.
  const treatmentResources = all.filter((r) =>
    (r.entityTypes ?? []).some((t) => t === 'SubsequentTreatment'),
  );
  for (const c of candidates) {
    for (const tr of treatmentResources) {
      if (!(tr.name ?? '').includes(c.name)) continue;
      try {
        const body = await semiont.browse.resourceContent(ridBrand(tr['@id']));
        const negSection = body.match(/## Negative \/ critical \/ overruling language[\s\S]*$/);
        if (negSection) {
          c.negativeTreatments.push(`See ${tr.name} (${tr['@id']})`);
        }
      } catch {
        // resource fetch can fail; skip.
      }
    }
  }

  // Step 3 — order: foundational (high incomingCount) first, then evolutionary
  // milestones (cases that cite foundational ones), then the rest.
  candidates.sort((a, b) => b.incomingCount - a.incomingCount);
  const foundational = candidates.filter((c) => c.incomingCount >= 1).slice(0, 5);
  const evolutionary = candidates.filter((c) => !foundational.includes(c)).slice(0, 5);

  // Step 4 — compose memo.
  const lines: string[] = [
    `# Doctrinal trace: ${query}`,
    '',
    `Auto-generated research memo synthesized across ${candidates.length} candidate ` +
      `case(s) in the corpus. Generated: ${new Date().toISOString()}.`,
    '',
    '## Issue statement',
    '',
    `> ${query}`,
    '',
    '## Foundational cases',
    '',
  ];
  if (foundational.length === 0) {
    lines.push(
      '*No cases in the corpus stand out as foundational by incoming-citation count. ' +
        'Run `build-citation-graph` (skill 7) first to surface foundational anchors.*',
    );
  } else {
    for (const c of foundational) {
      lines.push(
        `### [${c.name}](${c.rIdRaw}) — cited by ${c.incomingCount}, cites ${c.outgoingCount}`,
      );
      lines.push('');
      if (c.iracExcerpts.length > 0) {
        for (const ex of c.iracExcerpts.slice(0, 2)) {
          lines.push(`- **${ex.tag}**: ${ex.text}`);
        }
      } else {
        lines.push('*No IRAC excerpts available — run `tag-irac` (skill 4) for richer trace.*');
      }
      if (c.negativeTreatments.length > 0) {
        lines.push('');
        lines.push(`> ⚠️ Negative subsequent treatment: ${c.negativeTreatments.join('; ')}`);
      }
      lines.push('');
    }
  }

  lines.push('## Evolutionary milestones', '');
  if (evolutionary.length === 0) {
    lines.push('*No additional cases surfaced beyond the foundational set.*');
  } else {
    for (const c of evolutionary) {
      lines.push(`- [${c.name}](${c.rIdRaw}) — cites ${c.outgoingCount} other case(s)`);
      if (c.iracExcerpts[0]) {
        lines.push(`  - **${c.iracExcerpts[0].tag}**: ${c.iracExcerpts[0].text}`);
      }
    }
  }

  lines.push('', '## Open questions', '');
  const flagged = candidates.filter((c) => c.negativeTreatments.length > 0);
  if (flagged.length === 0) {
    lines.push(
      '*No flagged negative treatments in the corpus. (Run `subsequent-treatment` against ' +
        'foundational cases for a sharper picture.)*',
    );
  } else {
    for (const c of flagged) {
      lines.push(`- **${c.name}** — ${c.negativeTreatments.join('; ')}`);
    }
  }

  lines.push('', '## Citation list', '');
  for (const c of candidates) {
    lines.push(`- [${c.name}](${c.rIdRaw})`);
  }

  lines.push(
    '',
    '---',
    '',
    `*Synthesized by the \`doctrinal-trace\` skill from query "${query}". ` +
      `The memo is reproducible — re-run when the corpus grows for an updated trace.*`,
  );

  const body = lines.join('\n') + '\n';

  const previewLines = body.split('\n').slice(0, 60).join('\n');
  console.log('\n----- Memo preview -----');
  console.log(previewLines);
  console.log('-----');

  const proceedYield = await confirm('Yield this DoctrinalTrace resource?', true);
  if (!proceedYield) {
    console.log('Aborted before yield.');
    semiont.dispose();
    closeInteractive();
    return;
  }

  const { resourceId: traceId } = await semiont.yield.resource({
    name: `Doctrinal trace: ${query}`,
    file: Buffer.from(body, 'utf-8'),
    format: 'text/markdown',
    entityTypes: ['DoctrinalTrace', 'Aggregate'],
    storageUri: `file://generated/doctrinal-trace-${slugify(query)}-${Date.now()}.md`,
  });

  console.log(`\nDone. DoctrinalTrace resource: ${traceId} (${body.length} bytes).`);
  semiont.dispose();
  closeInteractive();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
