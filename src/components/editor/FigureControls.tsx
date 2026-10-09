import { useRef, useState } from 'react';
import { Eye, FlaskConical, MessageSquare, Send, ShieldCheck, Trash2 } from 'lucide-react';

export type FigureAlign = 'left' | 'center' | 'right';

const SIZES = [['S', '25%'], ['M', '50%'], ['L', '75%'], ['Full', '100%']] as const;
const ALIGN_GLYPH: Record<FigureAlign, string> = { left: '◧', center: '▣', right: '◨' };

/**
 * The controls that float on a selected figure: layout (align, size, delete) and the four figure-AI questions
 * (describe, check quality, review relevance, ask). They exist only while a figure is selected, so they never take room in the top bar.
 * The caller supplies what each does; the question box and its text are this component's own state.
 */
export function FigureControls({ onDescribe, onQuality, onRelevance, onAsk, onDelete, align, onAlign, onSize, context }: {
  onDescribe: () => void;
  onQuality?: () => void;
  onRelevance: () => void;
  /** Called with the author's question when it is sent (Enter or the send button). Never called with an empty question. */
  onAsk: (question: string) => void;
  onDelete: () => void;
  align?: FigureAlign | null;
  onAlign?: (a: FigureAlign) => void;
  onSize?: (width: string) => void;
  /** The text around the figure that the AI is given; shown so the author can see what the question will include. */
  context?: string;
}) {
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const input = useRef<HTMLInputElement>(null);
  // Mouse-down is swallowed so the editor keeps its selection (the figure stays selected while a control is used); the action runs on click.
  const press = (fn: () => void) => ({ onMouseDown: (e: React.MouseEvent) => e.preventDefault(), onClick: fn });
  const send = () => {
    const q = question.trim();
    if (!q) return;
    onAsk(q);
    setAsking(false);
    setQuestion('');
  };
  const ai = 'px-2 py-1 rounded text-[10px] hover:bg-stone-700 transition-colors flex items-center gap-1';
  return (
    <div className="bg-stone-900 text-white rounded-xl shadow-2xl border border-stone-700 overflow-hidden" style={{ maxWidth: '520px' }}>
      <div className="flex items-center gap-0.5 p-1.5 border-b border-stone-700 flex-wrap">
        <span className="text-[9px] uppercase tracking-widest text-stone-500 px-1">Align</span>
        {(['left', 'center', 'right'] as const).map(a => (
          <button key={a} data-testid="control-align-figure" {...press(() => onAlign?.(a))} title={`Align ${a}`} disabled={!onAlign}
            className={`px-2 py-1 rounded text-[10px] transition-colors ${align === a ? 'bg-stone-600' : 'hover:bg-stone-700'}`}>
            {ALIGN_GLYPH[a]}
          </button>
        ))}
        <div className="w-px h-4 bg-stone-700 mx-1 shrink-0" />
        <span className="text-[9px] uppercase tracking-widest text-stone-500 px-1">Size</span>
        {SIZES.map(([label, w]) => (
          <button key={label} data-testid="control-size-figure" {...press(() => onSize?.(w))} title={`Set width to ${w}`} disabled={!onSize}
            className="px-2 py-1 rounded text-[10px] hover:bg-stone-700 transition-colors">
            {label}
          </button>
        ))}
        <div className="w-px h-4 bg-stone-700 mx-1 shrink-0" />
        <button data-testid="control-delete-figure" {...press(onDelete)} title="Delete figure" className="px-2 py-1 rounded text-[10px] hover:bg-rose-700 transition-colors text-rose-400">
          <Trash2 size={11} />
        </button>
      </div>
      <div className="flex items-center gap-0.5 p-1.5 flex-wrap">
        <span className="text-[9px] uppercase tracking-widest text-stone-500 px-1 shrink-0">Figure AI</span>
        <button data-testid="control-describe" {...press(onDescribe)} className={`${ai} text-sky-400`} title="Visual description of what is seen in the figure">
          <Eye size={11} />Describe
        </button>
        <button data-testid="control-quality" {...press(() => onQuality?.())} disabled={!onQuality} className={`${ai} text-emerald-400`} title="Check figure quality, spelling, colors, readability">
          <ShieldCheck size={11} />Integrity
        </button>
        <button data-testid="control-relevance" {...press(onRelevance)} className={`${ai} text-amber-400`} title="Review figure relevance and clarity in context of manuscript">
          <FlaskConical size={11} />Review
        </button>
        <button data-testid="control-ask" {...press(() => { setAsking(v => !v); setQuestion(''); setTimeout(() => input.current?.focus(), 50); })}
          className={`${ai} text-violet-400 ${asking ? 'bg-stone-700' : ''}`} title="Ask a custom question about this figure">
          <MessageSquare size={11} />Ask
        </button>
      </div>
      {asking && (
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          <input ref={input} data-testid="control-ask-text" value={question} onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); send(); }
              else if (e.key === 'Escape') { setAsking(false); setQuestion(''); }
            }}
            placeholder="Ask about this figure… (Enter to send)"
            className="flex-1 bg-stone-800 text-white text-[11px] rounded px-2 py-1 border border-stone-600 focus:outline-none focus:border-stone-400 placeholder-stone-500 min-w-[200px]" />
          <button data-testid="control-ask-send" {...press(send)} disabled={!question.trim()} title="Send question" className="p-1.5 rounded bg-violet-600 hover:bg-violet-500 transition-colors disabled:opacity-40">
            <Send size={11} />
          </button>
        </div>
      )}
      {context ? (
        <div className="px-2 pb-1.5">
          <p className="text-[9px] text-stone-500">Context: "{context.substring(0, 70)}{context.length > 70 ? '…' : ''}"</p>
        </div>
      ) : null}
    </div>
  );
}
