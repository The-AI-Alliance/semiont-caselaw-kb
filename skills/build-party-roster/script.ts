/**
 * build-party-roster — promote Person/Judge/Plaintiff/etc. mentions to
 * canonical Party resources, role-tagged.
 *
 * Pass: cluster + match + bind / yield.delegate + bind.
 *
 * Usage: tsx skills/build-party-roster/script.ts [--interactive]
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
import { confirm, isInteractive, close as closeInteractive } from '../../src/interactive.js';
import { getMediaType } from '../../src/media-type.js';

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
  const gateway = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
  const opened = await SemiontSession.signInDevice({
    kb: httpKb({
      id: 'caselaw-build-party-roster',
      label: 'caselaw build-party-roster',
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
  const semiont = opened.session.client;

  try {
    const all = (await semiont.browse.resources({ limit: 1000 }).fresh()).resources;
    const cases = all.filter((r) => {
      const isCase = (r.entityTypes ?? []).some((t) => t === 'Case');
      const mt = getMediaType(r);
      return isCase && (mt === 'text/markdown' || mt === 'text/plain');
    });

    if (cases.length === 0) {
      console.log('No Case resources found. Run skills/ingest-cases/script.ts first.');
      closeInteractive();
      return;
    }

    const partyAnnotations: PartyAnno[] = [];
    for (const r of cases) {
      const rId = r['@id'];
      const annotations = await semiont.browse.annotations(rId).fresh();
      for (const ann of annotations) {
        if (ann.motivation !== 'linking') continue;
        const tags = getEntityTypes(ann);
        const roleTags = tags.filter((t) => ROLE_TAGS.has(t));
        if (roleTags.length === 0) continue;
        const alreadyBound = getBodySource(ann.body) !== null;
        const text = getAnnotationExactText(ann);
        partyAnnotations.push({
          rId,
          annId: ann.id,
          text,
          roles: roleTags,
          alreadyBound,
        });
      }
    }

    if (partyAnnotations.length === 0) {
      console.log(
        'No judicial-entity annotations found. Run skills/mark-judicial-entities/script.ts first.',
      );
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
      closeInteractive();
      return;
    }

    const proceed = await confirm(
      'Proceed to match each cluster against existing Party resources, synthesize new ones where needed, and bind annotations?',
      true,
    );
    if (!proceed) {
      console.log('Aborted.');
      closeInteractive();
      return;
    }

    let bound = 0;
    let synthesized = 0;
    let skipped = 0;

    for (const [_, anns] of clusters) {
      const sample = anns[0];
      if (!sample) continue;
      const rolesInCluster = Array.from(new Set(anns.flatMap((a) => a.roles)));

      const { response: context } = await semiont.gather.annotation(sample.rId, sample.annId, {
        contextWindow: 1500,
      });

      const matchResult = await semiont.match.search(sample.rId, sample.annId, context, {
        limit: 5,
        useSemanticScoring: true,
      });
      const top = matchResult.response[0];

      let targetResourceId: ResourceId;
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

        const generated = await semiont.yield.delegate({
          context,
          title: sample.text,
          storageUri: `file://generated/party-${slugify(sample.text)}.md`,
          entityTypes: ['Party', ...rolesInCluster],
        });
        if (!generated.result || !('resourceId' in generated.result)) {
          console.warn(`  the generation made no resource`);
          continue;
        }
        const newRId = generated.result.resourceId;
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
    closeInteractive();
  } finally {
    opened.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
