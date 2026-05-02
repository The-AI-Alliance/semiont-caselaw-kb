/**
 * build-party-roster — promote Person/Judge/Plaintiff/etc. mentions to
 * canonical Party resources, role-tagged.
 *
 * Pass: cluster + match + bind / yield.fromAnnotation + bind.
 *
 * Usage: tsx skills/build-party-roster/script.ts [--interactive]
 */

import {
  SemiontClient,
  resourceId as ridBrand,
  type AnnotationId,
  type GatheredContext,
  type ResourceId,
} from '@semiont/sdk';
import { confirm, isInteractive, close as closeInteractive } from '../../src/interactive.js';

const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD ?? 30);

const ROLE_TAGS = new Set([
  'Person',
  'Judge',
  'Plaintiff',
  'Defendant',
  'Petitioner',
  'Respondent',
  'Appellant',
  'Appellee',
  'Counsel',
]);

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

interface PartyAnno {
  rId: ResourceId;
  annId: AnnotationId;
  text: string;
  roles: string[];
  alreadyBound: boolean;
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
    console.log('No Case resources found. Run skills/ingest-cases/script.ts first.');
    semiont.dispose();
    closeInteractive();
    return;
  }

  const partyAnnotations: PartyAnno[] = [];
  for (const r of cases) {
    const rId = ridBrand(r['@id']);
    const annotations = await semiont.browse.annotations(rId);
    for (const ann of annotations) {
      if (ann.motivation !== 'linking') continue;
      const tags = (ann.body ?? [])
        .filter((b: any) => b.type === 'TextualBody' && b.purpose === 'tagging')
        .flatMap((b: any) => (Array.isArray(b.value) ? b.value : [b.value]));
      const roleTags = tags.filter((t: string) => ROLE_TAGS.has(t));
      if (roleTags.length === 0) continue;
      const alreadyBound = (ann.body ?? []).some(
        (b: any) => b.type === 'SpecificResource' && b.purpose === 'linking',
      );
      partyAnnotations.push({
        rId,
        annId: ann.id,
        text: ann.target?.selector?.exact ?? '',
        roles: roleTags,
        alreadyBound,
      });
    }
  }

  if (partyAnnotations.length === 0) {
    console.log(
      'No judicial-entity annotations found. Run skills/mark-judicial-entities/script.ts first.',
    );
    semiont.dispose();
    closeInteractive();
    return;
  }

  const clusters = new Map<string, PartyAnno[]>();
  let alreadyBoundCount = 0;
  for (const a of partyAnnotations) {
    if (a.alreadyBound) {
      alreadyBoundCount++;
      continue;
    }
    const key = a.text.toLowerCase().trim();
    if (!key) continue;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key)!.push(a);
  }

  console.log(
    `Found ${partyAnnotations.length} role-tagged annotation(s); ` +
      `${alreadyBoundCount} already bound; ${clusters.size} unbound clusters to process.`,
  );

  if (clusters.size === 0) {
    console.log('Nothing to promote.');
    semiont.dispose();
    closeInteractive();
    return;
  }

  const proceed = await confirm(
    'Proceed to match each cluster against existing Party resources, synthesize new ones where needed, and bind annotations?',
    true,
  );
  if (!proceed) {
    console.log('Aborted.');
    semiont.dispose();
    closeInteractive();
    return;
  }

  let bound = 0;
  let synthesized = 0;
  let skipped = 0;

  for (const [_, anns] of clusters) {
    const sample = anns[0];
    const rolesInCluster = Array.from(new Set(anns.flatMap((a) => a.roles)));

    const gather = await semiont.gather.annotation(sample.annId, sample.rId, {
      contextWindow: 1500,
    });
    const context = gather.response as GatheredContext;

    const matchResult = await semiont.match.search(sample.rId, sample.annId, context, {
      limit: 5,
      useSemanticScoring: true,
    });
    const top = matchResult.response[0];

    let targetResourceId: string;
    if (top && (top.score ?? 0) >= MATCH_THRESHOLD) {
      targetResourceId = top['@id'];
      console.log(`  ↪ "${sample.text}" → ${top.name} (existing, score ${top.score})`);
    } else {
      const proceedYield = isInteractive()
        ? await confirm(
            `No confident match for "${sample.text}". Synthesize a new Party resource?`,
            true,
          )
        : true;
      if (!proceedYield) {
        skipped++;
        console.log(`  skipped     "${sample.text}"`);
        continue;
      }

      const yieldEvent = await semiont.yield.fromAnnotation(sample.rId, sample.annId, {
        title: sample.text,
        storageUri: `file://generated/party-${slugify(sample.text)}.md`,
        context,
        entityTypes: ['Party', ...rolesInCluster],
      });
      if (yieldEvent.kind !== 'complete') {
        console.warn(`  unexpected yield event: ${yieldEvent.kind}`);
        continue;
      }
      const newRId = (yieldEvent.data.result as { resourceId?: string } | undefined)?.resourceId;
      if (!newRId) {
        console.warn(`  yield.fromAnnotation gave no resourceId for "${sample.text}"`);
        continue;
      }
      targetResourceId = newRId;
      synthesized++;
      console.log(
        `  + "${sample.text}" → ${newRId} (Party, roles: ${rolesInCluster.join(', ')})`,
      );
    }

    for (const a of anns) {
      await semiont.bind.body(a.rId, a.annId, [
        {
          op: 'add',
          item: { type: 'SpecificResource', source: targetResourceId, purpose: 'linking' },
        },
      ]);
      bound++;
    }
  }

  console.log(
    `\nDone. Bound ${bound} annotations across ${clusters.size} party clusters; ` +
      `${synthesized} new Party resources synthesized; ${skipped} skipped.`,
  );
  semiont.dispose();
  closeInteractive();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
