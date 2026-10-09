import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Scissors, Sparkles, Wand2 } from 'lucide-react';
import type { AgentType } from '../../types';
import { SELECTION_PRESETS, type SelectionPreset } from '../shell/selectionPresets';
import { InstructForm, SynonymChips } from '../shell/aiPanels';
import { press } from './press';

/** Exactly what the floating bar needs of the AI actions; App.tsx fills it from the same handlers the top bar's AI menu gets. */
export interface SelectionAI {
  words: number;
  busy: boolean;
  thesaurus: { word: string; synonyms: string[]; loading: boolean } | null;
  onPreset: (p: SelectionPreset) => void;
  onRewrite: () => void;
  onInstruct: (text: string, agent: AgentType) => void;
  onSynonyms: () => void;
  onPickSynonym: (s: string) => void;
  onVerify: () => void;
  onSimilar: () => void;
}

const preset = (label: string): SelectionPreset => SELECTION_PRESETS.find(p => p.label === label)!;
const presetHint = (p: SelectionPreset) => (p.mode === 'transform' ? 'Creates an accept/reject suggestion' : 'Opens the answer in chat');

interface Item { id: string; label: string; hint?: string; disabled?: boolean; disabledReason?: string; keepOpen?: boolean; expanded?: boolean; panel?: ReactNode; onSelect: () => void; separatorBefore?: boolean }

const directClass = 'flex items-center gap-1 px-1.5 py-1 rounded text-[11px] font-medium whitespace-nowrap transition-colors hover:bg-stone-100';
const directStyle = { color: 'var(--text-secondary)' } as const;

/** Polish and Shorten, one click each: the two presets an author reaches for constantly. Written out (not mapped) so each button's test id is a literal the reachability guards can read. */
export function DirectPresets({ ai }: { ai: SelectionAI }) {
  const polish = preset('Polish'), shorten = preset('Shorten');
  return (
    <>
      <button type="button" data-testid="control-ai-polish" title="Polish the selection. Creates an accept/reject suggestion" {...press(() => ai.onPreset(polish))} className={directClass} style={directStyle}>
        <Wand2 size={12} />Polish
      </button>
      <button type="button" data-testid="control-ai-shorten" title="Shorten the selection. Creates an accept/reject suggestion" {...press(() => ai.onPreset(shorten))} className={directClass} style={directStyle}>
        <Scissors size={12} />Shorten
      </button>
    </>
  );
}

/** Everything else the top bar's AI menu does to a selection, grouped; same labels, hints and disabled reasons. */
export function AIMenu({ ai }: { ai: SelectionAI }) {
  const [open, setOpen] = useState(false);
  const [instructOpen, setInstructOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const { words } = ai;
  const pre = (label: string, separatorBefore = false): Item => {
    const p = preset(label);
    return { id: label.toLowerCase(), label: `${label} the selection`, hint: presetHint(p), onSelect: () => ai.onPreset(p), separatorBefore };
  };
  const items: Item[] = [
    { id: 'rewrite', label: 'Rewrite the selection', hint: 'Rewrite and get an accept/reject suggestion', onSelect: ai.onRewrite },
    pre('Sharpen', true), pre('Strengthen'),
    pre('Critique', true), pre('Explain'),
    { id: 'instruct', label: 'Give the selection a custom instruction…', keepOpen: true, expanded: instructOpen, separatorBefore: true, onSelect: () => setInstructOpen(o => !o),
      panel: <InstructForm onSend={(t, g) => { setInstructOpen(false); ai.onInstruct(t, g); }} /> },
    { id: 'synonyms', label: 'Find synonyms for the selection', hint: 'Alternatives for one or two selected words', keepOpen: true, disabled: words < 1 || words > 2,
      disabledReason: 'Select one or two words to look up alternatives', expanded: !!ai.thesaurus, onSelect: ai.onSynonyms,
      panel: ai.thesaurus ? <SynonymChips word={ai.thesaurus.word} synonyms={ai.thesaurus.synonyms} loading={ai.thesaurus.loading} onPick={ai.onPickSynonym} /> : null },
    { id: 'similar', label: 'Find manuscripts similar to the selection', hint: 'Search the literature for published papers like this passage', disabled: words <= 5,
      disabledReason: 'Select more than a few words (six or more) to search for similar manuscripts', onSelect: ai.onSimilar },
    { id: 'verify', label: 'Verify the selection against sources', hint: 'Check this claim against the uploaded PDF sources', onSelect: ai.onVerify },
  ];

  // Where the menu fits. Measured on open and on resize: `up` only when there is room above,
  // and the height is capped to whichever side it lands on so it can never run off-screen.
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{ up: boolean; maxH: number }>({ up: false, maxH: 400 });
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const t = root.current?.getBoundingClientRect();
      if (!t) return;
      const GAP = 12;
      const above = t.top - GAP;
      const below = window.innerHeight - t.bottom - GAP;
      const wanted = menuRef.current?.scrollHeight ?? 320;
      // Prefer up (away from the selection the bar sits on), but only if it actually fits
      // better there; otherwise take the roomier side.
      const up = above >= Math.min(wanted, below) && above > 120;
      setPlace({ up, maxH: Math.max(160, Math.floor(up ? above : below)) });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, instructOpen, ai.thesaurus]);

  return (
    <div ref={root} className="relative" onClick={e => { if ((e.target as HTMLElement).closest('[data-closes-menu]')) setOpen(false); }}>
      <button type="button" data-testid="control-ai-menu" aria-haspopup="menu" aria-expanded={open} title="More AI actions for the selection"
        {...press(() => setOpen(o => !o))}
        className="flex items-center gap-1 px-1.5 py-1 rounded text-[11px] font-semibold whitespace-nowrap transition-colors hover:bg-stone-100"
        style={{ color: 'var(--text-secondary)', background: open ? 'var(--surface-2)' : 'transparent' }}>
        <Sparkles size={12} />AI<ChevronDown size={11} className={ai.busy ? 'animate-pulse' : ''} />
      </button>
      {open && (
        /*
          Direction is measured, not fixed. The bar floats just above the selection, so dropping
          DOWN lands the menu on the sentence being acted on (measured: a 293px menu over a
          selection at y=195); but always opening UP runs it off the top of the window when the
          selection is near the first line (measured: y=-140). So: open up only when there is
          room up there, and cap the height to the space available either way.
        */
        <div ref={menuRef} role="menu" onMouseDown={e => { if (!(e.target as HTMLElement).closest('input,select,textarea')) e.preventDefault(); }}
        style={{ background: 'var(--surface-1)', borderColor: 'var(--border)', maxHeight: place.maxH }}
        className={`absolute right-0 border rounded-xl shadow-xl z-50 p-1.5 min-w-[260px] overflow-y-auto ${place.up ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
          {items.map(it => (
            <div key={it.id}>
              {it.separatorBefore && <div className="my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />}
              <button type="button" role="menuitem" data-testid={`control-ai-${it.id}`} disabled={it.disabled} title={it.disabled ? it.disabledReason : it.hint}
                aria-expanded={it.panel !== undefined ? !!it.expanded : undefined}
                {...press(() => { it.onSelect(); if (!it.keepOpen) setOpen(false); })}
                className="w-full text-left px-3 py-1.5 text-xs rounded-lg transition-colors hover:bg-stone-50 disabled:opacity-40 disabled:hover:bg-transparent" style={{ color: 'var(--text-primary)' }}>
                <span className="block font-medium truncate">{it.label}</span>
              </button>
              {it.expanded && it.panel && <div className="px-3 pb-2 pl-5">{it.panel}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
