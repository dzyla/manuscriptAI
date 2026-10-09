import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Search, Zap } from 'lucide-react';
import type { AISettings, ManuscriptSource } from '../../../types';
import { searchSimilarManuscripts } from '../../../services/manuscriptSearch';
import { scorePdfMatches } from '../../../services/ai';
import { useSourceStore } from '../../../stores/useSourceStore';
import type { PendingPdfMatches } from './useSourceUpload';

export interface PdfMatchProps {
  source: ManuscriptSource;
  /** This source's pending candidates, if any. */
  match: PendingPdfMatches[string] | undefined;
  setPending: Dispatch<SetStateAction<PendingPdfMatches>>;
  aiSettings?: AISettings;
}

/** An uploaded PDF's "is this your paper?" flow: a manual title search, then the candidates one at a time (confirm, try the next, dismiss). */
export function PdfMatch({ source, match, setPending, aiSettings }: PdfMatchProps) {
  const { updateSource } = useSourceStore();
  const [manualQuery, setManualQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const hasPending = !!match;

  const runManualSearch = () => {
    const q = manualQuery.trim();
    if (q.length < 3) return;
    setIsSearching(true);
    const srcId = source.id;
    searchSimilarManuscripts(q, 10)
      .then(results => {
        if (results.length > 0) {
          const top10 = results.slice(0, 10);
          setPending(prev => ({ ...prev, [srcId]: { results: top10, matchIndex: 0 } }));
          // Run scoring agent if AI settings available
          if (aiSettings) {
            const queryForScoring = source.abstractText && !source.abstractText.startsWith('Abstract not available')
              ? source.abstractText
              : source.digest ?? q;
            scorePdfMatches(source.name, queryForScoring, top10, aiSettings)
              .then(scores => {
                if (scores.length > 0) {
                  const ordered = scores.map(s => top10[s.index]).filter(Boolean);
                  setPending(prev => {
                    const existing = prev[srcId];
                    if (!existing) return prev;
                    return { ...prev, [srcId]: { results: ordered, matchIndex: 0, scores } };
                  });
                }
              })
              .catch(() => {});
          }
        }
      })
      .catch(() => {})
      .finally(() => setIsSearching(false));
  };

  return (
    <div className="px-3 pb-3 space-y-2">
      {/* Manual search row */}
      <div className="flex gap-1.5">
        <input
          value={manualQuery}
          onChange={e => setManualQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') runManualSearch(); }}
          placeholder="Search paper title or keywords…"
          className="flex-1 text-[10px] px-2 py-1.5 border rounded-lg focus:outline-none"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-0)', color: 'var(--text-primary)' }}
        />
        <button
          data-testid="control-match-pdf"
          onClick={runManualSearch}
          disabled={isSearching || manualQuery.trim().length < 3}
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold transition-colors disabled:opacity-40"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
        >
          <Search size={10} />
          {isSearching ? '…' : 'Search'}
        </button>
      </div>

      {hasPending && match && (() => {
        const result = match.results[match.matchIndex];
        if (!result) return null;
        // Find score entry for the current result (scores are already in display order)
        const currentScore = match.scores?.[match.matchIndex];
        const hasScore = currentScore && currentScore.score >= 0;
        return (
          <div className="p-2.5 rounded-lg border space-y-1.5" style={{ background: 'var(--surface-2)', borderColor: 'var(--border)' }}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-bold text-amber-700 flex items-center gap-1">
                <Zap size={10} />
                Is this your paper? ({match.matchIndex + 1}/{match.results.length})
              </p>
              {hasScore && (
                <span
                  className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0"
                  style={{
                    background: currentScore.score >= 70 ? 'var(--accent-green-soft, #d1fae5)' : currentScore.score >= 40 ? 'var(--accent-yellow-soft, #fef9c3)' : 'var(--surface-3, #f1f5f9)',
                    color: currentScore.score >= 70 ? '#065f46' : currentScore.score >= 40 ? '#713f12' : 'var(--text-muted)',
                  }}
                >
                  {currentScore.score}/100
                </span>
              )}
            </div>
            <p className="text-[11px] font-semibold leading-tight" style={{ color: 'var(--text-primary)' }}>
              {result.title}
            </p>
            <p className="text-[10px] truncate" style={{ color: 'var(--text-secondary)' }} title={result.authors}>
              {result.authors}
            </p>
            <p className="text-[10px] italic" style={{ color: 'var(--text-tertiary)' }}>
              {result.journal}{result.year ? `, ${result.year}` : ''}
            </p>
            {hasScore && currentScore.reason && (
              <p className="text-[10px] italic" style={{ color: 'var(--text-muted)' }}>
                {currentScore.reason}
              </p>
            )}
            <div className="flex gap-1.5 pt-0.5">
              <button
                data-testid="control-match-yes"
                onClick={() => {
                  updateSource(source.id, { name: result.title, apiMeta: result });
                  setPending(prev => { const { [source.id]: _, ...rest } = prev; return rest; });
                }}
                className="flex-1 py-1 rounded text-[10px] font-semibold text-white bg-emerald-600 hover:bg-emerald-500 transition-colors"
              >
                Yes, this is it
              </button>
              {match.matchIndex + 1 < match.results.length && (
                <button
                  data-testid="control-match-next"
                  onClick={() => setPending(prev => ({
                    ...prev,
                    [source.id]: { ...prev[source.id], matchIndex: prev[source.id].matchIndex + 1 }
                  }))}
                  className="flex-1 py-1 border rounded text-[10px] font-semibold transition-colors hover:bg-stone-50"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                >
                  Try next
                </button>
              )}
              <button
                data-testid="control-match-dismiss"
                onClick={() => setPending(prev => { const { [source.id]: _, ...rest } = prev; return rest; })}
                className="px-2 py-1 border rounded text-[10px] transition-colors hover:bg-stone-50"
                style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
              >
                Dismiss
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
