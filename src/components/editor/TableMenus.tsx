import type { Editor } from '@tiptap/core';

/** Grid picker for a new table. `position: fixed` so overflow clipping cannot cut it off. Mouse-down on a cell inserts that size. */
export function TablePicker({ pos, hover, onHover, onPick }: {
  pos: { x: number; y: number };
  hover: { rows: number; cols: number };
  onHover: (h: { rows: number; cols: number }) => void;
  onPick: (rows: number, cols: number) => void;
}) {
  const cells = [];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      const highlighted = r < hover.rows && c < hover.cols;
      cells.push(
        <div
          key={`${r}-${c}`}
          onMouseEnter={() => onHover({ rows: r + 1, cols: c + 1 })}
          onMouseLeave={() => onHover({ rows: 0, cols: 0 })}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onPick(r + 1, c + 1); }}
          style={{
            width: 20, height: 20, borderRadius: 2, cursor: 'pointer',
            border: `1px solid ${highlighted ? 'var(--accent-blue)' : 'var(--border)'}`,
            background: highlighted ? 'rgba(59,111,212,0.2)' : 'var(--surface-2)',
          }}
        />,
      );
    }
  }
  return (
    <div
      id="table-picker-portal"
      className="rounded-lg shadow-xl p-2.5"
      style={{ position: 'fixed', zIndex: 9999, left: pos.x, top: pos.y, background: 'var(--surface-1)', border: '1px solid var(--border)' }}
      onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
    >
      <p className="text-[9px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-muted)' }}>
        {hover.rows > 0 ? `${hover.rows} × ${hover.cols} table` : 'Insert table'}
      </p>
      <div style={{ display: 'grid', gap: '4px', gridTemplateColumns: 'repeat(6, 20px)' }}>{cells}</div>
    </div>
  );
}

const ITEMS: ({ label: string; icon: string; cmd: (e: Editor) => void; danger: boolean } | null)[] = [
  { label: 'Add column before', icon: '←', cmd: e => e.chain().focus().addColumnBefore().run(), danger: false },
  { label: 'Add column after', icon: '→', cmd: e => e.chain().focus().addColumnAfter().run(), danger: false },
  { label: 'Add row above', icon: '↑', cmd: e => e.chain().focus().addRowBefore().run(), danger: false },
  { label: 'Add row below', icon: '↓', cmd: e => e.chain().focus().addRowAfter().run(), danger: false },
  null,
  { label: 'Delete column', icon: '×', cmd: e => e.chain().focus().deleteColumn().run(), danger: true },
  { label: 'Delete row', icon: '×', cmd: e => e.chain().focus().deleteRow().run(), danger: true },
  { label: 'Delete table', icon: '⊠', cmd: e => e.chain().focus().deleteTable().run(), danger: true },
];

/** Right-click menu for a table cell: the same row and column commands the top bar offers while a table is selected. */
export function TableContextMenu({ editor, pos, onDone }: { editor: Editor; pos: { x: number; y: number }; onDone: () => void }) {
  return (
    <div
      id="table-context-menu"
      style={{ position: 'fixed', zIndex: 9999, left: pos.x, top: pos.y, background: 'var(--surface-1)', border: '1.5px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', minWidth: 160, overflow: 'hidden' }}
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
        <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Table</span>
      </div>
      {ITEMS.map((item, i) => item === null
        ? <div key={i} className="border-t my-0.5" style={{ borderColor: 'var(--border)' }} />
        : (
          <button
            key={item.label}
            onMouseDown={e => { e.preventDefault(); item.cmd(editor); onDone(); }}
            className="w-full text-left flex items-center gap-2.5 px-3 py-1.5 text-[12px] transition-colors"
            style={{ color: item.danger ? '#e11d48' : 'var(--text-primary)', background: 'transparent' }}
            onMouseEnter={e => (e.currentTarget.style.background = item.danger ? 'rgba(225,29,72,0.08)' : 'var(--surface-2)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <span className="w-4 text-center font-bold shrink-0" style={{ color: item.danger ? '#e11d48' : 'var(--accent-blue)', fontSize: 13 }}>{item.icon}</span>
            {item.label}
          </button>
        ))}
    </div>
  );
}
