import { createPortal } from 'react-dom';
import { ArrowRight, BookOpen, Sparkles } from 'lucide-react';
import type { ManuscriptSource } from '../../types';
import { looksLikeDoi, normalizeDoi } from '../../services/citations';

/** The `@` citation picker: a source list filtered by what was typed after the `@`, plus a Crossref lookup row when the text looks like one or more DOIs. */
export function CitationPicker({ at, filter, sources, registry, doiState, doiError, onChooseSource, onLookupDoi, onLookupDois, onDismissError }: {
  at: { x: number; y: number };
  filter: string;
  sources: ManuscriptSource[];
  registry?: Record<string, number>;
  doiState: 'idle' | 'loading' | 'error';
  doiError: string | null;
  onChooseSource: (s: ManuscriptSource) => void;
  onLookupDoi: (doi: string) => void;
  onLookupDois: (dois: string[]) => void;
  onDismissError: () => void;
}) {
  const doiLike = looksLikeDoi(filter);
  const dois = filter.split(',').map(p => normalizeDoi(p.trim())).filter(p => looksLikeDoi(p));
  return createPortal(
    <div
      className="fixed z-[9999] rounded-xl shadow-2xl overflow-hidden"
      style={{ left: Math.min(at.x, window.innerWidth - 280), top: at.y, width: 260, background: 'var(--surface-1)', border: '1.5px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
      onMouseDown={e => e.preventDefault()}
    >
      <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
        <BookOpen size={10} style={{ color: 'var(--accent-blue)' }} />
        <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Insert Citation</p>
      </div>

      {doiLike && (
        <div className="border-b" style={{ borderColor: 'var(--border)' }}>
          {doiState === 'error' ? (
            <div className="px-3 py-2">
              <p className="text-[11px]" style={{ color: '#ef4444' }}>{doiError}</p>
              <button className="text-[10px] mt-1 underline" style={{ color: 'var(--text-muted)' }} onMouseDown={e => { e.preventDefault(); onDismissError(); }}>
                Dismiss
              </button>
            </div>
          ) : (
            <button
              className="w-full text-left px-3 py-2 transition-colors flex items-center gap-2"
              style={{ background: 'rgba(59,111,212,0.06)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(59,111,212,0.12)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(59,111,212,0.06)')}
              onMouseDown={e => {
                e.preventDefault();
                if (doiState !== 'idle') return;
                if (dois.length > 1) onLookupDois(dois); else onLookupDoi(dois[0] ?? filter);
              }}
              disabled={doiState === 'loading'}
            >
              {doiState === 'loading'
                ? <Sparkles size={12} className="animate-spin shrink-0" style={{ color: 'var(--accent-blue)' }} />
                : <ArrowRight size={12} className="shrink-0" style={{ color: 'var(--accent-blue)' }} />}
              <div className="min-w-0">
                <p className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {doiState === 'loading' ? 'Fetching from Crossref…' : dois.length > 1 ? `Look up ${dois.length} DOIs via Crossref` : 'Look up DOI via Crossref'}
                </p>
                <p className="text-[10px] truncate font-mono" style={{ color: 'var(--text-muted)' }}>{filter}</p>
              </div>
            </button>
          )}
        </div>
      )}

      {sources.length === 0 && !doiLike ? (
        <p className="px-3 py-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>No sources — upload PDFs, search, or type a DOI like 10.1234/xxx.</p>
      ) : null}
      {(sources.length > 0 || !doiLike) && (
        <div className="max-h-64 overflow-y-auto">
          {sources.map(src => {
            const num = registry?.[src.id];
            const label = src.type === 'api'
              ? (src.apiMeta?.authors?.split(/[,;]/)[0]?.trim() ?? src.name) + (src.apiMeta?.year ? `, ${src.apiMeta.year}` : '')
              : src.name.replace(/\.pdf$/i, '');
            return (
              <button
                key={src.id}
                className="w-full text-left px-3 py-2 border-b last:border-0 transition-colors"
                style={{ borderColor: 'var(--border)', background: 'transparent' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                onMouseDown={e => { e.preventDefault(); onChooseSource(src); }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold tabular-nums shrink-0 w-5 h-5 flex items-center justify-center rounded-md" style={{ background: 'var(--accent-blue)', color: '#fff' }}>
                    {num ?? '?'}
                  </span>
                  <span className="text-[11px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{label}</span>
                </div>
                {src.type === 'api' && src.apiMeta?.title && (
                  <p className="text-[10px] truncate pl-7 mt-0.5" style={{ color: 'var(--text-muted)' }}>{src.apiMeta.title}</p>
                )}
              </button>
            );
          })}
        </div>
      )}
      <div className="px-3 py-1.5 border-t" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
        <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>Press Esc to close · Type a DOI (10.xxxx/…) to look up</p>
      </div>
    </div>,
    document.body,
  );
}
