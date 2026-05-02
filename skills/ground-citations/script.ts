/**
 * ground-citations — resolve every unbound citation annotation to a
 * concrete Case resource (local match or CourtListener-fetched stub).
 *
 * Usage: tsx skills/ground-citations/script.ts [--interactive]
 */

import {
  SemiontClient,
  resourceId as ridBrand,
  type AnnotationId,
  type GatheredContext,
  type ResourceId,
} from '@semiont/sdk';
import { citationLookup, courtListenerUrl, type CourtListenerCase } from '../../src/courtlistener.js';
import { confirm, isInteractive, close as closeInteractive } from '../../src/interactive.js';

const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD ?? 30);
const MAX_REMOTE_LOOKUPS = Number(process.env.MAX_REMOTE_LOOKUPS ?? 100);
const SKIP_REMOTE = process.env.SKIP_REMOTE === '1';

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

interface CitationAnno {
  rId: ResourceId;
  annId: AnnotationId;
  text: string;
  citationType: string;
}

function buildStubBody(c: CourtListenerCase, citationText: string): string {
  const lines: string[] = [
    `# ${c.caseName}`,
    '',
    `Case stub auto-fetched from CourtListener via the Citation Lookup API.`,
    '',
    `**Resolved citation:** ${citationText}`,
  ];
  if (c.dateFiled) lines.push(`**Date filed:** ${c.dateFiled}`);
  if (c.court) lines.push(`**Court:** ${c.court}`);
  if (c.citations.length > 0) {
    lines.push(`**Reporter citations:** ${c.citations.join(', ')}`);
  }
  lines.push(
    '',
    '## External references',
    '',
    `- [${c.caseName} (CourtListener)](${courtListenerUrl(c)}) — CourtListener`,
  );
  return lines.join('\n') + '\n';
}

