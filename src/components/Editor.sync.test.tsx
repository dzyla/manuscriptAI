// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createRef, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { JSONContent } from '@tiptap/core';
import Editor, { type EditorRef } from './Editor';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const P: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'loaded from json' }] }],
};

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => { root?.unmount(); }); host?.remove(); root = null; host = null; });

function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const ref = createRef<EditorRef>();
  const calls = { changed: [] as string[], synced: [] as string[], applied: 0 };
  const render = (content: string, pendingDocument: JSONContent | null) => act(() => {
    root!.render(
      <Editor
        ref={ref}
        content={content}
        pendingDocument={pendingDocument}
        onPendingDocumentApplied={() => { calls.applied++; }}
        onContentSynced={(h) => calls.synced.push(h)}
        onChange={(h) => calls.changed.push(h)}
        suggestions={[]}
        onSuggestionClick={() => {}}
      />,
    );
  });
  return { ref, calls, render };
}

describe('Editor pendingDocument coordination', () => {
  it('applies the pending JSON once, adopts the editor HTML, and does not report a user edit', async () => {
    const { ref, calls, render } = mount();
    render('<p>derived html</p>', P);
    expect(ref.current!.getHTML()).toBe('<p>loaded from json</p>');
    expect(calls.synced).toEqual(['<p>loaded from json</p>']);
    expect(calls.changed).toEqual([]);
    expect(calls.applied).toBe(1);
  });

  it('a content write that arrives while the flag is set is applied when the flag clears, not dropped', async () => {
    const { ref, render } = mount();
    render('<p>derived html</p>', P);
    // flag still set (the test never clears it): content changes underneath it
    render('<p>newer content</p>', P);
    expect(ref.current!.getHTML()).toBe('<p>loaded from json</p>'); // stood down
    render('<p>newer content</p>', null); // flag clears
    expect(ref.current!.getHTML()).toBe('<p>newer content</p>');
  });

  it('when the flag clears with content already equal to the editor, nothing is re-applied', async () => {
    const { ref, calls, render } = mount();
    render('<p>derived html</p>', P);
    render('<p>loaded from json</p>', null); // what the store holds after adoptLoadedHtml
    expect(ref.current!.getHTML()).toBe('<p>loaded from json</p>');
    expect(calls.changed).toEqual([]);
  });
});
