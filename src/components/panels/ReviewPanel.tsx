import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BookOpen, Check, CheckCheck, ChevronDown, Filter, MessageSquare, PenLine, Sparkles, Square, X, XCircle } from 'lucide-react';
import type { AgentType, SuggestionSeverity } from '../../types';
import type { ReviewAction, ReviewRow } from './reviewRows';
import { SEVERITY_CONFIG } from './suggestionParts';
import { Section } from './Section';

/** Rows drawn at once. A long list stays responsive because only this many exist in the DOM; the badge and the header count the whole list. */
export const PAGE = 100;

const KIND_LABEL = { suggestion: 'Suggestion', style: 'Style', grammar: 'Grammar' } as const;

/** The control a row's action is, by test id and visible label. An advisory flag never replaces text, so its "accept" inserts a note and its "reject" dismisses it. */
function actionMeta(row: ReviewRow, action: ReviewAction): { id: string; label: string; primary: boolean } {
  if (action === 'rewrite') return { id: 'rewrite', label: 'Rewrite in my voice', primary: false };
  if (action === 'accept') return row.advisory ? { id: 'insert-note', label: 'Insert note', primary: true } : { id: 'accept', label: 'Accept', primary: true };
  return row.advisory ? { id: 'dismiss', label: 'Dismiss', primary: false } : { id: 'reject', label: 'Reject', primary: false };
}

export interface ReviewPanelProps {
  rows: ReviewRow[];
  onAct: (rowId: string, action: ReviewAction) => void;
  /** Scroll the editor to a span (plain-text offsets). */
  onGoTo: (start: number, end: number) => void;
  /** Replaces onGoTo when a kind needs its own way to find its text (a suggestion is located by what it quotes, not by offset). */
  onLocate?: (row: ReviewRow) => void;
  chat: ReactNode;
  analyzing: boolean;
  /** Run every agent, or one named agent. */
  onAnalyze: (agent?: AgentType) => void;
  onStop?: () => void;
  onSummary?: () => void;
  agents?: { id: AgentType; label: string }[];
  onAcceptAll?: () => void;
  onRejectAll?: () => void;
  /** Body shown between a row's evidence and its buttons, and below its buttons. */
  renderDetail?: (row: ReviewRow) => ReactNode;
  renderFooter?: (row: ReviewRow) => ReactNode;
  /** The style comparison (score, table, voice profile), collapsed until asked for. */
  styleSection?: ReactNode;
  highlightedRowId?: string | null;
  progress?: string;
  chatOpen?: boolean;
  onChatOpenChange?: (open: boolean) => void;
  zoom?: number;
  /** Changes when the document is replaced wholesale; the panel starts over (page, filter, open boxes) rather than point at the old text. */
  docKey?: string;
}

