/**
 * ingest-cases — walk every <corpus-name>/config.yaml, fetch, yield.resource.
 *
 * Dispatches on the config's `handler` field: `huggingface` uses
 * fetchFirstNDocuments + convertLegalCaseDocument; `cornell-lii` uses
 * downloadCornellLII + formatLegalOpinion. One resource per case.
 *
 * Usage: tsx skills/ingest-cases/script.ts [--interactive]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import yaml from 'yaml';

import { SemiontClient } from '@semiont/sdk';
import { fetchFirstNDocuments, convertLegalCaseDocument, type DocumentInfo } from '../../src/huggingface.js';
import { downloadCornellLII, formatLegalOpinion } from '../../src/legal-text.js';
import { confirm, close as closeInteractive } from '../../src/interactive.js';

/**
 * The full entity-type vocabulary this KB uses across all eleven skills.
 * Declared via `frame.addEntityTypes` once on each ingest run — idempotent,
 * so re-runs are harmless. This is what makes `browse.entityTypes()` return
 * a coherent published vocabulary.
 */
const KB_ENTITY_TYPES = [
  // Case resource types
  'Case',
  'JudicialOpinion',
  'SupremeCourt',
  'StateCourt',
  // Stub-resource type for CourtListener-fetched cases (skill 6)
  'CourtListenerStub',
  // Statutory-framework types
  'Statute',
  'FederalStatute',
  'Regulation',
  'ConstitutionalProvision',
  // mark-judicial-entities entity types (people + roles + adjudicative bodies)
  'Person',
  'Judge',
  'Plaintiff',
  'Defendant',
  'Petitioner',
  'Respondent',
  'Appellant',
  'Appellee',
  'Counsel',
  'Court',
  'Jurisdiction',
  'Date',
  'LegalStandard',
  'Doctrine',
  // build-party-roster output
  'Party',
  // detect-citations tagging vocabulary (eyecite-derived types)
  'Citation',
  'FullCaseCitation',
  'ShortCaseCitation',
  'IdCitation',
  'SupraCitation',
  'StatutoryCitation',
  // tag-irac vocabulary (skill 4)
  'Issue',
  'Rule',
  'Application',
  'Conclusion',
  // subsequent-treatment vocabulary (skill 10) — controlled tag schema
  'positive',
  'negative',
  'distinguished',
  'criticized',
  'overruled',
  'neutral',
  // Synthesized aggregates
  'PrecedentGraph',
  'SubsequentTreatment',
  'DoctrinalTrace',
  'Aggregate',
];

interface CaselawConfig {
  name?: string;
  displayName?: string;
  handler: 'huggingface' | 'cornell-lii';
  dataset?: string;
  count?: number;
  url?: string;
  entityTypes?: string[];
}

const SKIP_DIRS = new Set([
  '.git',
  '.github',
  '.devcontainer',
  '.semiont',
  '.plans',
  '.cache',
  'src',
  'skills',
  'node_modules',
  'tests',
  'docs',
]);

interface DiscoveredCorpus {
  /** Repo-relative subdirectory name. */
  subdir: string;
  /** Parsed YAML. */
  config: CaselawConfig;
}

function discoverCorpora(repoRoot: string): DiscoveredCorpus[] {
  const out: DiscoveredCorpus[] = [];
  for (const entry of readdirSync(repoRoot)) {
    if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
    const dir = join(repoRoot, entry);
    if (!statSync(dir).isDirectory()) continue;
    const configPath = join(dir, 'config.yaml');
    try {
      if (!statSync(configPath).isFile()) continue;
    } catch {
      continue;
    }
    const text = readFileSync(configPath, 'utf-8');
    const parsed = yaml.parse(text) as CaselawConfig;
    if (!parsed?.handler) {
      console.warn(`  ! ${entry}/config.yaml has no handler — skipping`);
      continue;
    }
    out.push({ subdir: entry, config: parsed });
  }
  return out;
}

function entityTypesFromConfig(handler: string, configTypes: string[] = []): string[] {
  const base =
    handler === 'cornell-lii'
      ? ['Case', 'JudicialOpinion', 'SupremeCourt']
      : ['Case', 'JudicialOpinion', 'StateCourt'];
  return Array.from(new Set([...base, ...configTypes]));
}

async function loadHuggingfaceCorpus(c: DiscoveredCorpus): Promise<DocumentInfo[]> {
  if (!c.config.dataset) {
    throw new Error(`${c.subdir}/config.yaml: handler=huggingface requires 'dataset'`);
  }
  const count = c.config.count ?? 10;
  console.log(`  fetching ${count} document(s) from HuggingFace dataset "${c.config.dataset}"...`);
  const rawDocs = await fetchFirstNDocuments(c.config.dataset, count);
  return rawDocs.map((d, i) => convertLegalCaseDocument(d, i));
}

