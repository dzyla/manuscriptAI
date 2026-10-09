import { useRef, useState } from 'react';
import { Send } from 'lucide-react';
import type { AgentType } from '../../types';

const field = 'text-[11px] rounded px-2 py-1 border focus:outline-none';
const fieldStyle = { background: 'var(--surface-1)', borderColor: 'var(--border)', color: 'var(--text-primary)' } as const;

/**
 * The custom-instruction form inside the AI menu: which agent, what to ask, send. Enter sends only a non-empty instruction; the button with an
 * empty box sends the stock request. Whatever sends closes the menu (`data-closes-menu`).
 */
export function InstructForm({ onSend }: { onSend: (instruction: string, agent: AgentType) => void }) {
  const [agent, setAgent] = useState<AgentType>('editor');
  const [text, setText] = useState('');
  const send = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <select data-testid="item-instruct-agent" aria-label="Agent" value={agent} onChange={e => setAgent(e.target.value as AgentType)} className={field} style={fieldStyle}>
        <option value="editor">Language Surgeon</option>
        <option value="reviewer-2">Reviewer 2</option>
        <option value="researcher">Clarity & Impact</option>
        <option value="manager">Structure</option>
      </select>
      <div className="flex items-center gap-1">
        <input
          data-testid="item-instruct-text"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && text.trim()) send.current?.click(); }}
          placeholder="e.g. Make this more concise..."
          aria-label="Instruction"
          className={`${field} flex-1 min-w-[160px]`}
          style={fieldStyle}
        />
        <button ref={send} type="button" data-testid="item-instruct-send" data-closes-menu title="Send the instruction" onClick={() => onSend(text.trim() || 'Suggest improvements for this text.', agent)}
          className="p-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors">
          <Send size={12} />
        </button>
      </div>
    </div>
  );
}

/** The synonym lookup's answer: a chip per alternative; choosing one replaces the selected word and closes the menu. */
export function SynonymChips({ word, synonyms, loading, onPick }: { word: string; synonyms: string[]; loading: boolean; onPick: (s: string) => void }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-widest mb-1.5" style={{ color: 'var(--text-muted)' }}>Synonyms for "{word}"</div>
      {loading ? (
        <span className="text-[11px] animate-pulse" style={{ color: 'var(--text-muted)' }}>Looking up...</span>
      ) : synonyms.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {synonyms.map(s => (
            <button key={s} type="button" data-testid="item-synonym-choice" data-closes-menu onClick={() => onPick(s)} className="px-2 py-0.5 rounded text-[11px] font-medium border hover:bg-stone-50 transition-colors" style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}>
              {s}
            </button>
          ))}
        </div>
      ) : (
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>No synonyms found</span>
      )}
    </div>
  );
}