export function ReviewPanel(p: ReviewPanelProps) {
  const { rows, onAct, onGoTo, onLocate, analyzing, agents = [] } = p;
  const [showAgents, setShowAgents] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [severity, setSeverity] = useState<SuggestionSeverity | 'all'>('all');
  const [shown, setShown] = useState(PAGE);
  const [styleOpen, setStyleOpen] = useState(false);
  const [chatLocal, setChatLocal] = useState(false);
  const chatOpen = p.chatOpen ?? chatLocal;
  const setChatOpen = (open: boolean) => { setChatLocal(open); p.onChatOpenChange?.(open); };
  const rowEls = useRef<Record<string, HTMLDivElement | null>>({});

  // A severity belongs to a suggestion; style and grammar rows have none, so any filter other than "all" leaves them out.
  const visible = severity === 'all' ? rows : rows.filter(r => r.severity === severity);
  const suggestionRows = rows.filter(r => r.kind === 'suggestion');
  const counts = { critical: 0, major: 0, minor: 0, style: 0 };
  for (const r of suggestionRows) if (r.severity) counts[r.severity]++;

  // The editor asked for a particular row (a highlighted passage was clicked): make sure it is drawn, then bring it into view.
  const highlightIndex = p.highlightedRowId ? visible.findIndex(r => r.id === p.highlightedRowId) : -1;
  useEffect(() => { if (highlightIndex >= shown) setShown(highlightIndex + 1); }, [highlightIndex, shown]);
  useEffect(() => {
    if (!p.highlightedRowId) return;
    const el = rowEls.current[p.highlightedRowId];
    const t = setTimeout(() => el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }), 300);
    return () => clearTimeout(t);
  }, [p.highlightedRowId, shown]);

  const locate = (r: ReviewRow) => (onLocate ? onLocate(r) : onGoTo(r.start, r.end));
  const drawn = visible.slice(0, shown);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto" style={{ fontSize: `${p.zoom ?? 100}%` }}>
      <div className="p-4 space-y-3">
        {analyzing && (
          <div>
            <div className="progress-bar rounded-full" />
            <div className="flex items-center gap-2 mt-1.5">
              <Sparkles size={10} className="animate-spin" style={{ color: 'var(--accent-blue)' }} />
              <span className="text-[10px] font-medium" style={{ color: 'var(--text-tertiary)' }}>{p.progress ?? 'AI agents analyzing in parallel...'}</span>
            </div>
          </div>
        )}

        <div className="relative flex flex-wrap items-center gap-1.5">
          {analyzing ? (
            <button data-testid="control-stop" onClick={p.onStop} className="flex items-center gap-2 px-3 py-2 bg-rose-600 text-white rounded-lg text-xs font-semibold hover:bg-rose-700 transition-all shadow-sm">
              <Square size={12} className="fill-white" />
              <span>Stop</span>
            </button>
          ) : (
            <div className="flex">
              <button data-testid="control-analyze" onClick={() => p.onAnalyze(undefined)} className="flex items-center gap-2 px-3 py-2 bg-stone-900 text-white rounded-l-lg text-xs font-semibold hover:bg-stone-800 transition-all shadow-sm">
                <Sparkles size={14} />
                <span>Analyze</span>
              </button>
              <button data-testid="control-analyze-agent" title="Run one agent" aria-expanded={showAgents} onClick={() => setShowAgents(v => !v)} className="px-2 py-2 bg-stone-900 text-white rounded-r-lg text-xs hover:bg-stone-800 transition-all shadow-sm border-l border-stone-700">
                <ChevronDown size={12} />
              </button>
            </div>
          )}
          {p.onSummary && (
            <button
              data-testid="control-summary"
              onClick={p.onSummary}
              disabled={analyzing}
              className="flex items-center gap-1.5 px-3 py-2 border rounded-lg text-xs font-semibold transition-all disabled:opacity-40 hover:bg-stone-50"
              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
              title="Summarize the manuscript: strengths, gaps, and recommendations"
            >
              <BookOpen size={14} />
              <span>Summary & Gaps</span>
            </button>
          )}
          {showAgents && !analyzing && (
            <div className="absolute left-0 top-full mt-1 border rounded-xl shadow-xl z-50 p-1.5 min-w-[220px]" style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}>
              <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Run one agent</div>
              {agents.map(a => (
                <button key={a.id} data-testid="control-analyze-agent-one" onClick={() => { setShowAgents(false); p.onAnalyze(a.id); }} className="w-full text-left px-3 py-2 text-xs rounded-lg font-medium transition-colors hover:bg-stone-50" style={{ color: 'var(--text-secondary)' }}>
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>{rows.length} {rows.length === 1 ? 'item' : 'items'}</span>
            {suggestionRows.length > 0 && p.onAcceptAll && (
              <button data-testid="control-accept-all" onClick={p.onAcceptAll} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-semibold transition-colors bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200">
                <CheckCheck size={12} /> Accept All
              </button>
            )}
            {suggestionRows.length > 0 && p.onRejectAll && (
              <button data-testid="control-reject-all" onClick={p.onRejectAll} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-semibold transition-colors bg-rose-50 text-rose-600 hover:bg-rose-100 border border-rose-200">
                <XCircle size={12} /> Clear All
              </button>
            )}
          </div>
          {suggestionRows.length > 0 && (
            <button data-testid="control-filter" aria-label="Filter by severity" aria-expanded={showFilters} onClick={() => setShowFilters(v => !v)} className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-semibold transition-colors hover:bg-stone-100" style={{ color: 'var(--text-tertiary)' }}>
              <Filter size={12} />
            </button>
          )}
        </div>

        {showFilters && suggestionRows.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            <button data-testid="control-filter-all" onClick={() => { setSeverity('all'); setShown(PAGE); }} className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-colors border ${severity === 'all' ? 'bg-stone-800 text-white border-stone-800' : 'border-stone-200 text-stone-500 hover:bg-stone-50'}`}>
              All ({rows.length})
            </button>
            {(Object.entries(SEVERITY_CONFIG) as [SuggestionSeverity, (typeof SEVERITY_CONFIG)[SuggestionSeverity]][]).map(([key, cfg]) => counts[key] > 0 && (
              <button key={key} data-testid="control-filter-severity" data-severity={key} onClick={() => { setSeverity(key); setShown(PAGE); }} className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold transition-colors border ${severity === key ? 'bg-stone-800 text-white border-stone-800' : 'border-stone-200 hover:bg-stone-50'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${cfg.dotColor}`} />
                {cfg.label} ({counts[key]})
              </button>
            ))}
          </div>
        )}

        {visible.length === 0 ? (
          <div className="text-center py-10" style={{ color: 'var(--text-muted)' }}>
            <Sparkles size={32} className="mx-auto mb-3 opacity-15" />
            <p className="text-sm font-medium mb-1">Nothing flagged yet</p>
            <p className="text-xs">Analyze the manuscript, or keep writing: sentences that read as machine-written appear here as you type.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {drawn.map(r => (
              <div
                key={r.id}
                ref={el => { rowEls.current[r.id] = el; }}
                data-testid={`row-${r.kind}`}
                data-row-id={r.id}
                onClick={() => locate(r)}
                className={`border rounded-xl p-3 space-y-2 cursor-pointer ${p.highlightedRowId === r.id ? 'ring-2 ring-stone-800/15 border-stone-400' : ''}`}
                style={{ borderColor: p.highlightedRowId === r.id ? undefined : 'var(--border)', background: 'var(--surface-1)' }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[9px] uppercase font-bold tracking-widest" style={{ color: 'var(--text-muted)' }}>{KIND_LABEL[r.kind]}</span>
                  {r.title !== r.evidence && r.kind !== 'suggestion' && <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{r.title}</span>}
                </div>
                <div data-testid={r.kind === 'style' ? 'control-goto' : 'control-locate'} className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{r.evidence}</div>
                {r.note && <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{r.note}</div>}
                {p.renderDetail?.(r)}
                <div className="flex gap-2 pt-1">
                  {r.actions.map(a => {
                    const m = actionMeta(r, a);
                    // Reject only edits the list, so a row whose text has gone can still be cleared; accept and rewrite touch the document and need a live anchor.
                    // The test ids below are written out, not templated: the reachability guard reads them from the source and cannot see a computed one.
                    const disabled = a !== 'reject' && !r.canAct;
                    return (
                      <button
                        key={a}
                        data-testid={m.id === 'rewrite' ? 'control-rewrite' : m.id === 'insert-note' ? 'control-insert-note' : m.id === 'accept' ? 'control-accept' : m.id === 'dismiss' ? 'control-dismiss' : 'control-reject'}
                        disabled={disabled}
                        onClick={e => { e.stopPropagation(); onAct(r.id, a); }}
                        className={m.primary
                          ? 'flex-1 py-2 bg-stone-800 text-white rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1.5 hover:bg-stone-700 transition-colors shadow-sm disabled:opacity-40'
                          : 'flex-1 py-2 border rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1.5 hover:bg-stone-50 transition-colors disabled:opacity-40'}
                        style={m.primary ? undefined : { borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                      >
                        {a === 'accept' && (r.advisory ? <MessageSquare size={12} /> : <Check size={12} />)}
                        {a === 'reject' && <X size={12} />}
                        {a === 'rewrite' && <PenLine size={12} />}
                        {m.label}
                      </button>
                    );
                  })}
                </div>
                {p.renderFooter?.(r)}
              </div>
            ))}
            {visible.length > shown && (
              <button data-testid="control-show-more" onClick={() => setShown(n => n + PAGE)} className="w-full py-2 border rounded-lg text-[11px] font-semibold hover:bg-stone-50" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
                Show {Math.min(PAGE, visible.length - shown)} more ({visible.length - shown} not shown)
              </button>
            )}
          </div>
        )}
      </div>

      {/* Kept mounted: the voice-profile form inside holds a paste of the author's own writing, which a collapse must not discard. (Chat unmounts safely: its composer lives in the host.) */}
      {p.styleSection !== undefined && (
        <Section flat id="style" label="Style comparison" icon={<PenLine size={13} />} open={styleOpen} onToggle={() => setStyleOpen(v => !v)}>
          <div className="px-4 pb-4">{p.styleSection}</div>
        </Section>
      )}
      <Section flat keepMounted={false} id="chat" label="Chat" icon={<MessageSquare size={13} />} open={chatOpen} onToggle={() => setChatOpen(!chatOpen)}>
        {p.chat}
      </Section>
    </div>
  );
}
