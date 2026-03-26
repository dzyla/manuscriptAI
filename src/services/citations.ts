import { Cite } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import '@citation-js/plugin-csl';

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
