import { expandCitationNums } from '../services/citations';

/**
 * Convert legacy "[N]" / "[N,M]" / "[N-M]" text patterns in HTML to CitationNode spans.
 * Called once when loading a document that was saved before CitationNode was introduced.
 *
 * @param html              Raw HTML that may contain plain "[1]" citation text
 * @param citationRegistry  Maps sourceId → number (e.g. {"pdf-abc": 1, "api-xyz": 2})
 * @returns                 HTML with [N] sequences replaced by CitationNode spans
 */
export function migrateLegacyCitations(
  html: string,
  citationRegistry: Record<string, number>
): string {
  if (Object.keys(citationRegistry).length === 0) return html;

  // Don't re-migrate already-migrated nodes
  if (html.includes('data-citation-node')) return html;

  // Build reverse map: num → sourceId
  const numToId: Record<number, string> = {};
  for (const [id, num] of Object.entries(citationRegistry)) {
    numToId[num] = id;
  }

  return html.replace(/\[([\d,\-]+)\]/g, (match, inner) => {
    const nums = expandCitationNums(inner);
    const sourceIds = nums.map(n => numToId[n]).filter(Boolean) as string[];
    if (sourceIds.length === 0) return match; // unknown citation, keep as plain text
    return `<span data-citation-node="" data-source-ids="${sourceIds.join(',')}" data-nums="${nums.join(',')}">${match}</span>`;
  });
}
