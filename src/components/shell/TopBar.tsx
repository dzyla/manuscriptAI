import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, MoreHorizontal, Square } from 'lucide-react';
import type { SelectionKind } from '../editor/selectionKind';

/** One row of a top-bar menu. A leaf runs `onSelect`; an item with `children` or a `panel` expands in place while `expanded` (the caller owns that state). */
export interface MenuItem {
  id: string;
  /** Test id suffix when several items share one (`item-<testId>`); defaults to `id`. */
  testId?: string;
  label: string;
  /** What the item does, shown under the label and as its tooltip while enabled. */
  hint?: string;
  /** Receives the rectangle of the menu button, so a picker can open beneath it. */
  onSelect?: (anchor: DOMRect) => void;
  disabled?: boolean;
  /** Tooltip while disabled for a reason the menu cannot know (needs sources, needs 1-2 words, ...). */
  disabledReason?: string;
  /** AI menu only: usable with nothing selected. Every other AI item acts on the selection and is disabled without one. */
  anywhere?: boolean;
  checked?: boolean;
  /** Leave the menu open after selecting (a toggle, or an item that expands). */
  keepOpen?: boolean;
  /** Expandable items: shown under the item while `expanded` (the caller owns that state). */
  expanded?: boolean;
  children?: MenuItem[];
  panel?: ReactNode;
  danger?: boolean;
  separatorBefore?: boolean;
}

export interface TopBarItems { file: MenuItem[]; insert: MenuItem[]; ai: MenuItem[]; overflow: MenuItem[] }

const NEEDS_TEXT = 'Select some text in the document first';

function Row({ item, needsSelection, hasSelection, onPick }: { item: MenuItem; needsSelection: boolean; hasSelection: boolean; onPick: (item: MenuItem, el: HTMLElement) => void }) {
  const blocked = needsSelection && !item.anywhere && !hasSelection;
  const disabled = !!item.disabled || blocked;
  const title = disabled ? (blocked ? NEEDS_TEXT : item.disabledReason) : item.hint;
  return (
    <>
      {item.separatorBefore && <div className="my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />}
      <button
        type="button"
        role="menuitem"
        data-testid={`item-${item.testId ?? item.id}`}
        disabled={disabled}
        title={title}
        aria-checked={item.checked}
        aria-expanded={item.children || item.panel ? !!item.expanded : undefined}
        onClick={e => onPick(item, e.currentTarget)}
        className="w-full text-left px-3 py-1.5 text-xs rounded-lg flex items-center gap-2 transition-colors hover:bg-stone-50 disabled:opacity-40 disabled:hover:bg-transparent"
        style={{ color: item.danger ? '#e11d48' : 'var(--text-primary)' }}
      >
        <span className="w-3 shrink-0">{item.checked ? <Check size={12} /> : null}</span>
        <span className="flex-1 min-w-0">
          <span className="block font-medium truncate">{item.label}</span>
          {item.hint && <span className="block text-[10px] font-normal truncate" style={{ color: 'var(--text-muted)' }}>{item.hint}</span>}
        </span>
      </button>
      {item.expanded && item.panel && <div className="px-3 pb-2 pl-8">{item.panel}</div>}
      {item.expanded && item.children && item.children.length > 0 && (
        <div className="pl-5">
          {item.children.map(c => <Row key={c.id} item={c} needsSelection={needsSelection} hasSelection={hasSelection} onPick={onPick} />)}
        </div>
      )}
    </>
  );
}

function Menu({ id, label, icon, items, needsSelection = false, hasSelection = true, align = 'left', footer, busy }: {
  id: string; label?: string; icon?: ReactNode; items: MenuItem[]; needsSelection?: boolean; hasSelection?: boolean; align?: 'left' | 'right'; footer?: ReactNode; busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const pick = (item: MenuItem, el: HTMLElement) => {
    const anchor = (root.current?.querySelector('button') ?? el).getBoundingClientRect();
    item.onSelect?.(anchor);
    if (!item.keepOpen) setOpen(false);
  };
  return (
    <div ref={root} className="relative" onClick={e => { if ((e.target as HTMLElement).closest('[data-closes-menu]')) setOpen(false); }}>
      <button
        type="button"
        data-testid={`topbar-${id}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label ? undefined : 'More actions'}
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors hover:bg-stone-100"
        style={{ color: 'var(--text-secondary)', background: open ? 'var(--surface-2)' : 'transparent' }}
      >
        {icon}
        {label}
        {label && <ChevronDown size={11} className={busy ? 'animate-pulse' : ''} />}
      </button>
      {open && (
        <div role="menu" className={`absolute top-full mt-1 ${align === 'right' ? 'right-0' : 'left-0'} border rounded-xl shadow-xl z-50 p-1.5 min-w-[260px] max-h-[80vh] overflow-y-auto`} style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}>
          {items.map(it => <Row key={it.id} item={it} needsSelection={needsSelection} hasSelection={hasSelection} onPick={pick} />)}
          {footer}
        </div>
      )}
    </div>
  );
}

/**
 * The top bar: the document's name, the File / Insert / AI menus, a body-style selector and an overflow at rest; the selection-aware controls
 * (`children`) slot in after the menus when they apply. The AI menu's selection actions are disabled, with the reason as their tooltip, until text is selected.
 * Undo and redo live in the File menu (their keyboard bindings are unchanged).
 */
export function TopBar({ title, onTitleChange, onTitleBlur, selection, items, bodyStyle, children, trailing, busy = false, onStop, overflowFooter }: {
  title: string;
  onTitleChange: (t: string) => void;
  onTitleBlur?: () => void;
  selection: SelectionKind;
  items: TopBarItems;
  /** The at-rest body-style selector; hidden while text is selected, when the selection bar carries the fuller block-type control. */
  bodyStyle?: ReactNode;
  children?: ReactNode;
  /** Right-hand extras that are always present (version history). */
  trailing?: ReactNode;
  busy?: boolean;
  onStop?: () => void;
  overflowFooter?: ReactNode;
}) {
  return (
    <header className="h-12 flex items-center gap-2 px-3 shrink-0" style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-1)' }}>
      <input
        data-testid="topbar-title"
        value={title}
        onChange={e => onTitleChange(e.target.value)}
        onBlur={onTitleBlur}
        aria-label="Document name"
        placeholder="Untitled Manuscript"
        className="text-sm font-semibold tracking-tight bg-transparent focus:outline-none focus:ring-1 rounded px-1.5 py-0.5 min-w-0 w-48 shrink"
        style={{ color: 'var(--text-primary)' }}
      />
      <Menu id="file" label="File" items={items.file} />
      <Menu id="insert" label="Insert" items={items.insert} />
      <Menu id="ai" label="AI" items={items.ai} needsSelection hasSelection={selection === 'text'} busy={busy} />
      {selection !== 'text' && bodyStyle}
      {children}
      <div className="flex-1" />
      {busy && onStop && (
        <button type="button" data-testid="topbar-stop" onClick={onStop} title="Stop the running request"
          className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 text-white rounded-lg text-xs font-semibold hover:bg-rose-700 transition-colors">
          <Square size={11} className="fill-white" />Stop
        </button>
      )}
      {trailing}
      <Menu id="overflow" icon={<MoreHorizontal size={16} />} items={items.overflow} align="right" footer={overflowFooter} />
    </header>
  );
}
