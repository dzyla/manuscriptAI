import { NodeViewWrapper } from '@tiptap/react';
import { formatCitationGroup } from '../../utils/citationFormat';

export function CitationView({ node }: { node: any }) {
  const nums: number[] = node.attrs.nums ?? [];
  const sourceIds: string[] = node.attrs.sourceIds ?? [];

  const display = nums.length > 0 ? formatCitationGroup(nums) : '[?]';
  const tooltipText = sourceIds.length > 0
    ? `Citation ${display} (${sourceIds.length} source${sourceIds.length > 1 ? 's' : ''})`
    : `Citation ${display}`;

  return (
    <NodeViewWrapper
      as="span"
      data-citation-node=""
      data-source-ids={sourceIds.join(',')}
      data-nums={nums.join(',')}
      className="citation-badge"
      title={tooltipText}
      contentEditable={false}
    >
      {display}
    </NodeViewWrapper>
  );
}
