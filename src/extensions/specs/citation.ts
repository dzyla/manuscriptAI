import { Node, mergeAttributes } from '@tiptap/core';
import { formatCitationGroup } from '../../utils/citationFormat';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    citation: {
      insertCitation: (sourceId: string, num: number) => ReturnType;
      insertCitationBatch: (sourceIds: string[], nums: number[]) => ReturnType;
      updateAllCitationNums: (registry: Record<string, number>) => ReturnType;
    };
  }
}

export const CitationSpec = Node.create({
  name: 'citation',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      sourceIds: {
        default: [],
        parseHTML: (el) =>
          (el.getAttribute('data-source-ids') ?? '').split(',').filter(Boolean),
        renderHTML: (attrs) => ({ 'data-source-ids': (attrs.sourceIds as string[]).join(',') }),
      },
      nums: {
        default: [],
        parseHTML: (el) =>
          (el.getAttribute('data-nums') ?? '').split(',').map(Number).filter(n => !isNaN(n) && n > 0),
        renderHTML: (attrs) => ({ 'data-nums': (attrs.nums as number[]).join(',') }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-citation-node]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const nums: number[] = node.attrs.nums ?? [];
    const display = nums.length > 0 ? formatCitationGroup(nums) : '[?]';
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-citation-node': '' }),
      display,
    ];
  },

  addCommands() {
    return {
      insertCitation: (sourceId: string, num: number) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { sourceIds: [sourceId], nums: [num] },
          });
        },

      insertCitationBatch: (sourceIds: string[], nums: number[]) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { sourceIds, nums },
          });
        },

      updateAllCitationNums: (registry: Record<string, number>) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.doc.descendants((node, pos) => {
              if (node.type.name !== 'citation') return;
              const sourceIds: string[] = node.attrs.sourceIds ?? [];
              const newNums = sourceIds
                .map((id: string) => registry[id])
                .filter((n: number | undefined): n is number => n !== undefined);
              if (JSON.stringify(newNums) !== JSON.stringify(node.attrs.nums)) {
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, nums: newNums });
              }
            });
            dispatch(tr);
          }
          return true;
        },
    };
  },
});
