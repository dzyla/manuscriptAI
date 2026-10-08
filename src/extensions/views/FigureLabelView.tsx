import { NodeViewWrapper } from '@tiptap/react';

export function FigureLabelView({ node }: { node: any }) {
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
