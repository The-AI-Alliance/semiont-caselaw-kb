/**
 * subsequent-treatment — for a target case, walk every citing case and
 * classify the treatment via mark.assist (tagging), then synthesize a
 * SubsequentTreatment resource summarizing.
 *
 * Usage: tsx skills/subsequent-treatment/script.ts <targetCaseResourceId> [--interactive]
 */

import {
  SemiontClient,
  entityType,
  resourceId as ridBrand,
  type AnnotationId,
  type ResourceId,
} from '@semiont/sdk';
import { confirm, close as closeInteractive } from '../../src/interactive.js';

const TREATMENT_TAG_SCHEMA = (
  process.env.TREATMENT_TAG_SCHEMA ??
  'positive,negative,distinguished,criticized,overruled,neutral'
)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

const TREATMENT_TAGS = TREATMENT_TAG_SCHEMA.map(entityType);

const TREATMENT_INSTRUCTIONS = `
Classify how this passage treats the cited case. Use exactly one tag from the schema:
${TREATMENT_TAG_SCHEMA.map((t) => `  - ${t}`).join('\n')}
Definitions:
  - positive: the citing case relies on, follows, applies, or extends the cited case
  - negative: the citing case rejects or disagrees with the cited case (without overruling)
  - distinguished: the citing case acknowledges but distinguishes the cited case on its facts
  - criticized: the citing case criticizes the reasoning of the cited case
  - overruled: the citing case overrules the cited case in part or whole
  - neutral: a string-cite or background mention with no substantive treatment
Quote the supporting language and apply the tag at the span where the treatment is established.
`.trim();

interface CitingHit {
  citingCaseId: ResourceId;
  citingCaseName: string;
  annId: AnnotationId;
  citationText: string;
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
  const targetIdArg = args[0];
  if (!targetIdArg) {
    console.error('Usage: tsx skills/subsequent-treatment/script.ts <targetCaseResourceId>');
    process.exit(1);
  }
  const targetId = ridBrand(targetIdArg);

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

  const target = all.find((r) => r['@id'] === targetIdArg);
  if (!target) {
    console.error(`Target ${targetIdArg} not found in the KB.`);
    semiont.dispose();
    closeInteractive();
    return;
  }
  const targetName = target.name ?? targetIdArg;

  // Find every citing annotation across the corpus that resolves to the target.
  const citingHits: CitingHit[] = [];
  for (const r of cases) {
    if (r['@id'] === targetIdArg) continue;
    const rId = ridBrand(r['@id']);
    const annotations = await semiont.browse.annotations(rId);
    for (const ann of annotations) {
      if (ann.motivation !== 'linking') continue;
      const tags = (ann.body ?? [])
        .filter((b: any) => b.type === 'TextualBody' && b.purpose === 'tagging')
        .flatMap((b: any) => (Array.isArray(b.value) ? b.value : [b.value]));
      if (!tags.includes('Citation')) continue;
      const targets = (ann.body ?? [])
        .filter((b: any) => b.type === 'SpecificResource' && b.purpose === 'linking')
        .map((b: any) => b.source as string);
      if (!targets.includes(targetIdArg)) continue;
      citingHits.push({
        citingCaseId: rId,
        citingCaseName: r.name ?? r['@id'],
        annId: ann.id,
        citationText: ann.target?.selector?.exact ?? '',
      });
    }
  }

  if (citingHits.length === 0) {
    console.log(`No citing cases found for ${targetName} in this corpus.`);
    semiont.dispose();
    closeInteractive();
    return;
  }

  console.log(`Found ${citingHits.length} citing-annotation(s) for "${targetName}".`);
  console.log(`Treatment vocabulary: ${TREATMENT_TAG_SCHEMA.join(', ')}`);
  const proceed = await confirm(
    `Run mark.assist (tagging mode) on each citing case to classify treatment?`,
    true,
  );
  if (!proceed) {
    console.log('Aborted.');
    semiont.dispose();
    closeInteractive();
    return;
  }

  // Run treatment classification per citing case. mark.assist scopes the
  // tagging pass to the whole citing case but the model is instructed to tag
  // only at the citation context.
  const perCaseAnnotations = new Map<string, CitingHit[]>();
  for (const hit of citingHits) {
    const k = hit.citingCaseId as unknown as string;
    if (!perCaseAnnotations.has(k)) perCaseAnnotations.set(k, []);
    perCaseAnnotations.get(k)!.push(hit);
  }

