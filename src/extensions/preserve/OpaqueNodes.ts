import { Extension, Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

const opaqueAttrs = () => ({
  kind: {
    default: 'unknown',
    parseHTML: (el: HTMLElement) => el.getAttribute('data-kind') ?? 'unknown',
    renderHTML: (a: Record<string, unknown>) => ({ 'data-kind': a.kind }),
  },
  label: {
    default: 'object',
    parseHTML: (el: HTMLElement) => el.getAttribute('data-label') ?? 'object',
    renderHTML: (a: Record<string, unknown>) => ({ 'data-label': a.label }),
  },
  fragmentId: {
    default: '',
    parseHTML: (el: HTMLElement) => el.getAttribute('data-fragment-id') ?? '',
    renderHTML: (a: Record<string, unknown>) => ({ 'data-fragment-id': a.fragmentId }),
  },
});

/** Category-3 inline content preserved verbatim (equations, footnote refs, unknown fields). */
export const OpaqueInline = Node.create({
  name: 'opaqueInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: opaqueAttrs,
  parseHTML: () => [{ tag: 'span[data-opaque]' }],
  renderHTML: ({ node, HTMLAttributes }) => [
    'span',
    mergeAttributes(HTMLAttributes, { 'data-opaque': '', class: 'opaque-chip', contenteditable: 'false' }),
    String(node.attrs.label),
  ],
});

/** Category-3 block content preserved verbatim (content controls, section breaks, …). */
export const OpaqueBlock = Node.create({
  name: 'opaqueBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes: opaqueAttrs,
  parseHTML: () => [{ tag: 'div[data-opaque]' }],
  renderHTML: ({ node, HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-opaque': '', class: 'opaque-chip opaque-block', contenteditable: 'false' }),
    String(node.attrs.label),
  ],
});

/** Positions of the second and later occurrences of each fragmentId, in document order. */
export function findDuplicateFragmentIds(doc: PMNode): Array<{ pos: number; fragmentId: string }> {
  const seen = new Set<string>();
  const dupes: Array<{ pos: number; fragmentId: string }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'opaqueInline' && node.type.name !== 'opaqueBlock') return;
    const id = node.attrs.fragmentId as string;
    if (!id) return;
    if (seen.has(id)) dupes.push({ pos, fragmentId: id });
    else seen.add(id);
  });
  return dupes;
}

/** Positions of nodes whose ooxml.blockId already appeared earlier in document order. */
export function findDuplicateBlockIds(doc: PMNode): number[] {
  const seen = new Set<string>();
  const dupes: number[] = [];
  doc.descendants((node, pos) => {
    const id = node.attrs.ooxml?.blockId as string | undefined;
    if (!id) return;
    if (seen.has(id)) dupes.push(pos);
    else seen.add(id);
  });
  return dupes;
}

const newFragmentId = () =>
  'f_' + (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 16);

export interface OpaqueFragmentGuardOptions {
  /** Called when a copy received a new id; the caller clones the fragment store entry. */
  onDuplicateFragment: (fromId: string, toId: string) => void;
}

/**
 * Keeps preservation identity unique after copy/paste: duplicated opaque-atom fragment ids get
 * fresh ids, and duplicated block provenance (ooxml.blockId) is cleared on the later copy so
 * DOCX export never reuses one original block's XML twice.
 */
export const OpaqueFragmentGuard = Extension.create<OpaqueFragmentGuardOptions>({
  name: 'opaqueFragmentGuard',
  addOptions: () => ({ onDuplicateFragment: () => {} }),
  addProseMirrorPlugins() {
    const opts = this.options;
    return [
      new Plugin({
        key: new PluginKey('opaqueFragmentGuard'),
        appendTransaction: (trs, _old, state) => {
          if (!trs.some(t => t.docChanged)) return null;
          const fragmentDupes = findDuplicateFragmentIds(state.doc);
          const blockDupes = findDuplicateBlockIds(state.doc);
          if (fragmentDupes.length === 0 && blockDupes.length === 0) return null;
          const tr = state.tr;
          // Attribute-only edits never shift positions, so positions from the original doc stay valid.
          for (const d of fragmentDupes) {
            const node = state.doc.nodeAt(d.pos);
            if (!node) continue;
            const toId = newFragmentId();
            tr.setNodeMarkup(d.pos, undefined, { ...node.attrs, fragmentId: toId });
            opts.onDuplicateFragment(d.fragmentId, toId);
          }
          for (const pos of blockDupes) {
            const node = tr.doc.nodeAt(pos);
            if (!node) continue;
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, ooxml: null });
          }
          tr.setMeta('addToHistory', false);
          return tr;
        },
      }),
    ];
  },
});
