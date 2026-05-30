/**
 * build-citation-graph — synthesize one PrecedentGraph resource per Case
 * summarizing its citation neighborhood (outgoing + incoming).
 *
 * Usage: tsx skills/build-citation-graph/script.ts [<caseResourceId>] [--interactive]
 */

import { SemiontSession, InMemorySessionStorage, type KnowledgeBase, resourceId as ridBrand, type ResourceId } from '@semiont/sdk';
import { confirm, close as closeInteractive } from '../../src/interactive.js';

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

interface CaseInfo {
  rId: string;
  rIdBrand: ResourceId;
  name: string;
  entityTypes: string[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const explicitResourceId = args[0];

  const baseUrl = process.env.SEMIONT_API_URL ?? 'http://localhost:4000';
  const email = process.env.SEMIONT_USER_EMAIL!;
  const password = process.env.SEMIONT_USER_PASSWORD!;
  const u = new URL(baseUrl);
  const kb: KnowledgeBase = {
    id: 'caselaw-build-citation-graph',
    label: 'caselaw build-citation-graph',
    email,
    endpoint: { kind: 'http', host: u.hostname, port: Number(u.port) || 4000, protocol: u.protocol.replace(':', '') as 'http' | 'https' },
  };
  const session = await SemiontSession.signInHttp({ kb, storage: new InMemorySessionStorage(), baseUrl, email, password });
  const semiont = session.client;

  const all = await semiont.browse.resources({ limit: 1000 });
  const caseIndex = new Map<string, CaseInfo>();
  for (const r of all) {
    if (!(r.entityTypes ?? []).some((t) => t === 'Case')) continue;
    const id = r['@id'];
    caseIndex.set(id, {
      rId: id,
      rIdBrand: ridBrand(id),
      name: r.name ?? id,
      entityTypes: r.entityTypes ?? [],
    });
  }

  if (caseIndex.size === 0) {
    console.log('No Case resources found.');
    await session.dispose();
    closeInteractive();
    return;
  }

  let targetIds: string[];
  if (explicitResourceId) {
    if (!caseIndex.has(explicitResourceId)) {
      console.error(`Resource ${explicitResourceId} is not a Case in this KB.`);
      await session.dispose();
      closeInteractive();
      return;
    }
    targetIds = [explicitResourceId];
  } else {
    // Skip Case resources that look like generated artifacts (PrecedentGraph
    // synthesized by a previous run isn't a Case, but Stub cases from skill 6
    // *are* Cases — keep those).
    targetIds = Array.from(caseIndex.keys()).filter((id) => {
      const md = (all.find((r) => r['@id'] === id) as any) ?? {};
      const mt = getMediaType(md);
      return mt === 'text/markdown' || mt === 'text/plain';
    });
  }

  // Pre-walk every Case's annotations once and build outgoing-edges per case.
  const outgoing = new Map<string, Set<string>>();
  for (const id of caseIndex.keys()) outgoing.set(id, new Set());

  console.log(`Walking ${caseIndex.size} cases for citation edges...`);
  for (const info of caseIndex.values()) {
    const annotations = await semiont.browse.annotations(info.rIdBrand);
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
      for (const t of targets) {
        if (caseIndex.has(t)) {
          outgoing.get(info.rId)!.add(t);
        }
      }
    }
  }

  // Inverse the outgoing map for incoming edges.
  const incoming = new Map<string, Set<string>>();
  for (const id of caseIndex.keys()) incoming.set(id, new Set());
  for (const [src, targets] of outgoing) {
    for (const t of targets) {
      incoming.get(t)!.add(src);
    }
  }

  console.log(`Will synthesize ${targetIds.length} PrecedentGraph resource(s).`);
  const proceed = await confirm('Proceed?', true);
  if (!proceed) {
    console.log('Aborted.');
    await session.dispose();
    closeInteractive();
    return;
  }

  let created = 0;
  for (const id of targetIds) {
    const info = caseIndex.get(id)!;
    const out = Array.from(outgoing.get(id) ?? []);
    const inc = Array.from(incoming.get(id) ?? []);

    // Court / jurisdiction histogram from incoming-side cases.
    const incomingCourts = new Map<string, number>();
    for (const otherId of inc) {
      const other = caseIndex.get(otherId);
      if (!other) continue;
      for (const t of other.entityTypes) {
        if (t === 'Case' || t === 'JudicialOpinion') continue;
        incomingCourts.set(t, (incomingCourts.get(t) ?? 0) + 1);
      }
    }

    const lines: string[] = [
      `# Precedent graph: ${info.name}`,
      '',
      `Auto-generated citation-neighborhood synthesis for [${info.name}](${id}).`,
      '',
      `**Cites:** ${out.length} case(s) in the corpus.`,
      `**Cited by:** ${inc.length} case(s) in the corpus.`,
      '',
    ];

    if (out.length > 0) {
      lines.push('## Cases this case cites', '', '| # | Case | Resource |', '|---|---|---|');
      out.forEach((targetId, i) => {
        const target = caseIndex.get(targetId);
        lines.push(
          `| ${i + 1} | ${target?.name ?? targetId} | [${targetId}](${targetId}) |`,
        );
      });
      lines.push('');
    }

    if (inc.length > 0) {
      lines.push('## Cases citing this case', '', '| # | Case | Resource |', '|---|---|---|');
      inc.forEach((sourceId, i) => {
        const source = caseIndex.get(sourceId);
        lines.push(
          `| ${i + 1} | ${source?.name ?? sourceId} | [${sourceId}](${sourceId}) |`,
        );
      });
      lines.push('');
    }

    if (incomingCourts.size > 0) {
      lines.push('## Citing-court breakdown', '');
      for (const [court, n] of Array.from(incomingCourts.entries()).sort(
        (a, b) => b[1] - a[1],
      )) {
        lines.push(`- **${court}:** ${n}`);
      }
      lines.push('');
    }

    lines.push(
      '---',
      '',
      `*Synthesized by the \`build-citation-graph\` skill from grounded citation annotations.*`,
    );

    const body = lines.join('\n') + '\n';
    const { resourceId: graphId } = await semiont.yield.resource({
      name: `Precedent graph: ${info.name}`,
      file: Buffer.from(body, 'utf-8'),
      format: 'text/markdown',
      entityTypes: ['PrecedentGraph', 'Aggregate'],
      storageUri: `file://generated/precedent-graph-${slugify(info.name)}.md`,
    });
    created++;
    console.log(`  + ${info.name} → ${graphId} (out ${out.length}, in ${inc.length})`);
  }

  console.log(`\nDone. ${created} PrecedentGraph resource(s) synthesized.`);
  await session.dispose();
  closeInteractive();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
