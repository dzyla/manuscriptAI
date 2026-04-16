import { Cite } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import '@citation-js/plugin-csl';

import type { ManuscriptSource } from '../types';

export interface CitationEntry {
  key: string;
  authorYear: string; // "Smith, 2023" — used for matching and display
  title: string;
}

export interface CitationAnalysis {
  entries: CitationEntry[];
  citedInText: string[];    // authorYear strings that matched a bib entry
  unusedInBib: CitationEntry[]; // bib entries never cited in manuscript
  orphanedInText: string[]; // in-text citations that have no matching bib entry
  numericCitations: string[]; // [1], [2,3] style — can't cross-check without numeric bib
}

export type BibStyle = 'apa' | 'vancouver' | 'harvard1' | 'ieee' | 'nature';

export const BIB_STYLE_LABELS: Record<BibStyle, string> = {
  apa: 'APA 7th',
  vancouver: 'Vancouver',
  harvard1: 'Harvard',
  ieee: 'IEEE',
  nature: 'Nature',
};

/** Parse all entries from a .bib string into structured CSL data. */
function parseBibEntries(bibText: string): Array<{ key: string; authorLastName: string; year: string; title: string }> {
  try {
    const cite = new Cite(bibText);
    const data: any[] = cite.get({ format: 'data', type: 'array', style: 'csl' });
    return data.map((entry: any) => ({
      key: entry.id || '',
      authorLastName: (entry.author?.[0]?.family || entry.author?.[0]?.literal || entry.id || '').replace(/[{}]/g, ''),
      year: entry.issued?.['date-parts']?.[0]?.[0]?.toString() || '',
      title: (entry.title || '').replace(/[{}']/g, '').substring(0, 80),
    }));
  } catch (e) {
    console.error('BIB parse error:', e);
    return [];
  }
}

/**
 * Scan manuscript plain text for in-text citations and cross-reference
 * against a .bib file. Returns matched, unmatched, and unused entries.
 */
export function detectOrphanedCitations(bibText: string, manuscriptText: string): CitationAnalysis {
  const bibEntries = parseBibEntries(bibText);
  if (bibEntries.length === 0) {
    return { entries: [], citedInText: [], unusedInBib: [], orphanedInText: [], numericCitations: [] };
  }

  // --- Extract in-text citations ---
  const authorYearFound = new Set<string>(); // "LastName, YYYY"

  // (Smith, 2023) · (Smith and Jones, 2023) · (Smith et al., 2023) · (Smith et al. 2023)
  const parenRe = /\(([A-Z][A-Za-zÀ-ÖØ-öø-ÿ\-']+)(?:\s+(?:and|&)\s+[A-Z][A-Za-z\-']+)?(?:\s+et\s+al\.?)?,?\s+(\d{4}[a-z]?)\)/g;
  for (const m of manuscriptText.matchAll(parenRe)) {
    authorYearFound.add(`${m[1].trim()}, ${m[2]}`);
  }

  // Smith (2023) · Smith et al. (2023) — narrative style
  const narrativeRe = /\b([A-Z][A-Za-zÀ-ÖØ-öø-ÿ\-']+)(?:\s+et\s+al\.?)?\s+\((\d{4}[a-z]?)\)/g;
  for (const m of manuscriptText.matchAll(narrativeRe)) {
    authorYearFound.add(`${m[1]}, ${m[2]}`);
  }

  // Numeric citations [1] [1,2] [1-3] — can't resolve without numbered bib, collect separately
  const numericCitations: string[] = [];
  const numericRe = /\[(\d+(?:[,\s]\d+)*(?:-\d+)?)\]/g;
  for (const m of manuscriptText.matchAll(numericRe)) {
    numericCitations.push(`[${m[1]}]`);
  }

  // --- Cross-reference ---
  const matchedBibKeys = new Set<string>();
  const citedInText: string[] = [];
  const orphanedInText: string[] = [];

  for (const inText of authorYearFound) {
    const [authorPart, yearPart] = inText.split(', ');
    const match = bibEntries.find(
      e => e.authorLastName.toLowerCase() === authorPart.toLowerCase() && e.year === yearPart
    );
    if (match) {
      matchedBibKeys.add(match.key);
      citedInText.push(inText);
    } else {
      orphanedInText.push(inText);
    }
  }

  const unusedInBib = bibEntries
    .filter(e => !matchedBibKeys.has(e.key))
    .map(e => ({ key: e.key, authorYear: `${e.authorLastName}, ${e.year}`, title: e.title }));

  const entries = bibEntries.map(e => ({
    key: e.key,
    authorYear: `${e.authorLastName}, ${e.year}`,
    title: e.title,
  }));

  return { entries, citedInText, unusedInBib, orphanedInText, numericCitations };
}

/**
 * Generate a formatted HTML bibliography from a .bib string.
 * Falls back to plain-text if CSL rendering fails.
 */
export function formatBibliography(bibText: string, style: BibStyle = 'apa'): string {
  try {
    const cite = new Cite(bibText);
    const html: string = cite.format('bibliography', {
      format: 'html',
      template: style,
      lang: 'en-US',
    });
    // citation-js wraps output in a <div class="csl-bib-body">; return as-is
    return html || '<p>No entries found.</p>';
  } catch (cslErr) {
    console.warn('CSL formatting failed, falling back to plain text:', cslErr);
    // Fallback: simple manual formatting from CSL data
    try {
      const cite = new Cite(bibText);
      const data: any[] = cite.get({ format: 'data', type: 'array', style: 'csl' });
      const lines = data.map((entry: any) => {
        const authors = (entry.author || [])
          .map((a: any) => `${(a.family || a.literal || '').replace(/[{}]/g, '')}, ${(a.given || '').charAt(0)}.`)
          .join('; ');
        const year = entry.issued?.['date-parts']?.[0]?.[0] || 'n.d.';
        const title = (entry.title || '').replace(/[{}']/g, '');
        const journal = (entry['container-title'] || entry.publisher || '').replace(/[{}']/g, '');
        const volume = entry.volume ? ` ${entry.volume}` : '';
        const pages = entry.page ? `:${entry.page}` : '';
        return `<p>${authors} (${year}). ${title}. <em>${journal}</em>${volume}${pages}.</p>`;
      });
      return lines.join('\n') || '<p>No entries found.</p>';
    } catch (e) {
      return '<p>Could not format bibliography. Please check the .bib file for errors.</p>';
    }
  }
}

// ─── Numeric citation utilities ───────────────────────────────────────────────

/** Parse the inner part of a bracket group, e.g. "1-3,5" → [1,2,3,5] */
export function expandCitationNums(inner: string): number[] {
  const nums: number[] = [];
  for (const part of inner.split(',')) {
    const t = part.trim();
    const dash = t.indexOf('-');
    if (dash > 0) {
      const a = parseInt(t.slice(0, dash));
      const b = parseInt(t.slice(dash + 1));
      if (!isNaN(a) && !isNaN(b)) for (let i = a; i <= b; i++) nums.push(i);
    } else {
      const n = parseInt(t);
      if (!isNaN(n) && n > 0) nums.push(n);
    }
  }
  return nums;
}

/** Convert a sorted array of numbers to a compressed bracket string, e.g. [1,2,3,5] → "[1-3,5]" */
export function formatCitationGroup(nums: number[]): string {
  const sorted = [...new Set(nums)].filter(n => n > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  const parts: string[] = [];
  let start = sorted[0], end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) { end = sorted[i]; }
    else { parts.push(start === end ? `${start}` : `${start}-${end}`); start = end = sorted[i]; }
  }
  parts.push(start === end ? `${start}` : `${start}-${end}`);
  return `[${parts.join(',')}]`;
}

/**
 * Merge immediately adjacent citation groups in HTML, e.g. "[1][2] [3]" → "[1-3]".
 * Only merges groups with at most whitespace between them (not across HTML tags).
 */
export function mergeAdjacentCitations(html: string): string {
  return html.replace(/(\[[\d,\-]+\])(\s*\[[\d,\-]+\])+/g, (match) => {
    const nums = new Set<number>();
    const pat = /\[([\d,\-]+)\]/g;
    let m;
    while ((m = pat.exec(match)) !== null) expandCitationNums(m[1]).forEach(n => nums.add(n));
    return formatCitationGroup([...nums].sort((a, b) => a - b));
  });
}

/** Count how many citation groups in the HTML document include a given number */
export function countCitationOccurrences(html: string, num: number): number {
  let count = 0;
  const pat = /\[([\d,\-]+)\]/g;
  let m;
  while ((m = pat.exec(html)) !== null) {
    if (expandCitationNums(m[1]).includes(num)) count++;
  }
  return count;
}

// ─── Crossref DOI lookup ──────────────────────────────────────────────────────

/**
 * Fetch metadata for a DOI from the Crossref public REST API.
 * Returns a ManuscriptSource ready to add to the source store.
 * Throws a descriptive error on 404 or network failure.
 */
export async function fetchCrossrefDoi(doi: string): Promise<ManuscriptSource> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi.trim())}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'ManuscriptAIEditor/1.0 (mailto:user@example.com)' } });
  } catch {
    throw new Error('Network error — could not reach Crossref. Check your connection.');
  }
  if (res.status === 404) throw new Error(`DOI not found: ${doi}`);
  if (!res.ok) throw new Error(`Crossref returned ${res.status} for DOI: ${doi}`);

  const json = await res.json();
  const work = json.message as Record<string, any>;

  const title: string = Array.isArray(work.title) && work.title.length > 0
    ? String(work.title[0])
    : doi;

  const authors: string = Array.isArray(work.author)
    ? work.author
        .map((a: any) => [a.family, a.given].filter(Boolean).join(', '))
        .join('; ')
    : '';

  const year: number | null =
    work.published?.['date-parts']?.[0]?.[0] ??
    work['published-print']?.['date-parts']?.[0]?.[0] ??
    work['published-online']?.['date-parts']?.[0]?.[0] ??
    null;

  const journal: string = Array.isArray(work['container-title']) && work['container-title'].length > 0
    ? String(work['container-title'][0])
    : '';

  // Crossref abstracts often include JATS XML tags — strip them
  const rawAbstract: string = typeof work.abstract === 'string' ? work.abstract : '';
  const abstract = rawAbstract.replace(/<[^>]*>/g, '').trim();

  const doiStr: string = typeof work.DOI === 'string' ? work.DOI : doi;

  const fullText = [title, authors, journal, abstract].filter(Boolean).join('\n');

  return {
    id: crypto.randomUUID(),
    name: title.substring(0, 80),
    type: 'api',
    text: fullText,
    abstractText: abstract || undefined,
    apiMeta: {
      title,
      authors,
      journal,
      doi: doiStr,
      abstract,
      year,
      score: 1,
      source: 'Crossref',
    },
  };
}

/** Returns true if the string looks like a DOI (starts with 10. prefix) */
export function looksLikeDoi(text: string): boolean {
  return /^10\.\d{4,}\/\S{3,}/.test(text.trim());
}
