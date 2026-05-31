/**
 * ground-citations — resolve every unbound citation annotation to a
 * concrete Case resource (existing corpus case or CourtListener-fetched stub).
 *
 * Deterministic resolution strategy (no LLM):
 *   1. Build a by-name index of corpus Case resources (so we can bind to a
 *      local Case when CourtListener resolves the citation to one we already
 *      have).
 *   2. Group unbound citation annotations by source resource so we can walk
 *      them in document position order — needed so `SupraCitation` and
 *      `IdCitation` (back-references) can bind to whatever the most recent
 *      FullCase citation resolved to.
 *   3. For each citation:
 *        - SupraCitation / IdCitation → bind to last-resolved target in same
 *          document, else mark unresolved.
 *        - Everything else → call CourtListener's Citation Lookup API. If it
 *          returns a hit, normalize the case name and check the local index;
 *          if a local Case matches, bind to it. Otherwise create a stub
 *          Case resource and bind to it.
 *        - StatutoryCitation → skipped (route to `extract-statutory-refs`).
 *        - JournalCitation → skipped (no Case resource to bind to).
 *
 * The previous version used `match.search` with LLM semantic scoring on the
 * citation text span, which is the wrong tool for citation resolution —
 * "115 N.H. 425" is a keyed lookup, not a fuzzy similarity query.
 * See `.plans/GROUND-CITATIONS.md` for the design rationale.
 *
 * Usage: tsx skills/ground-citations/script.ts
 */

import {
  SemiontSession,
  InMemorySessionStorage,
  type KnowledgeBase,
  resourceId as ridBrand,
  type AnnotationId,
  type ResourceId,
} from '@semiont/sdk';
import { citationLookup, courtListenerUrl, type CourtListenerCase } from '../../src/courtlistener.js';
import { confirm, close as closeInteractive } from '../../src/interactive.js';

const MAX_REMOTE_LOOKUPS = Number(process.env.MAX_REMOTE_LOOKUPS ?? 2000);
const SKIP_REMOTE = process.env.SKIP_REMOTE === '1';

// Citation type tags eyecite stamps. Skip JournalCitation (no Case to bind to)
// and StatutoryCitation (handled by extract-statutory-refs). Supra/Id are
// handled separately via lexical-context resolution within the same document.
const SKIP_TYPES = new Set(['JournalCitation', 'StatutoryCitation']);
const BACKREF_TYPES = new Set(['SupraCitation', 'IdCitation']);

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

