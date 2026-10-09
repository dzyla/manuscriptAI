import { Pencil, Quote, CircleDot, Pilcrow } from 'lucide-react';

export type RailTask = 'write' | 'cite' | 'review' | 'format';
export interface RailBadges { write?: number; cite?: number; review?: number; format?: number }

const TASKS: { key: RailTask; label: string; hint: string; Icon: typeof Pencil }[] = [
  { key: 'write',  label: 'Write',  hint: 'Outline, history and versions',        Icon: Pencil },
  { key: 'cite',   label: 'Cite',   hint: 'Sources, search and references',       Icon: Quote },
  { key: 'review', label: 'Review', hint: 'Suggestions, style and chat',          Icon: CircleDot },
  { key: 'format', label: 'Format', hint: 'Styles, page setup and grant template', Icon: Pilcrow },
];

/**
 * One panel is open at a time. Selecting the active task again is how the user
 * closes the panel, so `onSelect` fires for it too and the caller decides.
 */
export function Rail({ active, badges, onSelect }: {
  active: RailTask | null;
  badges: RailBadges;
  onSelect: (t: RailTask) => void;
}) {
  return (
    <nav className="u-rail" aria-label="Tasks">
      {TASKS.map(({ key, label, hint, Icon }) => {
        const count = badges[key];
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active === key}
            aria-label={`${label} — ${hint}`}
            title={`${label} — ${hint}`}
            className={active === key ? 'u-rail-btn is-active' : 'u-rail-btn'}
            onClick={() => onSelect(key)}
          >
            <Icon size={16} />
            {count ? <span className="u-rail-badge" data-testid={`badge-${key}`}>{count > 99 ? '99+' : count}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