async function main(): Promise<void> {
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

  // Gather all unbound citation annotations across the corpus, separating
  // statutory citations (which route to skill 8 instead).
  const reporterCitations: CitationAnno[] = [];
  let statutoryCount = 0;
  let alreadyBound = 0;

  for (const r of cases) {
    const rId = ridBrand(r['@id']);
    const annotations = await semiont.browse.annotations(rId);
    for (const ann of annotations) {
      if (ann.motivation !== 'linking') continue;
      const tags = (ann.body ?? [])
        .filter((b: any) => b.type === 'TextualBody' && b.purpose === 'tagging')
        .flatMap((b: any) => (Array.isArray(b.value) ? b.value : [b.value]));
      if (!tags.includes('Citation')) continue;
      if (tags.includes('StatutoryCitation')) {
        statutoryCount++;
        continue;
      }
      const isBound = (ann.body ?? []).some(
        (b: any) => b.type === 'SpecificResource' && b.purpose === 'linking',
      );
      if (isBound) {
        alreadyBound++;
        continue;
      }
      // The citation type is whatever non-`Citation` tag eyecite stamped — pick
      // the most specific one for logging.
      const citationType =
        tags.find((t: string) => t !== 'Citation') ?? 'UnspecifiedCitation';
      reporterCitations.push({
        rId,
        annId: ann.id,
        text: ann.target?.selector?.exact ?? '',
        citationType,
      });
    }
  }

  if (reporterCitations.length === 0) {
    console.log(
      `No unbound reporter citations to resolve. (${alreadyBound} already bound; ` +
        `${statutoryCount} statutory — route to skills/extract-statutory-refs.)`,
    );
    semiont.dispose();
    closeInteractive();
    return;
  }

  console.log(
    `Found ${reporterCitations.length} unbound reporter citation(s). ` +
      `(${alreadyBound} already bound; ${statutoryCount} statutory deferred to skill 8.)`,
  );
  console.log(
    `Strategy: local match first (threshold ${MATCH_THRESHOLD}), then CourtListener lookup ` +
      `(cap ${MAX_REMOTE_LOOKUPS}, skip-remote=${SKIP_REMOTE}).`,
  );

  const proceed = await confirm('Proceed?', true);
  if (!proceed) {
    console.log('Aborted.');
    semiont.dispose();
    closeInteractive();
    return;
  }

  let boundLocal = 0;
  let boundRemote = 0;
  let unresolved = 0;
  let remoteCallsUsed = 0;

  for (const a of reporterCitations) {
    const gather = await semiont.gather.annotation(a.annId, a.rId, { contextWindow: 1500 });
    const context = gather.response as GatheredContext;
    const matchResult = await semiont.match.search(a.rId, a.annId, context, {
      limit: 5,
      useSemanticScoring: true,
    });
    const candidates = matchResult.response.map((c: any) => ({
      name: c.name as string,
      score: (c.score ?? 0) as number,
      id: c['@id'] as string,
    }));
    const top = candidates[0];

    if (top && top.score >= MATCH_THRESHOLD) {
      const proceedBind = isInteractive()
        ? await confirm(`"${a.text}" → ${top.name} (score ${top.score}). Bind?`, true)
        : true;
      if (!proceedBind) {
        unresolved++;
        continue;
      }
      await semiont.bind.body(a.rId, a.annId, [
        {
          op: 'add',
          item: { type: 'SpecificResource', source: top.id, purpose: 'linking' },
        },
      ]);
      boundLocal++;
      console.log(`  local       "${a.text}" → ${top.name}`);
      continue;
    }

    if (SKIP_REMOTE || remoteCallsUsed >= MAX_REMOTE_LOOKUPS) {
      unresolved++;
      const reason = SKIP_REMOTE ? 'skip-remote' : 'remote cap reached';
      await semiont.bind.body(a.rId, a.annId, [
        {
          op: 'add',
          item: {
            type: 'TextualBody',
            purpose: 'commenting',
            value: `Could not resolve citation locally; ${reason}.`,
          },
        },
      ]);
      console.log(`  unresolved  "${a.text}" (${reason})`);
      continue;
    }

    let remote: CourtListenerCase | null = null;
    try {
      remote = await citationLookup(a.text);
      remoteCallsUsed++;
    } catch (err) {
      unresolved++;
      await semiont.bind.body(a.rId, a.annId, [
        {
          op: 'add',
          item: {
            type: 'TextualBody',
            purpose: 'commenting',
            value: `CourtListener lookup failed: ${(err as Error).message}.`,
          },
        },
      ]);
      console.log(`  error       "${a.text}" — ${(err as Error).message}`);
      continue;
    }

    if (!remote) {
      unresolved++;
      await semiont.bind.body(a.rId, a.annId, [
        {
          op: 'add',
          item: {
            type: 'TextualBody',
            purpose: 'commenting',
            value: 'No local match; CourtListener returned no results.',
          },
        },
      ]);
      console.log(`  unresolved  "${a.text}" (no CourtListener match)`);
      continue;
    }

    const body = buildStubBody(remote, a.text);
    const { resourceId: stubId } = await semiont.yield.resource({
      name: remote.caseName,
      file: Buffer.from(body, 'utf-8'),
      format: 'text/markdown',
      entityTypes: ['Case', 'JudicialOpinion', 'CourtListenerStub'],
      storageUri: `file://generated/case-stub-${slugify(remote.caseName)}-${remote.clusterId ?? 'na'}.md`,
    });
    await semiont.bind.body(a.rId, a.annId, [
      {
        op: 'add',
        item: { type: 'SpecificResource', source: stubId, purpose: 'linking' },
      },
    ]);
    boundRemote++;
    console.log(`  remote      "${a.text}" → ${remote.caseName} (${stubId})`);
  }

  console.log(
    `\nDone. Bound ${boundLocal} locally + ${boundRemote} via CourtListener stub; ` +
      `${unresolved} unresolved. Remote calls used: ${remoteCallsUsed}.`,
  );
  semiont.dispose();
  closeInteractive();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