/**
 * Normalize a case name so corpus-case names and CourtListener-returned
 * names can be compared. Strips trailing "(YYYY-MM-DD)" or "(YYYY)" date
 * suffixes, lowercases, collapses whitespace, normalizes punctuation
 * around "v.".
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\(\d{4}(-\d{2}(-\d{2})?)?\)\s*$/u, '')
    .replace(/&rsquo;/g, "'")
    .replace(/[‘’]/g, "'")
    .replace(/\s+v\.?\s+/g, ' v ')
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

interface CitationAnno {
  rId: ResourceId;
  annId: AnnotationId;
  text: string;
  citationType: string;
  start: number;
}

function getStart(ann: any): number {
  const target = ann.target;
  if (typeof target === 'string' || !target.selector) return 0;
  const selectors = Array.isArray(target.selector) ? target.selector : [target.selector];
  for (const s of selectors) {
    if (s.type === 'TextPositionSelector' && typeof s.start === 'number') return s.start;
  }
  return 0;
}

function getQuote(ann: any): string {
  const target = ann.target;
  if (typeof target === 'string' || !target.selector) return '';
  const selectors = Array.isArray(target.selector) ? target.selector : [target.selector];
  for (const s of selectors) {
    if (s.type === 'TextQuoteSelector' && typeof s.exact === 'string') return s.exact;
  }
  return '';
}

async function main(): Promise<void> {
  const baseUrl = process.env.SEMIONT_API_URL ?? 'http://localhost:4000';
  const email = process.env.SEMIONT_USER_EMAIL!;
  const password = process.env.SEMIONT_USER_PASSWORD!;
  const u = new URL(baseUrl);
  const kb: KnowledgeBase = {
    id: 'caselaw-ground-citations',
    label: 'caselaw ground-citations',
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

    if (cases.length === 0) {
      console.log('No Case resources found.');
      closeInteractive();
      return;
    }

    // Local Case index: normalized name → resourceId. Includes both the
    // ingested corpus cases and any pre-existing CourtListenerStub cases
    // from earlier runs (so we don't create duplicate stubs).
    const localCaseIndex = new Map<string, string>();
    for (const r of cases) {
      const name = r.name ?? '';
      if (!name) continue;
      const key = normalizeName(name);
      if (!localCaseIndex.has(key)) localCaseIndex.set(key, r['@id']);
    }
    console.log(`Local Case index: ${localCaseIndex.size} unique normalized name(s) from ${cases.length} Case resource(s).`);

    // Gather all unbound citation annotations, grouped by source resource
    // so we can walk them in document position order for Supra/Id resolution.
    const byResource = new Map<ResourceId, CitationAnno[]>();
    let alreadyBound = 0;
    let skippedType = 0;

    for (const r of cases) {
      const rId = ridBrand(r['@id']);
      const annotations = await semiont.browse.annotations(rId);
      for (const ann of annotations) {
        if (ann.motivation !== 'linking') continue;
        const bodies = Array.isArray(ann.body) ? ann.body : ann.body ? [ann.body] : [];
        const tags = bodies
          .filter((b: any) => b.type === 'TextualBody' && b.purpose === 'tagging')
          .flatMap((b: any) => (Array.isArray(b.value) ? b.value : [b.value]));
        if (!tags.includes('Citation')) continue;
        if (tags.some((t: string) => SKIP_TYPES.has(t))) { skippedType++; continue; }
        const isBound = bodies.some(
          (b: any) => b.type === 'SpecificResource' && b.purpose === 'linking',
        );
        if (isBound) { alreadyBound++; continue; }
        const citationType = tags.find((t: string) => t !== 'Citation') ?? 'UnspecifiedCitation';
        const text = getQuote(ann);
        const start = getStart(ann);
        if (!byResource.has(rId)) byResource.set(rId, []);
        byResource.get(rId)!.push({
          rId,
          annId: ann.id as AnnotationId,
          text,
          citationType,
          start,
        });
      }
    }

    const total = [...byResource.values()].reduce((n, xs) => n + xs.length, 0);
    if (total === 0) {
      console.log(`Nothing to resolve. (${alreadyBound} already bound; ${skippedType} skipped by type.)`);
      closeInteractive();
      return;
    }

    console.log(
      `Found ${total} unbound citation(s) across ${byResource.size} document(s). ` +
        `(${alreadyBound} already bound; ${skippedType} skipped — JournalCitation/StatutoryCitation.)`,
    );
    console.log(
      `Strategy: CourtListener lookup → local-name dedup → stub fallback. ` +
        `Remote cap: ${MAX_REMOTE_LOOKUPS}; skip-remote=${SKIP_REMOTE}.`,
    );

    const proceed = await confirm('Proceed?', true);
    if (!proceed) {
      console.log('Aborted.');
      closeInteractive();
      return;
    }

    let boundLocal = 0;
    let boundStub = 0;
    let boundBackref = 0;
    let unresolved = 0;
    let remoteCallsUsed = 0;
    let authAborted = false;

    // Track stubs created during this run so multiple citations to the same
    // out-of-corpus case bind to the same stub instead of creating duplicates.
    const stubsThisRun = new Map<string, string>(); // normalizedName → stubResourceId

    for (const [rId, citations] of byResource) {
      if (authAborted) break;
      citations.sort((a, b) => a.start - b.start);
      // Most recently resolved FullCase/Short/Unknown target in this document.
      // SupraCitation and IdCitation bind to this.
      let lastResolvedTarget: string | null = null;

      for (const a of citations) {
        // ---- back-reference resolution (Supra/Id) ----
        if (BACKREF_TYPES.has(a.citationType)) {
          if (lastResolvedTarget) {
            await semiont.bind.body(a.rId, a.annId, [
              {
                op: 'add',
                item: { type: 'SpecificResource', source: lastResolvedTarget, purpose: 'linking' },
              },
            ]);
            boundBackref++;
            console.log(`  backref     "${a.text}" → (prior target)`);
          } else {
            unresolved++;
            await semiont.bind.body(a.rId, a.annId, [
              {
                op: 'add',
                item: {
                  type: 'TextualBody',
                  purpose: 'commenting',
                  value: 'Back-reference (Supra/Id) with no prior resolved citation in this document.',
                },
              },
            ]);
            console.log(`  unresolved  "${a.text}" (back-ref, no prior target)`);
          }
          continue;
        }

        // ---- skip-remote short circuit ----
        if (SKIP_REMOTE || remoteCallsUsed >= MAX_REMOTE_LOOKUPS) {
          unresolved++;
          const reason = SKIP_REMOTE ? 'skip-remote' : 'remote cap reached';
          await semiont.bind.body(a.rId, a.annId, [
            {
              op: 'add',
              item: {
                type: 'TextualBody',
                purpose: 'commenting',
                value: `Could not resolve citation; ${reason}.`,
              },
            },
          ]);
          console.log(`  unresolved  "${a.text}" (${reason})`);
          continue;
        }

        // ---- CourtListener lookup ----
        // Count every attempt toward the budget — a failed call still hits
        // the network and still consumes rate limit.
        remoteCallsUsed++;
        let remote: CourtListenerCase | null = null;
        try {
          remote = await citationLookup(a.text);
        } catch (err) {
          const msg = (err as Error).message;
          // 401 means the citation-lookup endpoint requires authentication.
          // Every subsequent call will fail identically, so abort the whole
          // run rather than hammer the API once per citation.
          if (/\b401\b/.test(msg)) {
            console.error(
              `\nAborting after CourtListener auth failure: ${msg}\n` +
                `The citation-lookup endpoint requires authentication. ` +
                `Get a free token at https://www.courtlistener.com/help/api/rest/ ` +
                `and set COURTLISTENER_API_KEY before re-running. ` +
                `(${remoteCallsUsed} call(s) attempted; ${boundLocal + boundStub + boundBackref} binding(s) made so far.)`,
            );
            authAborted = true;
            break;
          }
          unresolved++;
          await semiont.bind.body(a.rId, a.annId, [
            {
              op: 'add',
              item: {
                type: 'TextualBody',
                purpose: 'commenting',
                value: `CourtListener lookup failed: ${msg}.`,
              },
            },
          ]);
          console.log(`  error       "${a.text}" — ${msg}`);
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
                value: 'CourtListener returned no results for this citation.',
              },
            },
          ]);
          console.log(`  unresolved  "${a.text}" (no CourtListener match)`);
          continue;
        }

        // ---- bind to local Case if name matches ----
        const normalizedRemoteName = normalizeName(remote.caseName);
        const localId = localCaseIndex.get(normalizedRemoteName);
        if (localId) {
          await semiont.bind.body(a.rId, a.annId, [
            {
              op: 'add',
              item: { type: 'SpecificResource', source: localId, purpose: 'linking' },
            },
          ]);
          boundLocal++;
          lastResolvedTarget = localId;
          console.log(`  local       "${a.text}" → ${remote.caseName}`);
          continue;
        }

        // ---- create / reuse stub ----
        let stubId = stubsThisRun.get(normalizedRemoteName);
        if (!stubId) {
          const body = buildStubBody(remote, a.text);
          const result = await semiont.yield.resource({
            name: remote.caseName,
            file: Buffer.from(body, 'utf-8'),
            format: 'text/markdown',
            entityTypes: ['Case', 'JudicialOpinion', 'CourtListenerStub'],
            storageUri: `file://generated/case-stub-${slugify(remote.caseName)}-${remote.clusterId ?? 'na'}.md`,
          });
          stubId = result.resourceId;
          stubsThisRun.set(normalizedRemoteName, stubId);
          // Also add to localCaseIndex so subsequent citations in *other*
          // documents in this same run pick up the stub rather than create another.
          localCaseIndex.set(normalizedRemoteName, stubId);
        }
        await semiont.bind.body(a.rId, a.annId, [
          {
            op: 'add',
            item: { type: 'SpecificResource', source: stubId, purpose: 'linking' },
          },
        ]);
        boundStub++;
        lastResolvedTarget = stubId;
        console.log(`  stub        "${a.text}" → ${remote.caseName} (${stubId})`);
      }
    }

    console.log(
      `\n${authAborted ? 'Aborted (CourtListener auth).' : 'Done.'} ` +
        `Bound ${boundLocal} to local Cases + ${boundStub} via new CourtListener stubs + ${boundBackref} back-refs (Supra/Id); ` +
        `${unresolved} unresolved. Remote calls used: ${remoteCallsUsed}.`,
    );
    closeInteractive();
  } finally {
    await session.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
