/**
 * CourtListener REST API client (Free Law Project).
 *
 * Provides citation-text → case-metadata lookup via the public Citation
 * Lookup API. Caches results to `.cache/courtlistener/` to stay under
 * the free-tier rate limit (~5,000 requests/day).
 *
 * No auth required for public reads; setting `COURTLISTENER_API_KEY`
 * raises the rate-limit ceiling.
 *
 * Used by skill 6 (`ground-citations`).
 *
 * API docs: https://www.courtlistener.com/help/api/rest/citation-lookup/
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CourtListenerCase {
  /** CourtListener case URL, e.g. /opinion/107423/citizens-united-v-fec/. */
  absoluteUrl: string;
  /** Display name, e.g. "Citizens United v. Federal Election Comm'n". */
  caseName: string;
  /** Filing or decision date (YYYY-MM-DD). */
  dateFiled?: string;
  /** Court id, e.g. "scotus", "nh". */
  court?: string;
  /** Reporter citation text(s) returned by the API. */
  citations: string[];
  /** The CourtListener cluster id (numeric). Stable identifier. */
  clusterId?: number;
}

const CACHE_DIR = join(process.cwd(), '.cache', 'courtlistener');
const API_BASE = 'https://www.courtlistener.com/api/rest/v4';
const RATE_LIMIT_DELAY_MS = Number(process.env.RATE_LIMIT_DELAY_MS ?? 200);

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function cacheKey(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function readCache(text: string): CourtListenerCase | null | undefined {
  const file = join(CACHE_DIR, `${cacheKey(text)}.json`);
  if (!existsSync(file)) return undefined;
  try {
    const raw = readFileSync(file, 'utf-8');
    return JSON.parse(raw) as CourtListenerCase | null;
  } catch {
    return undefined;
  }
}

function writeCache(text: string, value: CourtListenerCase | null): void {
  ensureCacheDir();
  const file = join(CACHE_DIR, `${cacheKey(text)}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2));
}

let lastCallAt = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallAt;
  if (elapsed < RATE_LIMIT_DELAY_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS - elapsed));
  }
  lastCallAt = Date.now();
}

function authHeader(): Record<string, string> {
  const key = process.env.COURTLISTENER_API_KEY;
  return key ? { Authorization: `Token ${key}` } : {};
}

/**
 * Look up a citation text against the CourtListener Citation Lookup API.
 * Returns the first matched case or `null` if none found.
 *
 * Cached results live in `.cache/courtlistener/<sha1-prefix>.json`.
 * Negative results (no match) are also cached, so re-runs don't repeat
 * the API call.
 */
export async function citationLookup(citationText: string): Promise<CourtListenerCase | null> {
  const cached = readCache(citationText);
  if (cached !== undefined) return cached;

  await throttle();
  const url = `${API_BASE}/citation-lookup/`;
  const body = new URLSearchParams({ text: citationText });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...authHeader(),
      },
      body,
    });
  } catch (err) {
    throw new Error(`CourtListener fetch failed: ${(err as Error).message}`);
  }

  if (!response.ok) {
    if (response.status === 404) {
      writeCache(citationText, null);
      return null;
    }
    throw new Error(`CourtListener returned ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as Array<{
    citation?: string;
    normalized_citations?: string[];
    status?: number;
    error_message?: string;
    clusters?: Array<{
      absolute_url?: string;
      case_name?: string;
      date_filed?: string;
      docket?: { court?: string };
      citations?: Array<{ volume?: string | number; reporter?: string; page?: string | number }>;
      id?: number;
    }>;
  }>;

  const firstWithCluster = (data ?? []).find((d) => d.clusters && d.clusters.length > 0);
  if (!firstWithCluster) {
    writeCache(citationText, null);
    return null;
  }
  const cluster = firstWithCluster.clusters![0];
  if (!cluster) {
    writeCache(citationText, null);
    return null;
  }

  const result: CourtListenerCase = {
    absoluteUrl: cluster.absolute_url ?? '',
    caseName: cluster.case_name ?? '(untitled)',
    dateFiled: cluster.date_filed,
    court: cluster.docket?.court,
    citations: (cluster.citations ?? []).map(
      (c) => `${c.volume ?? ''} ${c.reporter ?? ''} ${c.page ?? ''}`.trim(),
    ),
    clusterId: cluster.id,
  };
  writeCache(citationText, result);
  return result;
}

/**
 * The full URL for a CourtListener case, suitable for embedding in a
 * synthesized resource's "External references" section.
 */
export function courtListenerUrl(c: CourtListenerCase): string {
  return c.absoluteUrl.startsWith('http')
    ? c.absoluteUrl
    : `https://www.courtlistener.com${c.absoluteUrl}`;
}
