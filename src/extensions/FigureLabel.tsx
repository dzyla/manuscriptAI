// src/extensions/FigureLabel.tsx
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';

function FigureLabelView({ node }: { node: any }) {
  const num: number = node.attrs.num ?? 1;
  const figureId: string = node.attrs.figureId ?? '';
  return (
    <NodeViewWrapper
      as="span"
      data-figure-label=""
      data-figure-id={figureId}
      data-figure-num={String(num)}
      className="figure-label"
      contentEditable={false}
    >
      Figure {num}
    </NodeViewWrapper>
  );
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    figureLabel: {
      insertFigureLabel: (figureId: string, num: number) => ReturnType;
      updateAllFigureNums: (registry: Record<string, number>) => ReturnType;
    };
  }
}

export const FigureLabel = Node.create({
  name: 'figureLabel',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      figureId: {
        default: '',
        parseHTML: (el: Element) => el.getAttribute('data-figure-id') ?? '',
        renderHTML: (attrs) => ({ 'data-figure-id': attrs.figureId as string }),
      },
      num: {
        default: 1,
        parseHTML: (el: Element) => {
          const v = el.getAttribute('data-figure-num');
          const n = parseInt(v ?? '1');
          return isNaN(n) ? 1 : n;
        },
        renderHTML: (attrs) => ({ 'data-figure-num': String(attrs.num) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-figure-label]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const num: number = node.attrs.num ?? 1;
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-figure-label': '' }),
      `Figure ${num}`,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FigureLabelView);
  },

  addCommands() {
    return {
      insertFigureLabel:
        (figureId: string, num: number) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { figureId, num },
          });
        },

      updateAllFigureNums:
        (registry: Record<string, number>) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.doc.descendants((node, pos) => {
              if (node.type.name !== 'figureLabel') return;
              const figureId: string = node.attrs.figureId ?? '';
              const newNum = registry[figureId];
              if (newNum !== undefined && newNum !== node.attrs.num) {
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, num: newNum });
              }
            });
            dispatch(tr);
          }
          return true;
        },
    };
  },
});
