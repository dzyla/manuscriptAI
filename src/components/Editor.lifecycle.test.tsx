// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import { useState } from 'react';
import type { Editor as TipEditor, JSONContent } from '@tiptap/core';
import Editor from './Editor';

afterEach(() => { cleanup(); });

// TipTap's useEditor schedules a destroy 1 ms after creating the editor and cancels it only once its
// own effect has run. On a slow first commit (the production bundle) the timer wins: the editor is
// destroyed, useEditor makes a replacement, and Editor's effects from that same commit still run
// against the destroyed one, whose `view` throws "The editor view is not available". This test
// reaches the same state by destroying the editor and re-rendering.
describe('editor destroyed between render and effects', () => {
  it('does not throw, and recovers onto the replacement editor', async () => {
    const ready: (TipEditor | null)[] = [];
    const onEditorReady = (e: TipEditor | null) => { ready.push(e); };
    const props = { content: '<p>hi</p>', onChange: () => {}, onSuggestionClick: () => {}, onEditorReady };
    const { rerender, container } = render(<Editor {...props} suggestions={[]} />);
    const first = ready.find(Boolean)!;
    expect(first).toBeTruthy();

    act(() => { first.destroy(); });
    const suggestion = { id: 's1', agent: 'editor', originalText: 'hi', suggestedText: 'hello', explanation: '', type: 'edit' };
    expect(() => rerender(<Editor {...props} suggestions={[suggestion] as never} />)).not.toThrow();

    await waitFor(() => {
      const last = ready.filter(Boolean).at(-1)!;
      expect(last).not.toBe(first);
      expect(last.isDestroyed).toBe(false);
    });
    expect(container.querySelector('.ProseMirror')).not.toBeNull();
  });

  it('applies a pending document to the replacement editor, not the destroyed one', async () => {
    const ready: (TipEditor | null)[] = [];
    const onEditorReady = (e: TipEditor | null) => { ready.push(e); };
    let deliver: (doc: JSONContent) => void = () => {};
    // Like App: the editor's HTML flows back as `content`, and the pending document is cleared once the editor reports it applied.
    function Host() {
      const [content, setContent] = useState('');
      const [pending, setPending] = useState<JSONContent | null>(null);
      deliver = setPending;
      return <Editor content={content} onChange={setContent} onSuggestionClick={() => {}} suggestions={[]} onEditorReady={onEditorReady}
        pendingDocument={pending} onPendingDocumentApplied={() => setPending(null)} />;
    }
    render(<Host />);
    const first = ready.find(Boolean)!;

    act(() => { first.destroy(); });
    act(() => { deliver({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'loaded text' }] }] }); });

    await waitFor(() => {
      const last = ready.filter(Boolean).at(-1)!;
      expect(last).not.toBe(first);
      expect(last.getText()).toContain('loaded text');
    });
  });
});
