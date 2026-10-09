import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { Bold, Italic, Underline as UnderlineIcon } from 'lucide-react';
import type { DocFormat } from '../../types';
import type { SelectionKind } from './selectionKind';
import { DirectPresets, AIMenu, type SelectionAI } from './SelectionAIMenu';
import { press } from './press';
import { alignOf, applyBlock, blockOf, blockOptions, type AlignId, type BlockId } from './blocks';

export type { SelectionKind } from './selectionKind';

const ALIGNS: { id: AlignId; label: string }[] = [
  { id: 'left', label: 'Align left' }, { id: 'center', label: 'Center' }, { id: 'right', label: 'Align right' }, { id: 'justify', label: 'Justify' },
];

const TABLE_CONTROLS: { id: string; label: string; run: (e: Editor) => void; danger?: boolean }[] = [
  { id: 'row-above', label: 'Row above', run: e => e.chain().focus().addRowBefore().run() },
  { id: 'row-below', label: 'Row below', run: e => e.chain().focus().addRowAfter().run() },
  { id: 'col-before', label: 'Column before', run: e => e.chain().focus().addColumnBefore().run() },
  { id: 'col-after', label: 'Column after', run: e => e.chain().focus().addColumnAfter().run() },
  { id: 'delete-row', label: 'Delete row', run: e => e.chain().focus().deleteRow().run(), danger: true },
  { id: 'delete-column', label: 'Delete column', run: e => e.chain().focus().deleteColumn().run(), danger: true },
  { id: 'delete-table', label: 'Delete table', run: e => e.chain().focus().deleteTable().run(), danger: true },
];

const Divider = () => <div role="separator" aria-orientation="vertical" className="self-stretch w-px mx-0.5" style={{ background: 'var(--border)' }} />;

const IDLE = { bold: false, italic: false, underline: false, block: 'normal' as BlockId, align: 'left' as AlignId };

/**
 * Block type under the cursor. Shared by the selection bar and the top bar's at-rest "body style" selector (same control, different slot),
 * so the two can never disagree about what the current block is.
 */
export function BlockTypeSelect({ editor, format, testId = 'control-block-type', className = '' }: { editor: Editor | null; format?: DocFormat | null; testId?: string; className?: string }) {
  const block = useEditorState({ editor, selector: ({ editor: e }) => (e && !e.isDestroyed ? blockOf(e) : 'normal') });
  return (
    <select data-testid={testId} aria-label="Block type" value={block} disabled={!editor}
      onChange={e => { if (editor) applyBlock(editor, e.target.value as BlockId); }}
      className={`text-xs rounded border px-1.5 py-1 ${className}`} style={{ background: 'var(--surface-1)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}>
      {blockOptions(format).map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

/**
 * The part of the top bar that depends on what is selected. Nothing is drawn with no selection or a figure selected (a figure's controls float
 * on the figure itself); text shows inline marks, block type and alignment; a table shows row and column controls.
 */
export function SelectionBar({ kind, editor, format, ai }: { kind: SelectionKind; editor: Editor | null; format?: DocFormat | null; ai?: SelectionAI }) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => (e && !e.isDestroyed
      ? { bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), block: blockOf(e), align: alignOf(e) }
      : IDLE),
  });
  if (kind === 'none' || kind === 'figure') return null;

  const mark = (id: 'bold' | 'italic' | 'underline', label: string, Icon: typeof Bold, run: (e: Editor) => void) => (
    <button key={id} type="button" data-testid={`control-${id}`} title={label} aria-label={label} aria-pressed={st[id]} disabled={!editor}
      {...press(() => { if (editor) run(editor); })}
      className="p-1.5 rounded transition-colors disabled:opacity-40"
      style={{ background: st[id] ? 'var(--surface-3, var(--surface-2))' : 'transparent', color: st[id] ? 'var(--text-primary)' : 'var(--text-secondary)', outline: st[id] ? '1px solid var(--border)' : 'none' }}>
      <Icon size={14} />
    </button>
  );

  return (
    <div data-testid="selection-bar" role="toolbar" aria-label={kind === 'table' ? 'Table' : 'Text formatting'} className="flex items-center gap-1 flex-nowrap">
      {kind === 'text' && (
        <>
          {mark('bold', 'Bold', Bold, e => e.chain().focus().toggleBold().run())}
          {mark('italic', 'Italic', Italic, e => e.chain().focus().toggleItalic().run())}
          {mark('underline', 'Underline', UnderlineIcon, e => e.chain().focus().toggleUnderline().run())}
          <Divider />
          <BlockTypeSelect editor={editor} format={format} className="w-[92px]" />
          <select data-testid="control-align" aria-label="Alignment" title="Alignment" value={st.align} disabled={!editor}
            onChange={e => { editor?.chain().focus().setTextAlign(e.target.value as AlignId).run(); }}
            className="text-xs rounded border px-1.5 py-1 w-[88px]" style={{ background: 'var(--surface-1)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}>
            {ALIGNS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
          {ai && (
            <>
              <Divider />
              <DirectPresets ai={ai} />
              <Divider />
              <AIMenu ai={ai} />
            </>
          )}
        </>
      )}
      {kind === 'table' && TABLE_CONTROLS.map(c => (
        <button key={c.id} type="button" data-testid={`control-${c.id}`} title={c.label} disabled={!editor} {...press(() => { if (editor) c.run(editor); })}
          className="px-2 py-1 rounded text-[11px] font-medium transition-colors hover:bg-stone-100 disabled:opacity-40" style={{ color: c.danger ? '#e11d48' : 'var(--text-secondary)' }}>
          {c.label}
        </button>
      ))}
    </div>
  );
}
