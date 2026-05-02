/**
 * US Code lookup via uscode.house.gov bulk XML.
 *
 * Used by skill 8 (`extract-statutory-refs`) to resolve federal-statute
 * citations to actual statute text. Bulk XML files are downloaded once
 * per title (e.g., title 5 → `usc05.xml`) and cached locally; subsequent
 * lookups read the cache.
 *
 * The XML schema is the USLM (United States Legislative Markup) format
 * documented at https://uscode.house.gov/download/. We parse minimally —
 * just enough to find a section by `<section identifier="/us/usc/t5/s500">`.
 *
 * For state statutes (e.g., RSA, Cal. Civ. Code), this module returns
 * null; state-statute resolution is deferred to a future enhancement.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_DIR = join(process.cwd(), '.cache', 'uscode');
const BASE_URL = 'https://uscode.house.gov/download/releasepoints/us/pl';

export interface UsCodeSection {
  /** Title number, e.g. "5". */
  title: string;
  /** Section number, e.g. "500" or "552(a)(4)(B)". */
  section: string;
  /** Section heading, e.g. "Administrative practice; general provisions". */
  heading: string;
  /** Section body text (minimally cleaned). */
  body: string;
  /** Source URL the XML was fetched from. */
  sourceUrl: string;
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function titleCachePath(title: string): string {
  return join(CACHE_DIR, `usc${title.padStart(2, '0')}.xml`);
}

/**
 * Discover the latest release point of the US Code bulk-XML archive.
 *
 * The bulk archive is partitioned by Public Law release point; the
 * directory listing at `${BASE_URL}/` lists release-point subdirectories.
 * We pick the lexicographically latest one. Cached for the duration of
 * the process.
 */
let releasePointCache: string | null = null;
async function getLatestReleasePoint(): Promise<string> {
  if (releasePointCache) return releasePointCache;
  const response = await fetch(`${BASE_URL}/`);
  if (!response.ok) {
    throw new Error(`Failed to list US Code release points: ${response.status}`);
  }
  const html = await response.text();
  const matches = [...html.matchAll(/href="(?<rp>\d{3}-\d+)\/?"/g)].map(
    (m) => m.groups!.rp,
  );
  if (matches.length === 0) {
    throw new Error('No US Code release points found at uscode.house.gov.');
  }
  matches.sort();
  releasePointCache = matches[matches.length - 1];
  return releasePointCache;
}

async function ensureTitleCached(title: string): Promise<string> {
  const cachePath = titleCachePath(title);
  if (existsSync(cachePath)) {
    return readFileSync(cachePath, 'utf-8');
  }
  const releasePoint = await getLatestReleasePoint();
  const url = `${BASE_URL}/${releasePoint}/xml_uscAll@${releasePoint}.zip`;
  // Per-title XMLs are also published at: /xml_usc<NN>@<rp>.xml
  const titleUrl = `${BASE_URL}/${releasePoint}/xml_usc${title.padStart(2, '0')}@${releasePoint}.xml`;
  const response = await fetch(titleUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch US Code title ${title} from ${titleUrl}: ${response.status}.\n` +
        `If the per-title file isn't available, the bulk archive at ${url} ` +
        `is an alternative — but extraction is out of scope for this helper.`,
    );
  }
  const xml = await response.text();
  ensureCacheDir();
  writeFileSync(cachePath, xml);
  return xml;
}

/**
 * Strip XML tags and decode the most common entities. Sufficient for
 * extracting the body text of a USLM section without parsing the full
 * schema; preserves paragraph breaks.
 */
function stripXml(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function findSectionFragment(xml: string, title: string, section: string): string | null {
  // Section identifiers in USLM look like:
  //   <section identifier="/us/usc/t5/s500" ...>
  // Use a regex that captures the opening <section> and its body up to </section>.
  const id = `/us/usc/t${title}/s${section}`;
  const re = new RegExp(
    `<section\\b[^>]*identifier="${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}"[\\s\\S]*?<\\/section>`,
    'i',
  );
  const m = xml.match(re);
  return m ? m[0] : null;
}

function extractHeading(fragment: string): string {
  const m = fragment.match(/<heading[^>]*>([\s\S]*?)<\/heading>/i);
  if (!m) return '';
  return stripXml(m[1]);
}

/**
 * Look up a US Code section by title and section number.
 *
 * Returns the section's heading + body, or null if either:
 *   - the title's XML couldn't be fetched
 *   - the section identifier wasn't found in the title's XML
 *
 * Caches the title's full XML in `.cache/uscode/usc<NN>.xml` after first
 * fetch. Re-runs against the same title are local-only.
 */
export async function getUsCodeSection(
  title: string,
  section: string,
): Promise<UsCodeSection | null> {
  const xml = await ensureTitleCached(title);
  const fragment = findSectionFragment(xml, title, section);
  if (!fragment) return null;

  const heading = extractHeading(fragment) || `Title ${title} § ${section}`;
  const body = stripXml(fragment.replace(/<heading[^>]*>[\s\S]*?<\/heading>/i, ''));
  const releasePoint = releasePointCache ?? '(unknown)';
  return {
    title,
    section,
    heading,
    body,
    sourceUrl: `${BASE_URL}/${releasePoint}/xml_usc${title.padStart(2, '0')}@${releasePoint}.xml`,
  };
}

/**
 * Best-effort parse of a citation string into title + section components.
 *
 * Handles common forms:
 *   - "5 U.S.C. § 552"
 *   - "5 U.S.C. 552(a)(4)(B)"
 *   - "42 U.S.C. § 1983"
 *
 * Returns null for state codes or unrecognized formats — callers should
 * route those to a state-specific resolver (deferred).
 */
export function parseUsCodeCitation(text: string): { title: string; section: string } | null {
  const m = text.match(/(\d+)\s*U\.?\s*S\.?\s*C\.?\s*[§§]?\s*([\d.()A-Za-z-]+)/);
  if (!m) return null;
  return { title: m[1], section: m[2] };
}
