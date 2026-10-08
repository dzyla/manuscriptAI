import { useState } from 'react';
import { ArrowRight, MessageSquare } from 'lucide-react';
import type { Suggestion } from '../../types';
import { AGENT_INFO } from '../../services/ai';
import { AgentIcon, CategoryBadge, DiffView, SEVERITY_CONFIG } from './suggestionParts';

/** What a suggestion row shows between its explanation and its buttons: who said it, how serious, and the change itself. */
export function SuggestionDetail({ s }: { s: Suggestion }) {
  const severity = SEVERITY_CONFIG[s.severity || 'minor'];
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AgentIcon agent={s.agent} size={11} />
          <span className={`text-[9px] uppercase font-bold tracking-widest px-2 py-0.5 rounded-md ${AGENT_INFO[s.agent]?.color ?? 'bg-stone-500'} text-white`}>
            {AGENT_INFO[s.agent]?.label ?? s.agent}
          </span>
          <CategoryBadge category={s.category} />
        </div>
        <div className="flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${severity.dotColor}`} />
          <span className={`text-[9px] font-bold uppercase tracking-wider ${severity.color}`}>{severity.label}</span>
        </div>
      </div>
      {s.kind === 'advisory' ? (
        <div className="space-y-1.5">
          <div className="text-[11px] leading-relaxed px-2 py-1.5 rounded italic" style={{ background: 'var(--surface-2)', color: 'var(--text-tertiary)' }}>
            "{s.originalText.length > 180 ? s.originalText.slice(0, 180) + '…' : s.originalText}"
          </div>
          {s.recommendation && (
            <p className="text-[11px] leading-relaxed font-medium flex gap-1.5" style={{ color: '#b45309' }}>
              <ArrowRight size={12} className="mt-0.5 shrink-0" />
              <span>{s.recommendation}</span>
            </p>
          )}
        </div>
      ) : (
        <DiffView original={s.originalText} suggested={s.suggestedText} />
      )}
      {s.section && s.section !== 'General' && (
        <span className="inline-block text-[9px] px-1.5 py-0.5 rounded border font-medium" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-tertiary)' }}>
          {s.section}
        </span>
      )}
    </div>
  );
}

/** "Disagree? Reply to this suggestion..." and the box it opens. Its draft is local: a row that scrolls out of view keeps nothing. */
export function RebuttalBox({ suggestionId, busy, onRebuttal }: { suggestionId: string; busy: boolean; onRebuttal: (id: string, feedback: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const send = () => { onRebuttal(suggestionId, text); setText(''); setOpen(false); };
  return (
    <div className="pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }} onClick={e => e.stopPropagation()}>
      {open ? (
        <div className="space-y-2">
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Explain why you disagree with this suggestion..."
            className="w-full px-3 py-2 border rounded-lg text-[11px] focus:outline-none focus:ring-1 focus:ring-stone-400 resize-none min-h-[60px]"
            style={{ background: 'var(--surface-2)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && text.trim()) { e.preventDefault(); send(); } }}
          />
          <div className="flex gap-1.5">
            <button
              data-testid="control-send-rebuttal"
              disabled={!text.trim() || busy}
              onClick={send}
              className="px-3 py-1.5 bg-stone-800 text-white rounded-lg text-[10px] font-bold disabled:opacity-40 hover:bg-stone-700 transition-colors"
            >
              Send Rebuttal
            </button>
            <button
              data-testid="control-cancel-rebuttal"
              onClick={() => setOpen(false)}
              className="px-3 py-1.5 rounded-lg text-[10px] font-medium hover:bg-stone-50 transition-colors"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          data-testid="control-rebut"
          onClick={() => setOpen(true)}
          className="text-[10px] font-medium transition-colors hover:underline flex items-center gap-1"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <MessageSquare size={10} /> Disagree? Reply to this suggestion...
        </button>
      )}
    </div>
  );
}