  for (const citingCaseId of perCaseAnnotations.keys()) {
    const hits = perCaseAnnotations.get(citingCaseId)!;
    const scopedInstructions =
      TREATMENT_INSTRUCTIONS +
      `\n\nFocus only on passages that cite "${targetName}" and classify those passages.`;
    try {
      const progress = await semiont.mark.assist(
        ridBrand(citingCaseId),
        'tagging',
        {
          entityTypes: TREATMENT_TAGS,
          instructions: scopedInstructions,
        },
      );
      const n = progress.progress?.createdCount ?? 0;
      console.log(`  ${hits[0].citingCaseName}: ${n} treatment tag(s)`);
    } catch (err) {
      console.warn(`  ! ${hits[0].citingCaseName}: ${(err as Error).message}`);
    }
  }

  // Aggregate the per-case treatment tags into a single SubsequentTreatment
  // resource. Re-walk the citing cases' annotations to collect the new tagging
  // results.
  console.log('\nAggregating treatment classifications...');
  type TreatmentRow = {
    citingCaseName: string;
    citingCaseId: string;
    treatments: string[];
    quotes: string[];
  };
  const rows: TreatmentRow[] = [];
  const breakdown = new Map<string, number>();
  for (const t of TREATMENT_TAG_SCHEMA) breakdown.set(t, 0);

  for (const [citingCaseId, hits] of perCaseAnnotations) {
    const annotations = await semiont.browse.annotations(ridBrand(citingCaseId));
    const taggedHits: { treatments: string[]; quote: string }[] = [];
    for (const ann of annotations) {
      if (ann.motivation !== 'tagging') continue;
      const tags = (ann.body ?? [])
        .filter((b: any) => b.type === 'TextualBody' && b.purpose === 'tagging')
        .flatMap((b: any) => (Array.isArray(b.value) ? b.value : [b.value]))
        .filter((t: string) => TREATMENT_TAG_SCHEMA.includes(t));
      if (tags.length === 0) continue;
      taggedHits.push({
        treatments: tags,
        quote: ann.target?.selector?.exact ?? '',
      });
      for (const t of tags) breakdown.set(t, (breakdown.get(t) ?? 0) + 1);
    }
    if (taggedHits.length === 0) continue;
    rows.push({
      citingCaseName: hits[0].citingCaseName,
      citingCaseId,
      treatments: Array.from(new Set(taggedHits.flatMap((h) => h.treatments))),
      quotes: taggedHits.map((h) => h.quote).filter(Boolean),
    });
  }

  const lines: string[] = [
    `# Subsequent treatment: ${targetName}`,
    '',
    `Auto-generated subsequent-treatment report for [${targetName}](${targetIdArg}). ` +
      `Generated: ${new Date().toISOString()}.`,
    '',
    `**Citing cases analyzed:** ${perCaseAnnotations.size}.`,
    '',
    '## Treatment breakdown',
    '',
  ];
  for (const t of TREATMENT_TAG_SCHEMA) {
    lines.push(`- **${t}:** ${breakdown.get(t) ?? 0}`);
  }
  lines.push('', '## Per-citing-case treatment', '');
  if (rows.length === 0) {
    lines.push('*No treatment tags were applied. Re-run with a stronger model or interactive review.*');
  } else {
    lines.push('| # | Citing case | Treatment(s) | Resource |');
    lines.push('|---|---|---|---|');
    rows.forEach((row, i) => {
      lines.push(
        `| ${i + 1} | ${row.citingCaseName} | ${row.treatments.join(', ')} | [${row.citingCaseId}](${row.citingCaseId}) |`,
      );
    });
  }

  const negativeRows = rows.filter((r) =>
    r.treatments.some((t) => ['negative', 'criticized', 'overruled'].includes(t)),
  );
  if (negativeRows.length > 0) {
    lines.push('', '## Negative / critical / overruling language', '');
    for (const row of negativeRows) {
      lines.push(`### ${row.citingCaseName}`);
      lines.push('');
      for (const q of row.quotes) {
        if (q) lines.push(`> ${q.replace(/\n+/g, ' ')}`);
      }
      lines.push('');
    }
  }

  lines.push(
    '---',
    '',
    `*Synthesized by the \`subsequent-treatment\` skill from grounded citation annotations.*`,
  );

  const body = lines.join('\n') + '\n';
  const { resourceId: treatmentId } = await semiont.yield.resource({
    name: `Subsequent treatment: ${targetName}`,
    file: Buffer.from(body, 'utf-8'),
    format: 'text/markdown',
    entityTypes: ['SubsequentTreatment', 'Aggregate'],
    storageUri: `file://generated/subsequent-treatment-${slugify(targetName)}-${Date.now()}.md`,
  });

  console.log(`\nDone. SubsequentTreatment resource: ${treatmentId} (${body.length} bytes).`);
  semiont.dispose();
  closeInteractive();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
