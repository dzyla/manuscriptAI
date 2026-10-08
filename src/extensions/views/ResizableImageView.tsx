import { NodeViewWrapper } from '@tiptap/react';
import { useRef, useCallback } from 'react';

interface ResizableImageViewProps {
  node: any;
  updateAttributes: (attrs: Record<string, any>) => void;
  selected: boolean;
  editor: any;
}

export function ResizableImageView({ node, updateAttributes, selected, editor }: ResizableImageViewProps) {
  const { src, alt, title, width, align } = node.attrs;
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizing.current = true;
    startX.current = e.clientX;
    startWidth.current = imgRef.current?.offsetWidth || 300;

    const onMove = (ev: MouseEvent) => {
      if (!isResizing.current || !imgRef.current) return;
      const delta = ev.clientX - startX.current;
      const newWidth = Math.max(80, Math.min(startWidth.current + delta, 1200));
      imgRef.current.style.width = `${newWidth}px`;
    };

    const onUp = () => {
      if (!isResizing.current) return;
      isResizing.current = false;
      if (imgRef.current) updateAttributes({ width: imgRef.current.style.width });
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [updateAttributes]);

  const imgStyle: React.CSSProperties = {
    width: width || '100%',
    maxWidth: '100%',
    display: 'block',
    userSelect: 'none',
  };

  return (
    <NodeViewWrapper contentEditable={false} data-drag-handle>
      {/* Full-width block — text-align drives horizontal positioning of the inline-block child */}
      <div style={{
        display: 'block',
        width: '100%',
        margin: '12px 0',
        textAlign: align === 'right' ? 'right' : align === 'left' ? 'left' : 'center',
      }}>
      <div
        ref={containerRef}
        className="relative inline-block"
        style={{ maxWidth: '100%' }}
      >
        {src ? (
          <img
            ref={imgRef}
            src={src}
            alt={alt || ''}
            title={title || ''}
            style={imgStyle}
            className={`rounded select-none ${selected ? 'ring-2 ring-blue-500 ring-offset-1' : ''}`}
            draggable={false}
          />
        ) : (
          // Stored bytes are missing: show a placeholder without touching the node's alt/assetId.
          <div
            className={`rounded select-none px-4 py-6 text-xs ${selected ? 'ring-2 ring-blue-500 ring-offset-1' : ''}`}
            style={{ border: '1px dashed var(--border)', color: 'var(--text-muted)' }}
          >
            [missing image]{alt ? ` ${alt}` : ''}
          </div>
        )}

        {/* Resize handle — bottom-right corner */}
        {selected && (
          <div
            onMouseDown={onResizeStart}
            className="absolute bottom-0 right-0 w-4 h-4 bg-blue-500 cursor-se-resize rounded-tl-sm opacity-80 hover:opacity-100"
            style={{ cursor: 'se-resize' }}
            title="Drag to resize"
          />
        )}
      </div>
      </div>
    </NodeViewWrapper>
  );
}
