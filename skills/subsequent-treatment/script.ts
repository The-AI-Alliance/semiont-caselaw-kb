/**
 * subsequent-treatment — for a target case, walk every citing case and
 * classify the treatment, then synthesize a SubsequentTreatment resource
 * summarizing.
 *
 * Uses the `legal-citation-treatment` tag schema (six categories:
 * positive / negative / distinguished / criticized / overruled / neutral).
 * The schema is registered at startup; re-runs are silent at the projection
 * layer because the content matches.
 *
 * Each treatment classification lands as a `motivation: 'tagging'`
 * annotation with a `purpose: 'classifying'` body identifying the
 * schema and a `purpose: 'tagging'` body carrying the chosen category.
 *
 * Usage: tsx skills/subsequent-treatment/script.ts <targetCaseResourceId> [--interactive]
 */

import {
  SemiontSession,
  InMemorySessionStorage,
  type KnowledgeBase,
  resourceId as ridBrand,
  type AnnotationId,
  type ResourceId,
} from '@semiont/sdk';
import { confirm, close as closeInteractive } from '../../src/interactive.js';
import { createdCount } from '../../src/mark-result.js';
import { LEGAL_CITATION_TREATMENT_SCHEMA } from '../../src/tag-schemas.js';

const TREATMENT_CATEGORIES = LEGAL_CITATION_TREATMENT_SCHEMA.tags.map((t) => t.name);

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

  const baseUrl = process.env.SEMIONT_API_URL ?? 'http://localhost:4000';
  const email = process.env.SEMIONT_USER_EMAIL!;
  const password = process.env.SEMIONT_USER_PASSWORD!;
  const u = new URL(baseUrl);
  const kb: KnowledgeBase = {
    id: 'caselaw-subsequent-treatment',
    label: 'caselaw subsequent-treatment',
    email,
    endpoint: { kind: 'http', host: u.hostname, port: Number(u.port) || 4000, protocol: u.protocol.replace(':', '') as 'http' | 'https' },
  };
  const session = await SemiontSession.signInHttp({ kb, storage: new InMemorySessionStorage(), baseUrl, email, password });
  const semiont = session.client;

  try {
    const all = await semiont.browse.resources({ limit: 1000 });
    const cases = all.filter((r) => {
      const isCase = (r.entityTypes ?? []).some((t) => t === 'Case');
      const mt = getMediaType(r);
      return isCase && (mt === 'text/markdown' || mt === 'text/plain');
    });

    const target = all.find((r) => r['@id'] === targetIdArg);
    if (!target) {
      console.error(`Target ${targetIdArg} not found in the KB.`);
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
        const bodies = Array.isArray(ann.body) ? ann.body : ann.body ? [ann.body] : [];
        const tags = bodies
          .filter((b: any) => b.type === 'TextualBody' && b.purpose === 'tagging')
          .flatMap((b: any) => (Array.isArray(b.value) ? b.value : [b.value]));
        if (!tags.includes('Citation')) continue;
        const targets = bodies
          .filter((b: any) => b.type === 'SpecificResource' && b.purpose === 'linking')
          .map((b: any) => b.source as string);
        if (!targets.includes(targetIdArg)) continue;
        const annTarget = ann.target;
        const selectors =
          typeof annTarget === 'string' || !annTarget.selector
            ? []
            : Array.isArray(annTarget.selector)
              ? annTarget.selector
              : [annTarget.selector];
        let citationText = '';
        for (const s of selectors) {
          if (s.type === 'TextQuoteSelector') { citationText = s.exact; break; }
        }
        citingHits.push({
          citingCaseId: rId,
          citingCaseName: r.name ?? r['@id'],
          annId: ann.id,
          citationText,
        });
      }
    }

    if (citingHits.length === 0) {
      console.log(`No citing cases found for ${targetName} in this corpus.`);
      closeInteractive();
      return;
    }

    console.log(`Found ${citingHits.length} citing-annotation(s) for "${targetName}".`);
    console.log(`Treatment vocabulary: ${TREATMENT_CATEGORIES.join(', ')}`);
    const proceed = await confirm(
      `Run mark.assist (tagging mode) on each citing case to classify treatment?`,
      true,
    );
    if (!proceed) {
      console.log('Aborted.');
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

    // Register the treatment schema before the tagging pass. Idempotent —
    // re-runs are silent at the projection layer.
    await semiont.frame.addTagSchema(LEGAL_CITATION_TREATMENT_SCHEMA);

    for (const citingCaseId of perCaseAnnotations.keys()) {
      const hits = perCaseAnnotations.get(citingCaseId)!;
      const firstHit = hits[0];
      if (!firstHit) continue;
      try {
        const progress = await semiont.mark.assist(
          ridBrand(citingCaseId),
          'tagging',
          {
            schemaId: LEGAL_CITATION_TREATMENT_SCHEMA.id,
            categories: TREATMENT_CATEGORIES,
            instructions: `Focus only on passages that cite "${targetName}" and classify those passages.`,
          },
        );
        const n = createdCount(progress);
        console.log(`  ${firstHit.citingCaseName}: ${n} treatment tag(s)`);
      } catch (err) {
        console.warn(`  ! ${firstHit.citingCaseName}: ${(err as Error).message}`);
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
    for (const t of TREATMENT_CATEGORIES) breakdown.set(t, 0);

    for (const [citingCaseId, hits] of perCaseAnnotations) {
      const annotations = await semiont.browse.annotations(ridBrand(citingCaseId));
      const taggedHits: { treatments: string[]; quote: string }[] = [];
      for (const ann of annotations) {
        // Treatment annotations are now `motivation: 'tagging'` with a
        // `purpose: 'tagging'` body carrying the treatment value and a
        // `purpose: 'classifying'` body identifying the schema.
        if (ann.motivation !== 'tagging') continue;
        const bodies = Array.isArray(ann.body) ? ann.body : ann.body ? [ann.body] : [];
        const tags = bodies
          .filter((b: any) => b.type === 'TextualBody' && b.purpose === 'tagging')
          .flatMap((b: any) => (Array.isArray(b.value) ? b.value : [b.value]))
          .filter((t: string) => TREATMENT_CATEGORIES.includes(t));
        if (tags.length === 0) continue;
        const target = ann.target;
        const selectors =
          typeof target === 'string' || !target.selector
            ? []
            : Array.isArray(target.selector)
              ? target.selector
              : [target.selector];
        let quote = '';
        for (const s of selectors) {
          if (s.type === 'TextQuoteSelector') { quote = s.exact; break; }
        }
        taggedHits.push({ treatments: tags, quote });
        for (const t of tags) breakdown.set(t, (breakdown.get(t) ?? 0) + 1);
      }
      if (taggedHits.length === 0) continue;
      const firstHit = hits[0];
      if (!firstHit) continue;
      rows.push({
        citingCaseName: firstHit.citingCaseName,
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
    for (const t of TREATMENT_CATEGORIES) {
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
    closeInteractive();
  } finally {
    await session.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
