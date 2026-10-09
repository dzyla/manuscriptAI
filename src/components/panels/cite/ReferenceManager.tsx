import { useState } from 'react';
import { ArrowRight, BookMarked, ExternalLink, Hash, Library, RefreshCw, Search, X } from 'lucide-react';
import type { ManuscriptSource } from '../../../types';
import { doiToUrl } from '../../../services/manuscriptSearch';
import { formatBibliography, BIB_STYLE_LABELS, countCitationOccurrences, type BibStyle } from '../../../services/citations';

export interface ReferenceManagerProps {
  sources: ManuscriptSource[];
  /** sourceId -> citation number, as the document store keeps it. */
  citationRegistry?: Record<string, number>;
  documentHTML?: string;
  onRenumberCitations?: () => void;
  onRemoveCitation?: (sourceId: string) => void;
  onScrollToCitation?: (num: number) => void;
  /** Append this HTML to the end of the manuscript (a formatted bibliography or the reference list). */
  onInsertHtml?: (html: string) => void;
}

/** The bibliography formatter (when a .bib is loaded) and the reference list: filter, sort, expand, jump to, remove, renumber, insert. */
export function ReferenceManager({ sources, citationRegistry, documentHTML = '', onRenumberCitations, onRemoveCitation, onScrollToCitation, onInsertHtml }: ReferenceManagerProps) {
  const [refSearch, setRefSearch] = useState('');
  const [refSort, setRefSort] = useState<'order' | 'author' | 'year'>('order');
  const [expandedRefIds, setExpandedRefIds] = useState<Set<string>>(new Set());
  const [bibStyle, setBibStyle] = useState<BibStyle>('apa');
  const [insertingBib, setInsertingBib] = useState(false);

  const handleInsertBibliography = (bibSourceText: string, onInsert: (html: string) => void) => {
    setInsertingBib(true);
    try {
      const html = formatBibliography(bibSourceText, bibStyle);
      onInsert(html);
    } catch (e) {
      console.error('Bibliography format failed:', e);
    } finally {
      setInsertingBib(false);
    }
  };

  const hasRefs = !!citationRegistry && Object.keys(citationRegistry).length > 0;
  const hasBib = sources.some(s => s.type === 'bib');

  return (
    <div className="space-y-4">
      {!hasRefs && !hasBib && (
        <p className="text-[10px] text-center" style={{ color: 'var(--text-muted)' }}>No references yet</p>
      )}
      {sources.some(s => s.type === 'bib') && (
        <div className="border rounded-xl p-3 space-y-2" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}>
          <div className="flex items-center gap-2">
            <Library size={13} style={{ color: 'var(--text-muted)' }} />
            <span className="text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>Auto-format Bibliography</span>
          </div>
          <div className="flex items-center gap-2">
            <select
              data-testid="control-bib-style"
              value={bibStyle}
              onChange={e => setBibStyle(e.target.value as BibStyle)}
              className="flex-1 text-[11px] rounded-lg px-2 py-1.5 border focus:outline-none"
              style={{ borderColor: 'var(--border)', background: 'var(--surface-0)', color: 'var(--text-secondary)' }}
            >
              {(Object.entries(BIB_STYLE_LABELS) as [BibStyle, string][]).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            <button
              onClick={() => {
                const bibSource = sources.find(s => s.type === 'bib');
                if (!bibSource) return;
                handleInsertBibliography(bibSource.text, (html) => {
                  // Notify parent to append bibliography HTML to the editor
                  onInsertHtml?.(`<h2>References</h2>${html}`);
                });
              }}
              data-testid="control-format-bibliography"
              disabled={insertingBib}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-50"
              style={{ background: 'var(--surface-2)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              <Library size={11} />
              {insertingBib ? 'Formatting...' : 'Insert'}
            </button>
          </div>
          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Appends a formatted bibliography to the end of your manuscript.
          </p>
        </div>
      )}

      {citationRegistry && Object.keys(citationRegistry).length > 0 && (() => {
        // Build sorted + filtered reference list
        const allEntries = Object.entries(citationRegistry).map(([id, numRaw]) => {
          const num = numRaw as number;
          const src = sources.find(s => s.id === id);
          const author = src?.apiMeta?.authors?.split(/[,;]/)[0]?.trim() ?? src?.name.replace(/\.(pdf|txt|md|docx)$/i, '') ?? '';
          const year = src?.apiMeta?.year ?? 0;
          const title = src?.apiMeta?.title ?? src?.name ?? '';
          const count = documentHTML ? countCitationOccurrences(documentHTML, num) : 0;
          return { id, num, src, author, year, title, count };
        });

        const filtered = allEntries.filter(e => {
          if (!refSearch.trim()) return true;
          const q = refSearch.toLowerCase();
          return e.author.toLowerCase().includes(q) || e.title.toLowerCase().includes(q) || String(e.year).includes(q);
        });

        const sorted = [...filtered].sort((a, b) => {
          if (refSort === 'author') return a.author.localeCompare(b.author);
          if (refSort === 'year') return b.year - a.year;
          return a.num - b.num;
        });

        return (
          <div className="border rounded-xl overflow-hidden" style={{ borderColor: 'var(--border)' }}>
            {/* Header */}
            <div className="px-3 pt-2.5 pb-2 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <BookMarked size={13} style={{ color: 'var(--text-muted)' }} />
                  <span className="text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>Reference Manager</span>
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                    {allEntries.length}
                  </span>
                </div>
                <button
                  data-testid="control-renumber"
                  onClick={onRenumberCitations}
                  title="Renumber citations in document order"
                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold"
                  style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                >
                  <RefreshCw size={9} /> Sync order
                </button>
              </div>

              {/* Search + sort row */}
              <div className="flex gap-1.5">
                <div className="flex-1 flex items-center gap-1.5 px-2 py-1 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border)' }}>
                  <Search size={10} style={{ color: 'var(--text-muted)' }} className="shrink-0" />
                  <input
                    data-testid="control-filter-references"
                    value={refSearch}
                    onChange={e => setRefSearch(e.target.value)}
                    placeholder="Search references…"
                    className="flex-1 bg-transparent text-[11px] outline-none"
                    style={{ color: 'var(--text-primary)' }}
                  />
                  {refSearch && (
                    <button data-testid="control-clear-reference-filter" onClick={() => setRefSearch('')} style={{ color: 'var(--text-muted)' }}>
                      <X size={10} />
                    </button>
                  )}
                </div>
                <select
                  data-testid="control-sort-references"
                  value={refSort}
                  onChange={e => setRefSort(e.target.value as any)}
                  className="text-[10px] rounded-lg px-1.5 outline-none"
                  style={{ background: 'var(--surface-0)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                >
                  <option value="order"># Order</option>
                  <option value="author">Author</option>
                  <option value="year">Year</option>
                </select>
              </div>
            </div>

            {/* Reference list */}
            <div className="divide-y max-h-[480px] overflow-y-auto" style={{ borderColor: 'var(--border)' }}>
              {sorted.length === 0 && (
                <p className="px-3 py-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>No references match.</p>
              )}
              {sorted.map(({ id, num, src, author, year, title, count }) => {
                const isExpanded = expandedRefIds.has(id);
                const doi = src?.apiMeta?.doi;
                const journal = src?.apiMeta?.journal;
                const abstract = src?.digest || src?.text?.slice(0, 300);
                return (
                  <div key={id} style={{ background: 'var(--surface-0)' }}>
                    <div className="flex items-start gap-2 px-3 py-2.5">
                      {/* Citation number badge */}
                      <span
                        className="text-[10px] font-bold tabular-nums shrink-0 mt-0.5 min-w-[20px] text-center rounded-md px-1 py-0.5 cursor-pointer"
                        style={{ background: 'var(--accent-blue)', color: '#fff' }}
                        data-testid="control-first-citation"
                        title="Jump to first citation"
                        onClick={() => onScrollToCitation?.(num)}
                      >
                        {num}
                      </span>

                      <div className="flex-1 min-w-0">
                        {/* Author + year */}
                        <div className="flex items-baseline gap-1.5 flex-wrap">
                          <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {author || '(unknown)'}
                          </span>
                          {year > 0 && (
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>({year})</span>
                          )}
                        </div>
                        {/* Title */}
                        {title && (
                          <p className={`text-[10px] mt-0.5 ${isExpanded ? '' : 'truncate'}`} style={{ color: 'var(--text-secondary)' }}>
                            {title}
                          </p>
                        )}
                        {/* Journal */}
                        {journal && isExpanded && (
                          <p className="text-[10px] mt-0.5 italic" style={{ color: 'var(--text-muted)' }}>{journal}</p>
                        )}
                        {/* DOI */}
                        {doi && isExpanded && (
                          <a href={doiToUrl(doi)} target="_blank" rel="noreferrer"
                            className="text-[9px] hover:underline flex items-center gap-0.5 mt-0.5"
                            style={{ color: 'var(--accent-blue)' }}>
                            <ExternalLink size={8} /> {doi}
                          </a>
                        )}
                        {/* Abstract/digest snippet */}
                        {abstract && isExpanded && (
                          <p className="text-[10px] mt-1.5 leading-relaxed line-clamp-4" style={{ color: 'var(--text-muted)', borderLeft: '2px solid var(--border)', paddingLeft: '6px' }}>
                            {abstract}
                          </p>
                        )}
                        {/* Meta row: citation count + expand toggle */}
                        <div className="flex items-center gap-2 mt-1">
                          {count > 0 && (
                            <span className="flex items-center gap-0.5 text-[9px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                              <Hash size={8} /> {count}×
                            </span>
                          )}
                          {(title || doi || abstract) && (
                            <button
                              data-testid="control-expand-reference"
                              onClick={() => setExpandedRefIds(prev => {
                                const s = new Set(prev);
                                s.has(id) ? s.delete(id) : s.add(id);
                                return s;
                              })}
                              className="text-[9px]"
                              style={{ color: 'var(--accent-blue)' }}
                            >
                              {isExpanded ? 'Less' : 'More'}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="flex flex-col gap-1 shrink-0">
                        <button
                          onClick={() => onScrollToCitation?.(num)}
                          data-testid="control-goto-citation"
                          title="Jump to citation in document"
                          className="p-1 rounded hover:opacity-80"
                          style={{ color: 'var(--accent-blue)' }}
                        >
                          <ArrowRight size={11} />
                        </button>
                        <button
                          onClick={() => onRemoveCitation?.(id)}
                          data-testid="control-remove-citation"
                          title="Remove citation"
                          className="p-1 rounded hover:opacity-80"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          <X size={11} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Actions */}
            <div className="flex gap-1.5 px-3 py-2 border-t" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}>
              <button
                data-testid="control-insert-reference-list"
                onClick={() => {
                  const entries = Object.entries(citationRegistry).sort((a, b) => a[1] - b[1]);
                  const lines = entries.map(([id, num]) => {
                    const src = sources.find(s => s.id === id);
                    if (!src) return `<li>[${num}] (source not found)</li>`;
                    if (src.apiMeta) {
                      const m = src.apiMeta;
                      const doiPart = m.doi ? ` doi:${m.doi}` : '';
                      return `<li>[${num}] ${m.authors}${m.year ? ` (${m.year})` : ''}. ${m.title}. <em>${m.journal}</em>.${doiPart}</li>`;
                    }
                    return `<li>[${num}] ${src.name.replace(/\.(pdf|txt|md|docx)$/i, '')}</li>`;
                  });
                  onInsertHtml?.(`<h2>References</h2><ol>${lines.join('')}</ol>`);
                }}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-semibold"
                style={{ background: 'var(--surface-2)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              >
                <BookMarked size={11} />
                Insert reference list
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
