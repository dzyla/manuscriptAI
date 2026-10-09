import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { FileText, Search, Trash2, ExternalLink, BookMarked, MessageSquare, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { AISettings, ManuscriptSource } from '../../../types';
import { doiToUrl } from '../../../services/manuscriptSearch';
import { detectOrphanedCitations, type CitationAnalysis } from '../../../services/citations';
import { PdfMatch } from './PdfMatch';
import { ApiSourceDetails, DocumentSourceTabs } from './SourceTabs';
import type { PendingPdfMatches } from './useSourceUpload';

export interface SourceCardProps {
  source: ManuscriptSource;
  aiSettings?: AISettings;
  manuscriptContent: string;
  /** The summary of this search result is being generated right now. */
  isDigesting: boolean;
  /** The upload pipeline is summarising this source right now. */
  digestingId: string | null;
  pendingMatches: PendingPdfMatches;
  onPendingMatchesChange: Dispatch<SetStateAction<PendingPdfMatches>>;
  analyzingSourceId?: string | null;
  onRemove: () => void;
  onCompare: (source: ManuscriptSource) => void;
  onChat: (source: ManuscriptSource) => void;
}

/** One source in the library: its header, what kind of record it is, and the actions that kind offers. */
export function SourceCard({ source, aiSettings, manuscriptContent, isDigesting, digestingId, pendingMatches, onPendingMatchesChange, analyzingSourceId, onRemove, onCompare, onChat }: SourceCardProps) {
  const [analysis, setAnalysis] = useState<CitationAnalysis | null>(null);
  const [checking, setChecking] = useState(false);

  const checkCitations = () => {
    setChecking(true);
    try {
      setAnalysis(detectOrphanedCitations(source.text, manuscriptContent));
    } catch (e) {
      console.error('Citation check failed:', e);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="rounded-xl shadow-sm overflow-hidden" style={{ border: source.type === 'api' ? '1.5px solid rgba(139,92,246,0.5)' : '1px solid var(--border)', background: source.type === 'api' ? 'var(--surface-2)' : 'var(--surface-1)', boxShadow: source.type === 'api' ? '0 2px 8px rgba(124,58,237,0.08)' : undefined }}>
      <div className="flex items-center justify-between p-3">
        <div className="flex items-center gap-2 overflow-hidden">
          {source.type === 'api' ? <Search size={14} style={{ color: '#7c3aed' }} className="shrink-0" /> : <FileText size={14} style={{ color: 'var(--text-tertiary)' }} className="shrink-0" />}
          <div className="truncate">
            <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{source.name}</p>
            <p className="text-[9px]" style={{ color: 'var(--text-tertiary)' }}>
              {source.type === 'api' ? (
                <>
                  <span className="text-violet-600 font-semibold">{source.apiMeta?.source}</span>
                  {source.apiMeta?.year && <span> · {source.apiMeta.year}</span>}
                  {source.apiMeta && (
                    <span className={`ml-1 font-semibold ${source.apiMeta.score >= 0.8 ? 'text-emerald-600' : source.apiMeta.score >= 0.7 ? 'text-amber-600' : 'text-stone-500'}`}>
                      · {(source.apiMeta.score * 100).toFixed(0)}% match
                    </span>
                  )}
                </>
              ) : (
                <>
                  {source.type.toUpperCase()} • {Math.round(source.text.length / 1024)} KB
                  {source.digest && <span className="ml-1 text-emerald-600 font-semibold">• digested</span>}
                </>
              )}
            </p>
          </div>
        </div>
        <button
          data-testid="control-remove-source"
          className="p-1.5 rounded-lg hover:bg-stone-100 transition-colors shrink-0" style={{ color: 'var(--text-muted)' }}
          onClick={onRemove}
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* PDF match confirmation UI */}
      {source.type === 'pdf' && (
        <PdfMatch source={source} match={pendingMatches[source.id]} setPending={onPendingMatchesChange} aiSettings={aiSettings} />
      )}

      {/* API source metadata + tabbed Summary / Abstract */}
      {source.type === 'api' && source.apiMeta && (
        <ApiSourceDetails source={source} aiSettings={aiSettings} isDigesting={isDigesting} analyzingSourceId={analyzingSourceId} onCompare={onCompare} />
      )}

      {source.type === 'bib' && (
        <div className="px-3 pb-3 space-y-2">
          <button
            data-testid="control-check-citations"
            onClick={checkCitations}
            disabled={checking}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-50"
            style={{ background: 'var(--teal-soft, #f0fdfa)', color: 'var(--teal-700, #0f766e)', border: '1px solid var(--teal-200, #99f6e4)' }}
          >
            <CheckCircle2 size={12} />
            {checking ? 'Checking...' : 'Check Citations'}
          </button>
          {analysis && (() => {
            const a = analysis;
            return (
              <div className="space-y-2 text-[11px]">
                <div className="flex items-center gap-2 font-semibold" style={{ color: 'var(--text-secondary)' }}>
                  <CheckCircle2 size={11} className="text-emerald-500" />
                  {a.citedInText.length} cited · {a.unusedInBib.length} unused · {a.orphanedInText.length} unmatched
                </div>
                {a.orphanedInText.length > 0 && (
                  <div className="p-2 rounded-lg" style={{ background: 'var(--rose-soft, #fff1f2)', border: '1px solid #fecdd3' }}>
                    <div className="flex items-center gap-1 text-[10px] font-bold text-rose-600 mb-1"><AlertTriangle size={10} /> Not in .bib file</div>
                    {a.orphanedInText.map(c => <div key={c} className="text-rose-700 font-mono text-[10px]">{c}</div>)}
                  </div>
                )}
                {a.unusedInBib.length > 0 && (
                  <div className="p-2 rounded-lg" style={{ background: 'var(--amber-soft, #fffbeb)', border: '1px solid #fde68a' }}>
                    <div className="flex items-center gap-1 text-[10px] font-bold text-amber-600 mb-1"><AlertTriangle size={10} /> Unused .bib entries</div>
                    {a.unusedInBib.slice(0, 5).map(e => <div key={e.key} className="text-amber-700 text-[10px] truncate" title={e.title}>{e.authorYear} — {e.title}</div>)}
                    {a.unusedInBib.length > 5 && <div className="text-amber-600 text-[10px]">+{a.unusedInBib.length - 5} more</div>}
                  </div>
                )}
                {a.numericCitations.length > 0 && (
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {a.numericCitations.length} numeric citation(s) found — cross-check manually
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
      {(source.type === 'pdf' || source.type === 'text') && aiSettings && (
        <div className="px-3 pb-3 flex gap-2">
          <button
            disabled={!!analyzingSourceId}
            data-testid="control-compare-source"
            onClick={() => onCompare(source)}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-50"
            style={{
              background: analyzingSourceId === source.id ? 'var(--surface-2)' : 'var(--violet-soft, #f5f3ff)',
              color: 'var(--violet-700, #6d28d9)',
              border: '1px solid var(--violet-200, #ddd6fe)'
            }}
          >
            <BookMarked size={12} />
            {analyzingSourceId === source.id ? 'Analyzing...' : 'Compare'}
          </button>
          <button
            data-testid="control-chat-source"
            onClick={() => onChat(source)}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-semibold transition-colors"
            style={{
              background: 'var(--accent-blue-soft)',
              color: 'var(--accent-blue)',
              border: '1px solid rgba(59,111,212,0.2)'
            }}
          >
            <MessageSquare size={12} />
            Chat
          </button>
        </div>
      )}
      {source.type !== 'api' && source.apiMeta && (
        <div className="px-3 pb-2 space-y-0.5">
          <p className="text-[11px] font-semibold leading-snug" style={{ color: 'var(--text-primary)' }}>{source.apiMeta.title}</p>
          <p className="text-[10px] truncate" style={{ color: 'var(--text-secondary)' }} title={source.apiMeta.authors}>{source.apiMeta.authors}</p>
          <p className="text-[10px] italic" style={{ color: 'var(--text-muted)' }}>
            {source.apiMeta.journal}{source.apiMeta.year ? `, ${source.apiMeta.year}` : ''}
          </p>
          {source.apiMeta.doi && (
            <a href={doiToUrl(source.apiMeta.doi)} target="_blank" rel="noreferrer"
              className="text-[10px] hover:underline flex items-center gap-1"
              style={{ color: 'var(--accent-blue)' }}>
              <ExternalLink size={9} />
              {source.apiMeta.doi}
            </a>
          )}
        </div>
      )}
      {source.type !== 'api' && aiSettings && (
        <DocumentSourceTabs source={source} aiSettings={aiSettings} digestingId={digestingId} />
      )}
    </div>
  );
}
