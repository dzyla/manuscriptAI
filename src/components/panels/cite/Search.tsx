import { useState } from 'react';
import { Sparkles, Plus, Search as SearchIcon, ExternalLink } from 'lucide-react';
import type { ManuscriptSource, SemanticSearchResult } from '../../../types';
import { searchSimilarManuscripts, doiToUrl } from '../../../services/manuscriptSearch';

export interface SearchProps {
  sources: ManuscriptSource[];
  /** Add a result to the library; the host also starts its summary. `query` is what was searched for. */
  onAddResult: (result: SemanticSearchResult, query: string) => void;
}

/** Semantic literature search: a query, its results, and "Add source" on each. The query and results live here, so they survive the section being collapsed. */
export function Search({ sources, onAddResult }: SearchProps) {
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [globalSearchResults, setGlobalSearchResults] = useState<SemanticSearchResult[]>([]);
  const [isGlobalSearching, setIsGlobalSearching] = useState(false);
  const [globalSearchError, setGlobalSearchError] = useState<string | null>(null);

  const runGlobalSearch = () => {
    const q = globalSearchQuery.trim();
    if (q.length < 3) return;
    setIsGlobalSearching(true);
    setGlobalSearchResults([]);
    setGlobalSearchError(null);
    searchSimilarManuscripts(q, 10)
      .then(r => setGlobalSearchResults(r))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        const isCors = msg.includes('status 0') || msg.includes('CORS') || msg.includes('fetch') || msg.includes('NetworkError') || msg.includes('Failed to fetch');
        setGlobalSearchError(isCors
          ? 'Search API unreachable — CORS preflight failed. Apply nginx-cors.conf on the server (see repo) and reload nginx.'
          : `Search failed: ${msg}`
        );
      })
      .finally(() => setIsGlobalSearching(false));
  };

  return (
  <div className="border rounded-xl overflow-hidden" style={{ borderColor: 'var(--border)' }}>
    <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}>
      <SearchIcon size={12} style={{ color: 'var(--text-muted)' }} />
      <span className="text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>Find Manuscripts</span>
    </div>
    <div className="p-3 space-y-2">
      <div className="flex gap-1.5">
        <input
          data-testid="control-query"
          value={globalSearchQuery}
          onChange={e => { setGlobalSearchQuery(e.target.value); setGlobalSearchError(null); }}
          onKeyDown={e => {
            if (e.key === 'Enter' && globalSearchQuery.trim().length >= 3) runGlobalSearch();
          }}
          placeholder="Title, keywords, or paste abstract…"
          className="flex-1 text-[11px] px-2.5 py-1.5 border rounded-lg focus:outline-none"
          style={{ borderColor: globalSearchError ? '#f87171' : 'var(--border)', background: 'var(--surface-0)', color: 'var(--text-primary)' }}
        />
        <button
          disabled={isGlobalSearching || globalSearchQuery.trim().length < 3}
          data-testid="control-run-search"
          onClick={runGlobalSearch}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-40"
          style={{ background: 'var(--accent-blue)', color: '#fff' }}
        >
          {isGlobalSearching ? <Sparkles size={11} className="animate-spin" /> : <SearchIcon size={11} />}
          {isGlobalSearching ? '' : 'Search'}
        </button>
      </div>
      {globalSearchError && (
        <p className="text-[10px] px-1" style={{ color: '#ef4444' }}>{globalSearchError}</p>
      )}

      {/* Results */}
      {globalSearchResults.length > 0 && (
        <div className="space-y-1.5 max-h-72 overflow-y-auto pr-0.5">
          {globalSearchResults.map((r, i) => {
            const alreadyAdded = sources.some(s => s.apiMeta?.doi && s.apiMeta.doi === r.doi);
            return (
              <div key={i} className="border rounded-lg p-2 space-y-0.5" style={{ borderColor: 'var(--border)', background: 'var(--surface-0)' }}>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[11px] font-semibold leading-tight flex-1" style={{ color: 'var(--text-primary)' }}>{r.title}</p>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                    {Math.round(r.score * 100)}%
                  </span>
                </div>
                <p className="text-[10px] truncate" style={{ color: 'var(--text-secondary)' }}>{r.authors}</p>
                <p className="text-[10px] italic" style={{ color: 'var(--text-muted)' }}>
                  {r.journal}{r.year ? `, ${r.year}` : ''}
                </p>
                <div className="flex items-center gap-1.5 pt-0.5">
                  <button
                    disabled={alreadyAdded}
                    data-testid="control-add-result"
                    onClick={() => { if (!alreadyAdded) onAddResult(r, globalSearchQuery.trim()); }}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold transition-colors disabled:opacity-40"
                    style={{ background: alreadyAdded ? 'var(--surface-2)' : 'var(--accent-blue)', color: alreadyAdded ? 'var(--text-muted)' : '#fff' }}
                  >
                    <Plus size={9} />
                    {alreadyAdded ? 'Added' : 'Add source'}
                  </button>
                  {r.doi && (
                    <a href={doiToUrl(r.doi)} target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 text-[10px] hover:underline"
                      style={{ color: 'var(--accent-blue)' }}>
                      <ExternalLink size={9} /> DOI
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!isGlobalSearching && !globalSearchError && globalSearchQuery.trim().length >= 3 && globalSearchResults.length === 0 && (
        <p className="text-[10px] text-center py-2" style={{ color: 'var(--text-muted)' }}>No results — try different keywords</p>
      )}
    </div>
  </div>
  );
}
