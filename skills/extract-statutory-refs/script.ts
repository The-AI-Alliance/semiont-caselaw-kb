/**
 * extract-statutory-refs — resolve every StatutoryCitation annotation to a
 * Statute resource carrying the section's body text from the US Code.
 *
 * Usage: tsx skills/extract-statutory-refs/script.ts [--interactive]
 */

import {
  SemiontSession,
  InMemorySessionStorage,
  httpKb,
  getAnnotationExactText,
  getBodySource,
  getEntityTypes,
  type AnnotationId,
  type ResourceId,
} from '@semiont/sdk';
import { getUsCodeSection, parseUsCodeCitation } from '../../src/uscode.js';
import { confirm, close as closeInteractive } from '../../src/interactive.js';
import { getMediaType } from '../../src/media-type.js';


function slugify(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 80);
}

interface StatutoryAnno {
  rId: ResourceId;
  annId: AnnotationId;
  text: string;
}

async function main(): Promise<void> {
  const gateway = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
  const session = await SemiontSession.signInDevice({
    kb: httpKb({
      id: 'caselaw-extract-statutory-refs',
      label: 'caselaw extract-statutory-refs',
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
  const semiont = session.client;

  try {
    const all = (await semiont.browse.resources({ limit: 1000 }).fresh()).resources;
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

    // Build an index of existing Statute resources by "title:section" key so we
    // can reuse them across multiple citing annotations.
    const existingStatutes = new Map<string, ResourceId>();
    for (const r of all) {
      if (!(r.entityTypes ?? []).some((t) => t === 'Statute')) continue;
      const m = (r.name ?? '').match(/^(\d+)\s*U\.S\.C\.\s*§\s*(\S+)/);
      if (m) existingStatutes.set(`${m[1]}:${m[2]}`, r['@id']);
    }

    // Collect unbound StatutoryCitation annotations across the corpus.
    const statutoryAnnotations: StatutoryAnno[] = [];
    for (const r of cases) {
      const rId = r['@id'];
      const annotations = await semiont.browse.annotations(rId).fresh();
      for (const ann of annotations) {
        if (ann.motivation !== 'linking') continue;
        const tags = getEntityTypes(ann);
        if (!tags.includes('StatutoryCitation')) continue;
        const isBound = getBodySource(ann.body) !== null;
        if (isBound) continue;
        const text = getAnnotationExactText(ann);
        statutoryAnnotations.push({
          rId,
          annId: ann.id,
          text,
        });
      }
    }

    if (statutoryAnnotations.length === 0) {
      console.log('No unbound StatutoryCitation annotations found.');
      closeInteractive();
      return;
    }

    // Group by parsed (title, section) so we fetch each unique section once.
    const bySection = new Map<string, { title: string; section: string; anns: StatutoryAnno[] }>();
    let unparseable = 0;
    for (const a of statutoryAnnotations) {
      const parsed = parseUsCodeCitation(a.text);
      if (!parsed) {
        unparseable++;
        continue;
      }
      const key = `${parsed.title}:${parsed.section}`;
      if (!bySection.has(key)) {
        bySection.set(key, { title: parsed.title, section: parsed.section, anns: [] });
      }
      bySection.get(key)!.anns.push(a);
    }

    console.log(
      `Found ${statutoryAnnotations.length} unbound StatutoryCitation annotation(s). ` +
        `${bySection.size} unique U.S.C. section(s) detected; ${unparseable} not in U.S.C. format ` +
        `(state code or unrecognized — left unresolved).`,
    );

    const titlesToFetch = new Set<string>();
    for (const { title } of bySection.values()) {
      titlesToFetch.add(title);
    }
    console.log(
      `Will fetch ${titlesToFetch.size} U.S. Code title XML(s): ${Array.from(titlesToFetch).sort().join(', ')}. ` +
        `(Cached after first fetch; subsequent runs are local-only.)`,
    );

    const proceed = await confirm('Proceed?', true);
    if (!proceed) {
      console.log('Aborted.');
      closeInteractive();
      return;
    }

    let synthesized = 0;
    let bound = 0;
    let notFound = 0;

    for (const { title, section, anns } of bySection.values()) {
      const key = `${title}:${section}`;
      let statuteRId = existingStatutes.get(key);

      if (!statuteRId) {
        let usc;
        try {
          usc = await getUsCodeSection(title, section);
        } catch (err) {
          console.warn(`  ! ${title} U.S.C. § ${section}: fetch failed: ${(err as Error).message}`);
          notFound += anns.length;
          continue;
        }
        if (!usc) {
          console.warn(`  ! ${title} U.S.C. § ${section}: section not found in title XML`);
          notFound += anns.length;
          for (const a of anns) {
            await semiont.bind.body(a.rId, a.annId, [
              {
                op: 'add',
                item: {
                  type: 'TextualBody',
                  purpose: 'commenting',
                  value: `Could not resolve "${a.text}" — section ${section} not found in Title ${title} XML.`,
                },
              },
            ]);
          }
          continue;
        }

        const lines = [
          `# ${title} U.S.C. § ${section} — ${usc.heading}`,
          '',
          `Federal-statute body fetched from US Code bulk XML.`,
          '',
          `**Title:** ${title}`,
          `**Section:** ${section}`,
          '',
          '## Statute text',
          '',
          usc.body,
          '',
          '## External references',
          '',
          `- [${title} U.S.C. § ${section}](${usc.sourceUrl}) — uscode.house.gov`,
        ];
        const body = lines.join('\n') + '\n';
        const { resourceId: newRId } = await semiont.yield.resource({
          name: `${title} U.S.C. § ${section}`,
          file: Buffer.from(body, 'utf-8'),
          format: 'text/markdown',
          entityTypes: ['Statute', 'FederalStatute'],
          storageUri: `file://generated/statute-${slugify(`${title}-${section}`)}.md`,
        });
        statuteRId = newRId;
        existingStatutes.set(key, statuteRId);
        synthesized++;
        console.log(`  + ${title} U.S.C. § ${section} → ${statuteRId}`);
      } else {
        console.log(`  ↪ ${title} U.S.C. § ${section} → ${statuteRId} (existing)`);
      }

      for (const a of anns) {
        await semiont.bind.body(a.rId, a.annId, [
          {
            op: 'add',
            item: { type: 'SpecificResource', source: statuteRId, purpose: 'linking' },
          },
        ]);
        bound++;
      }
    }

    console.log(
      `\nDone. ${synthesized} new Statute resource(s) synthesized; ${bound} citation(s) bound; ` +
        `${notFound} not found in U.S.C.; ${unparseable} not in U.S.C. format.`,
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