async function loadCornellLiiCorpus(c: DiscoveredCorpus): Promise<DocumentInfo[]> {
  if (!c.config.url) {
    throw new Error(`${c.subdir}/config.yaml: handler=cornell-lii requires 'url'`);
  }
  console.log(`  fetching Cornell LII opinion from ${c.config.url}...`);
  const rawText = await downloadCornellLII(c.config.url);
  const title = c.config.displayName ?? c.subdir;
  const citation = (c.config.entityTypes ?? []).find((t) => /\d+\s+U\.S\.\s+\d+/.test(t)) ?? '';
  const formatted = formatLegalOpinion(title, citation, rawText);
  return [
    {
      title,
      content: formatted,
      metadata: { citation },
    },
  ];
}

async function loadCorpus(c: DiscoveredCorpus): Promise<DocumentInfo[]> {
  switch (c.config.handler) {
    case 'huggingface':
      return loadHuggingfaceCorpus(c);
    case 'cornell-lii':
      return loadCornellLiiCorpus(c);
    default:
      throw new Error(`Unknown handler in ${c.subdir}/config.yaml: ${c.config.handler}`);
  }
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const corpora = discoverCorpora(repoRoot);

  if (corpora.length === 0) {
    console.log('No <corpus-name>/config.yaml files found. Exiting.');
    closeInteractive();
    return;
  }

  console.log(`Discovered ${corpora.length} corpus config(s):`);
  for (const c of corpora) {
    const summary =
      c.config.handler === 'huggingface'
        ? `${c.config.dataset} × ${c.config.count ?? 10}`
        : c.config.url;
    console.log(`  - ${c.subdir} (handler=${c.config.handler}, ${summary})`);
  }

  // Pre-fetch all corpora so we can show a total count before yielding.
  console.log('\nFetching corpus content...');
  const fetched: Array<{ corpus: DiscoveredCorpus; documents: DocumentInfo[] }> = [];
  for (const c of corpora) {
    try {
      const docs = await loadCorpus(c);
      fetched.push({ corpus: c, documents: docs });
      console.log(`  ${c.subdir}: ${docs.length} document(s)`);
    } catch (err) {
      console.error(`  ! ${c.subdir} failed: ${(err as Error).message}`);
    }
  }
  const totalDocs = fetched.reduce((acc, { documents }) => acc + documents.length, 0);
  if (totalDocs === 0) {
    console.log('No documents fetched. Exiting.');
    closeInteractive();
    return;
  }

  const proceed = await confirm(
    `About to create ${totalDocs} resource(s) via yield.resource. Proceed?`,
    true,
  );
  if (!proceed) {
    console.log('Aborted before upload.');
    closeInteractive();
    return;
  }

  const semiont = await SemiontClient.signInHttp({
    baseUrl: process.env.SEMIONT_API_URL ?? 'http://localhost:4000',
    email: process.env.SEMIONT_USER_EMAIL!,
    password: process.env.SEMIONT_USER_PASSWORD!,
  });

  // Declare this KB's entity-type vocabulary via frame. Idempotent.
  console.log(`Declaring ${KB_ENTITY_TYPES.length} entity types via frame...`);
  await semiont.frame.addEntityTypes(KB_ENTITY_TYPES);

  let created = 0;
  let failed = 0;
  for (const { corpus, documents } of fetched) {
    const entityTypes = entityTypesFromConfig(corpus.config.handler, corpus.config.entityTypes);
    const isMarkdown = corpus.config.handler === 'cornell-lii';
    const format = isMarkdown ? 'text/markdown' : 'text/plain';
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      if (!doc) continue;
      const safeName = doc.title.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 80);
      const storageUri = `file://${corpus.subdir}/case-${i + 1}-${safeName}.${isMarkdown ? 'md' : 'txt'}`;
      try {
        const { resourceId } = await semiont.yield.resource({
          name: doc.title,
          file: Buffer.from(doc.content, 'utf-8'),
          format,
          entityTypes,
          storageUri,
        });
        created++;
        console.log(`  + ${corpus.subdir}/${doc.title} → ${resourceId}`);
      } catch (e) {
        failed++;
        console.warn(`  ! ${corpus.subdir}/${doc.title} failed: ${(e as Error).message}`);
      }
    }
  }

  console.log(`\nDone. ${created} resources created, ${failed} failed.`);
  semiont.dispose();
  closeInteractive();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
