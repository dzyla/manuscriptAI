import type { MutableRefObject } from 'react';
import type { AppCtx } from './appContext';
import { AgentType, AttachedImage, Message, Suggestion } from '../types';
import { searchSimilarManuscripts } from '../services/manuscriptSearch';
import { chatWithAgent, chatWithManuscript, resolveConflicts, verifyClaimAgainstSources, type AgentTool } from '../services/ai';
import { getGrantTemplate, WORDS_PER_PAGE } from '../services/grantTemplates';
import { bytesToDataUrl, defaultFetchBytes } from '../db/assetStore';
import { useDocumentStore } from '../stores/useDocumentStore';
import { useAIStore } from '../stores/useAIStore';
import { useSourceStore } from '../stores/useSourceStore';

/** The section title the Cite panel passes to `onAnalyzeSection` to append a bibliography instead of analysing a section. One constant: a rename in only one file would send the bibliography to the AI. */
export const BIBLIOGRAPHY_SECTION = '__bibliography__';

const stripHtml = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** The chat: sending a message (with its tools and scopes), a figure question, a section analysis and a literature comparison. */
export function useChat({ editorRef, showToast, openTab }: AppCtx, abortRef: MutableRefObject<AbortController | null>) {
  const { content, grantTemplateId, setContent } = useDocumentStore();
  const { aiSettings, setIsAnalyzing, setAnalysisProgress, addSuggestions, addMessage } = useAIStore();
  const { sources } = useSourceStore();

  // Tools the chat agents can call mid-conversation (provider-agnostic protocol)
  const buildAgentTools = (): AgentTool[] => [
    {
      name: 'search_literature',
      description: 'Semantic search over PubMed/bioRxiv/medRxiv/arXiv. args: {"query": "..."} — returns top matching papers with abstracts.',
      run: async (args) => {
        const results = await searchSimilarManuscripts(String(args.query ?? ''), 5);
        if (results.length === 0) return 'No results found.';
        return results.map((r, i) => `[${i + 1}] ${r.title} (${r.journal ?? r.source} ${r.year ?? ''}) DOI:${r.doi}\n${(r.abstract || '').slice(0, 400)}`).join('\n\n');
      },
    },
    {
      name: 'read_section',
      description: 'Read the full text of one document section. args: {"title": "exact H2 heading"}',
      run: async (args) => editorRef.current?.getSectionTextByTitle(String(args.title ?? '')) || `Section "${args.title}" not found. Use one of the document's H2 headings.`,
    },
    {
      name: 'check_page_budgets',
      description: 'Get current word/page counts per section vs the grant template limits. args: {}',
      run: async () => {
        const template = getGrantTemplate(grantTemplateId);
        if (!template) return 'No grant template applied to this document.';
        const plain = editorRef.current?.getPlainText() ?? '';
        return template.sections.map(s => {
          const text = editorRef.current?.getSectionTextByTitle(s.title);
          const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
          const limit = s.pageLimit ? ` / limit ${s.pageLimit} pages (~${Math.round(s.pageLimit * WORDS_PER_PAGE)} words)` : '';
          return `${s.title}: ${words} words${limit}`;
        }).join('\n') + `\nTotal: ${plain.split(/\s+/).filter(Boolean).length} words`;
      },
    },
    {
      name: 'verify_claim',
      description: 'Check a claim against the uploaded reference sources. args: {"claim": "..."}',
      run: async (args) => {
        const digested = sources.filter(s => s.text || s.digest).map(s => ({ name: s.name, text: s.text, digest: s.digest }));
        return verifyClaimAgainstSources(String(args.claim ?? ''), digested, aiSettings);
      },
    },
  ];

  const handleSendMessage = async (text: string, agent: AgentType, attachedSources?: Array<{ name: string; text: string }>, images?: AttachedImage[]) => {
    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: text, images };
    addMessage(userMsg);

    // Resolve manuscript scope: __full__ sends full text, __section__ sends current section only
    const fullText = (editorRef.current?.getPlainText() || stripHtml(content));
    const extraSources = (attachedSources || []).filter(s => s.name !== '__full__' && s.name !== '__section__');

    const hasFullScope   = attachedSources?.some(s => s.name === '__full__');
    const hasSectionScope = attachedSources?.some(s => s.name === '__section__');
    const sectionText = hasSectionScope ? editorRef.current?.getCurrentSectionText() : null;
    const sectionTitle = hasSectionScope ? editorRef.current?.getCurrentSection() : null;

    // Build the manuscript context to pass as the primary text argument
    let manuscriptArg = fullText; // default: always send full (for agent context)
    const sourcesWithContext: Array<{ name: string; text: string }> = [...extraSources];

    if (hasSectionScope && sectionText) {
      sourcesWithContext.unshift({ name: `Section: ${sectionTitle ?? 'Current'}`, text: sectionText });
    } else if (hasFullScope || (!hasFullScope && !hasSectionScope)) {
      sourcesWithContext.unshift({ name: 'Full Manuscript', text: fullText });
    }

    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    setIsAnalyzing(true);
    try {
      const result = agent === 'manuscript-ai'
        ? await chatWithManuscript(text, manuscriptArg, aiSettings, sourcesWithContext.length > 0 ? sourcesWithContext : undefined, images, signal)
        : await chatWithAgent(text, manuscriptArg, agent, aiSettings, sourcesWithContext.length > 0 ? sourcesWithContext : undefined, images, signal,
            buildAgentTools(), (toolName) => {
              const prev = useAIStore.getState().analysisProgress;
              setAnalysisProgress({ agent: `Using tool: ${toolName}…`, total: prev?.total ?? 1, done: prev?.done ?? 0 });
            });
      const suggestions: Suggestion[] | undefined = 'suggestions' in result ? (result as any).suggestions : undefined;
      const newSugs: Suggestion[] | undefined = 'suggestions' in result ? (result as any).suggestions : undefined;
      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: result.text || "I couldn't process that request. Check your LLM connection.",
        agent,
        suggestions: newSugs,
      };
      addMessage(assistantMsg);
      if (newSugs && newSugs.length > 0) {
        const resolved = await resolveConflicts(newSugs, aiSettings);
        addSuggestions(resolved);
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') return; // stopped by user
      console.error("Chat failed", error);
      addMessage({
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Failed to reach LLM'}`,
        agent
      });
    } finally {
      abortRef.current = null;
      setIsAnalyzing(false);
    }
  };

  const handleAnalyzeImage = async (src: string, prompt: string, contextText?: string) => {
    // Images loaded from storage are session blob: URLs; the LLM needs inline base64.
    let dataUrl = src;
    if (src.startsWith('blob:')) {
      try {
        const { mime, data } = await defaultFetchBytes(src);
        dataUrl = bytesToDataUrl(mime, data);
      } catch (err) {
        console.error('Could not read image for analysis', err);
        showToast('Could not read this image for analysis', 'error');
        return;
      }
    }
    const match = dataUrl.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/);
    if (!match) return;
    const rawMime = match[1];
    if (rawMime === 'image/svg+xml') {
      showToast('Convert the figure to PNG or JPEG to analyse it', 'error');
      return;
    }
    const allowed: AttachedImage['mimeType'][] = ['image/jpeg', 'image/png', 'image/webp'];
    const mimeType: AttachedImage['mimeType'] = allowed.includes(rawMime as AttachedImage['mimeType'])
      ? (rawMime as AttachedImage['mimeType'])
      : 'image/png';
    const base64 = match[2];
    const img: AttachedImage = { id: Date.now().toString(), name: 'figure', base64, mimeType, dataUrl };
    const fullPrompt = contextText?.trim()
      ? `${prompt}\n\nContext from the manuscript around this figure:\n"""\n${contextText.trim()}\n"""`
      : prompt;
    handleSendMessage(fullPrompt, 'manuscript-ai', undefined, [img]);
    openTab('chat');
  };

  const handleAnalyzeSection = async (sectionText: string, sectionTitle: string) => {
    // Special sentinel: bibliography insertion from the Sources tab
    if (sectionTitle === BIBLIOGRAPHY_SECTION) {
      const currentHtml = editorRef.current?.getHTML() || content;
      editorRef.current?.setContent(currentHtml + sectionText);
      setContent(currentHtml + sectionText);
      showToast('Bibliography appended to manuscript', 'success');
      return;
    }
    openTab('chat');
    // If called from the Outline tab (no text), extract text from the editor
    const textToAnalyze = sectionText || (() => {
      const html = editorRef.current?.getHTML() || content;
      const h2Re = /<h2[^>]*>(.*?)<\/h2>/gi;
      const matches = [...html.matchAll(h2Re)];
      const idx = matches.findIndex(m => m[1].replace(/<[^>]*>/g, '').trim() === sectionTitle);
      if (idx === -1) return stripHtml(html);
      const start = (matches[idx].index ?? 0) + matches[idx][0].length;
      const end = idx + 1 < matches.length ? (matches[idx + 1].index ?? html.length) : html.length;
      return html.slice(start, end).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    })();

    const userMsg: Message = {
      id: Date.now().toString(), role: 'user',
      content: `Analyze the "${sectionTitle}" section for clarity, scientific rigor, and flow.`,
    };
    addMessage(userMsg);
    setIsAnalyzing(true);
    try {
      const result = await chatWithManuscript(
        `Analyze the "${sectionTitle}" section in detail. Focus on: clarity, scientific rigor, logical flow, and any specific weaknesses. Be concrete and actionable.`,
        `[Section: ${sectionTitle}]\n\n${textToAnalyze}`,
        aiSettings,
      );
      addMessage({ id: (Date.now() + 1).toString(), role: 'assistant', content: result.text, agent: 'manuscript-ai' as AgentType });
    } catch (err) {
      console.error('Section analysis failed', err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleAnalyzeSource = async (analysisText: string, sourceName: string) => {
    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: `Compare reference paper "${sourceName}" against my manuscript`,
    };
    const assistantMsg: Message = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: analysisText,
      agent: 'literature-reviewer',
    };
    addMessage(userMsg);
    addMessage(assistantMsg);
    openTab('chat');
    showToast(`Literature analysis of "${sourceName}" ready`, 'success');
  };


  return { handleSendMessage, handleAnalyzeImage, handleAnalyzeSection, handleAnalyzeSource };
}
