// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useChat, BIBLIOGRAPHY_SECTION } from './useChat';
import { chatWithManuscript } from '../services/ai';
import { useDocumentStore } from '../stores/useDocumentStore';

vi.mock('../services/ai', async orig => ({ ...(await orig<typeof import('../services/ai')>()), chatWithManuscript: vi.fn() }));
afterEach(cleanup);

describe('the bibliography sentinel on handleAnalyzeSection', () => {
  it('appends the bibliography to the document and never spends an AI call on it', async () => {
    const setContent = vi.fn();
    const showToast = vi.fn();
    const editorRef = { current: { getHTML: () => '<p>body</p>', setContent } } as any;
    useDocumentStore.setState({ content: '<p>body</p>' });
    const { result } = renderHook(() => useChat({ editorRef, showToast, openTab: vi.fn() } as any, { current: null }));
    await result.current.handleAnalyzeSection('<h2>References</h2><ol></ol>', BIBLIOGRAPHY_SECTION);
    expect(setContent).toHaveBeenCalledWith('<p>body</p><h2>References</h2><ol></ol>');
    expect(showToast).toHaveBeenCalledWith('Bibliography appended to manuscript', 'success');
    expect(chatWithManuscript).not.toHaveBeenCalled();
  });
});
