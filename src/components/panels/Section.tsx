import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

/**
 * A collapsible section, shared by the four panels. The prop is `label`, not `title`: a `title` would be read as an HTML attribute by the reachability contract's guard.
 * `keepMounted` (default true) hides a collapsed body with CSS so its state survives: a query and its results, a half-typed value, an expanded change.
 * Pass false only where unmounting is intended (the Review panel's chat and style sections, whose state lives in the host or is cheap to rebuild).
 * `flat` is the Review panel's ruled look (a top border, no card); the default is the card the other panels use.
 */
export function Section({ id, label, count, icon, open, onToggle, children, keepMounted = true, flat = false }: {
  id: string; label: string; count?: number; icon: ReactNode; open: boolean; onToggle: () => void; children: ReactNode; keepMounted?: boolean; flat?: boolean;
}) {
  return (
    <div className={flat ? undefined : 'border rounded-xl overflow-hidden'} style={flat ? { borderTop: '1px solid var(--border)' } : { borderColor: 'var(--border)' }}>
      <button
        data-testid={`section-${id}`}
        aria-expanded={open}
        onClick={onToggle}
        className={`w-full flex items-center gap-2 text-xs font-semibold hover:bg-stone-50 transition-colors ${flat ? 'px-4 py-3' : 'px-3 py-2.5'}`}
        style={flat ? { color: 'var(--text-primary)' } : { color: 'var(--text-primary)', background: 'var(--surface-1)' }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {icon}
        {label}
        {count !== undefined && count > 0 && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>{count}</span>
        )}
      </button>
      {keepMounted
        ? <div className={flat ? undefined : 'p-3'} style={open ? undefined : { display: 'none' }}>{children}</div>
        : open && <div className={flat ? undefined : 'p-3'}>{children}</div>}
    </div>
  );
}
