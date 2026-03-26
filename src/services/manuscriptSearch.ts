import { SemanticSearchResult } from '../types';

const SEARCH_API_URL = 'http://152.53.80.217:8080/search';
const SEARCH_API_KEY = 'myapp_kZnDpemyN9z43CqNrOYEE-LhAH9_UsxhWTavLkWv22Y';

/**
 * POST via Electron's main-process net module (no CORS/mixed-content) when available.
 * In a browser served over HTTPS, automatically upgrades the target URL to HTTPS
 * to avoid mixed-content blocking. Falls back to a graceful failure if unreachable.
 */
async function netPost(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<{ ok: boolean; status: number; text: string }> {
  const electronAPI = (window as any).electron as
    | { netPost?: (u: string, h: Record<string, string>, b: string) => Promise<{ ok: boolean; status: number; text: string; error?: string }> }
    | undefined;

  // Electron path — main-process fetch bypasses CORS and mixed-content rules
  if (electronAPI?.netPost) {
    return electronAPI.netPost(url, headers, body);
  }

  // Browser path — upgrade HTTP → HTTPS when the page itself is served over HTTPS
  // to avoid "mixed active content" blocking.
  let fetchUrl = url;
  if (
    typeof window !== 'undefined' &&
    window.location.protocol === 'https:' &&
    url.startsWith('http://')
  ) {
    fetchUrl = url.replace('http://', 'https://');
  }

  try {
    const response = await fetch(fetchUrl, { method: 'POST', headers, body });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch (err) {
    // Network error (e.g. server has no TLS cert) — return a detectable failure
    // so callers can degrade gracefully instead of crashing.
    return { ok: false, status: 0, text: String(err) };
  }
}

export async function searchSimilarManuscripts(
  query: string,
  topK: number = 5
): Promise<SemanticSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const bodyStr = JSON.stringify({
    query: trimmed.slice(0, 500),
    top_k: Math.min(Math.max(topK, 5), 10),
    high_quality_only: true,
  });

  const result = await netPost(
    SEARCH_API_URL,
    { 'X-API-Key': SEARCH_API_KEY, 'Content-Type': 'application/json' },
    bodyStr
  );

  if (!result.ok) {
    throw new Error(`Search API error ${result.status}: ${result.text.slice(0, 200)}`);
  }

  const data = JSON.parse(result.text);
  return (data.results as SemanticSearchResult[]) || [];
}

export function resultToBibtex(result: SemanticSearchResult): string {
  const firstAuthorLast =
    result.authors.split(/[,;]/)[0].trim().split(' ').pop() || 'Unknown';
  const key = `${firstAuthorLast}${result.year || 'XXXX'}`;
  return `@article{${key},
  title   = {${result.title}},
  author  = {${result.authors}},
  journal = {${result.journal}},
  year    = {${result.year ?? ''}},
  doi     = {${result.doi}},
  note    = {${result.source}}
}`;
}

export function doiToUrl(doi: string): string {
  if (doi.startsWith('http')) return doi;
  return `https://doi.org/${doi}`;
}
