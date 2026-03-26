import { useEditor, EditorContent } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Link from '@tiptap/extension-link';
import { forwardRef, useImperativeHandle, useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { AgentType, Suggestion, ManuscriptSource } from '../types';
import { GrammarChecker } from '../extensions/GrammarChecker';
import {
  Bold, Italic, Underline as UnderlineIcon, List, ListOrdered,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, Quote, Heading2,
  Heading3, Undo, Redo, Clock, Sparkles, PenLine, FlaskConical, Beaker, Send, MessageSquare, BookOpen, RefreshCw, FileSearch, Search
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { getThesaurus } from '../services/ai';
import { AISettings } from '../types';

interface EditorProps {
  content: string;
  onChange: (content: string) => void;
  suggestions: Suggestion[];
  onSuggestionClick: (suggestionId: string) => void;
  onSelectionQuery?: (selectedText: string, instruction: string, agent: AgentType) => void;
  onRewriteSection?: (selectedText: string) => void;
  onTransformSelection?: (selectedText: string, instruction: string, agent: AgentType) => void;
  onAnalyzeSection?: (sectionText: string, sectionTitle: string) => void;
  onVerifyClaim?: (selectedText: string) => void;
  onSearchSimilar?: (selectedText: string) => void;
  sources?: ManuscriptSource[];
  citationRegistry?: Record<string, number>;
  onInsertCitation?: (sourceId: string) => number;
  isDistractionFree?: boolean;
  editorZoom?: number;
  editorWidth?: 'normal' | 'wide' | 'full';
  currentAgent?: AgentType;
  aiSettings?: AISettings;
}

export interface EditorRef {
  applySuggestion: (originalText: string, suggestedText: string) => boolean;
  revertSuggestion: (originalText: string, suggestedText: string) => boolean;
  scrollToSuggestion: (text: string, id: string) => void;
  getHTML: () => string;
  setContent: (html: string) => void;
  getSelectedText: () => string;
  getCurrentSection: () => string | null;
  scrollToHeading: (headingText: string) => void;
}

const findTextPosition = (doc: any, searchText: string): { from: number; to: number } | null => {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node: any, pos: number) => {
    if (found) return false;
    if (node.isText && node.text.includes(searchText)) {
      const offset = node.text.indexOf(searchText);
      found = { from: pos + offset, to: pos + offset + searchText.length };
      return false;
    }
    return true;
  });
  if (found) return found;

  const fullText = doc.textContent;
  const searchIdx = fullText.indexOf(searchText);
  if (searchIdx === -1) return null;

  let charsSeen = 0;
  let fromPos: number | null = null;
  let toPos: number | null = null;
  const targetEnd = searchIdx + searchText.length;

  doc.descendants((node: any, pos: number) => {
    if (toPos !== null) return false;
    if (node.isText) {
      const nodeStart = charsSeen;
      const nodeEnd = charsSeen + node.text.length;
      if (fromPos === null && searchIdx >= nodeStart && searchIdx < nodeEnd) {
        fromPos = pos + (searchIdx - nodeStart);
      }
      if (fromPos !== null && targetEnd >= nodeStart && targetEnd <= nodeEnd) {
        toPos = pos + (targetEnd - nodeStart);
      }
      charsSeen += node.text.length;
    }
    return true;
  });

  if (fromPos !== null && toPos !== null) return { from: fromPos, to: toPos };
  return null;
};

// Bubble actions: transform = produces accept/reject suggestion; analyze = produces chat reply only
const BUBBLE_ACTIONS: { label: string; instruction: string; agent: AgentType; icon: any; mode: 'transform' | 'analyze' }[] = [
  {
    label: 'Polish',
    instruction: 'Fix grammar, convert passive voice to active, tighten wordy phrases, and improve sentence flow. Keep all scientific content intact.',
    agent: 'editor',
    icon: PenLine,
    mode: 'transform'
  },
  {
    label: 'Shorten',
    instruction: 'Condense this text for a scientific manuscript: cut redundant words, remove unnecessary hedging, combine short sentences. Preserve all key scientific information and claims.',
    agent: 'editor',
    icon: PenLine,
    mode: 'transform'
  },
  {
    label: 'Sharpen',
    instruction: 'Strengthen the topic sentence to clearly state the paragraph\'s conclusion, reduce excessive hedging language ("may possibly" → "suggests"), and improve the opening for maximum impact.',
    agent: 'researcher',
    icon: Beaker,
    mode: 'transform'
  },
  {
    label: 'Strengthen',
    instruction: 'Revise this text to be more scientifically rigorous: make vague claims specific, add appropriate qualifications to overclaimed statements, and make the argument more concrete and evidenced.',
    agent: 'reviewer-2',
    icon: FlaskConical,
    mode: 'transform'
  },
  {
    label: 'Critique',
    instruction: 'Identify the specific scientific weaknesses in this text: unsupported claims, logical gaps, missing methodology details, conclusions that exceed the data. Be direct and concise.',
    agent: 'reviewer-2',
    icon: FlaskConical,
    mode: 'analyze'
  },
  {
    label: 'Explain',
    instruction: 'Explain the key scientific concept, finding, or argument in this passage clearly. What is the author trying to say? What assumptions are being made? What would make this clearer for the reader?',
    agent: 'researcher',
    icon: Beaker,
    mode: 'analyze'
  },
];

const Editor = forwardRef<EditorRef, EditorProps>(({ content, onChange, suggestions, onSuggestionClick, onSelectionQuery, onTransformSelection, onRewriteSection, onAnalyzeSection, onVerifyClaim, onSearchSimilar, sources, citationRegistry, onInsertCitation, isDistractionFree, editorZoom = 100, editorWidth = 'normal', aiSettings }, ref) => {
  const [isMounted, setIsMounted] = useState(false);
  const [showSelectionBar, setShowSelectionBar] = useState(false);
  const [selectionInstruction, setSelectionInstruction] = useState('');
  const [selectionAgent, setSelectionAgent] = useState<AgentType>('editor');
  const [thesaurusWord, setThesaurusWord] = useState<string | null>(null);
  const [thesaurusSynonyms, setThesaurusSynonyms] = useState<string[]>([]);
  const [thesaurusLoading, setThesaurusLoading] = useState(false);
  const [currentSectionTitle, setCurrentSectionTitle] = useState<string | null>(null);
  const isExternalUpdate = useRef(false);
  const lastExternalContent = useRef(content);
  const instructionInputRef = useRef<HTMLInputElement>(null);
  const [citationPicker, setCitationPicker] = useState<{ x: number; y: number } | null>(null);
  const [citationFilter, setCitationFilter] = useState('');
  const atInsertPos = useRef(-1);
  const showCitationPickerRef = useRef(false);
  showCitationPickerRef.current = !!citationPicker;

  useEffect(() => { setIsMounted(true); }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({ placeholder: 'Start writing your manuscript here...' }),
      Highlight.configure({ multicolor: true }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Link.configure({ openOnClick: false }),
      GrammarChecker,
    ],
    content,
    onUpdate: ({ editor }) => {
      if (isExternalUpdate.current) return;
      const html = editor.getHTML();
      lastExternalContent.current = html;
      onChange(html);
    },
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection;
      const hasSelection = from !== to;
      setShowSelectionBar(hasSelection);
      if (!hasSelection) {
        setThesaurusWord(null);
        setThesaurusSynonyms([]);
      }
      // Track which H2 section the cursor is in
      let section: string | null = null;
      editor.state.doc.nodesBetween(0, from, (node) => {
        if (node.type.name === 'heading' && node.attrs.level === 2) {
          section = node.textContent;
        }
        return true;
      });
      setCurrentSectionTitle(section);
    },
    editorProps: {
      attributes: { class: 'prose max-w-none focus:outline-none min-h-[500px]' },
    },
  });

  // Handle clicks on highlight marks: find suggestion by ProseMirror position (TipTap Highlight
  // doesn't render custom attributes to DOM, so we can't use data-suggestion-id on the element)
  useEffect(() => {
    if (!editor) return;
    const editorEl = editor.view.dom;

    const handleDomClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName !== 'MARK') return;
      const resolved = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (!resolved) return;
      const pos = resolved.pos;
      for (const s of suggestions) {
        const match = findTextPosition(editor.state.doc, s.originalText);
        if (match && pos >= match.from && pos <= match.to) {
          onSuggestionClick(s.id);
          return;
        }
      }
    };

    editorEl.addEventListener('click', handleDomClick);
    return () => editorEl.removeEventListener('click', handleDomClick);
  }, [editor, suggestions, onSuggestionClick]);

  // @ citation trigger
  useEffect(() => {
    if (!editor) return;
    const editorEl = editor.view.dom;

    const handleAtKey = (e: KeyboardEvent) => {
      if (showCitationPickerRef.current) {
        if (e.key === 'Escape') { setCitationPicker(null); setCitationFilter(''); }
        return;
      }
      if (e.key === '@') {
        const pos = editor.state.selection.from;
        // Delay so the '@' character is inserted first, then we know its position
        setTimeout(() => {
          atInsertPos.current = pos; // '@' lands at this doc position
          try {
            const coords = editor.view.coordsAtPos(pos + 1);
            setCitationFilter('');
            setCitationPicker({ x: coords.left, y: coords.bottom + 6 });
          } catch (_) {}
        }, 0);
      }
    };

    editorEl.addEventListener('keydown', handleAtKey);
    return () => editorEl.removeEventListener('keydown', handleAtKey);
  }, [editor]);

  // While citation picker is open, track filter text from what was typed after '@'
  useEffect(() => {
    if (!citationPicker || !editor) return;
    const curPos = editor.state.selection.from;
    const from = atInsertPos.current; // position before '@'
    if (curPos > from) {
      const typed = editor.state.doc.textBetween(from, Math.min(curPos, from + 40), '');
      // typed starts with '@', strip it
      setCitationFilter(typed.replace(/^@/, '').toLowerCase());
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor?.state.selection.from, citationPicker]);

  // Sync content from parent
  useEffect(() => {
    if (!editor) return;
    if (content !== lastExternalContent.current) {
      isExternalUpdate.current = true;
      editor.commands.setContent(content);
      lastExternalContent.current = content;
      setTimeout(() => { isExternalUpdate.current = false; }, 0);
    }
  }, [content, editor]);

  // Apply suggestion highlighting
  useEffect(() => {
    if (!editor) return;
    const { tr } = editor.state;
    tr.removeMark(0, editor.state.doc.content.size, editor.schema.marks.highlight);
    editor.view.dispatch(tr);

    suggestions.forEach(s => {
      const color = s.agent === 'manager' ? '#1c1917' : 
                    s.agent === 'editor' ? '#3b6fd4' : 
                    s.agent === 'reviewer-2' ? '#c43d5c' :
                    s.agent === 'researcher' ? '#b8860b' : '#8a847a';
      const posMatch = findTextPosition(editor.state.doc, s.originalText);
      if (posMatch) {
        editor.chain()
          .setTextSelection({ from: posMatch.from, to: posMatch.to })
          .setHighlight({ color: `${color}25`, suggestionId: s.id } as any)
          .run();
      }
    });
  }, [suggestions, editor]);

  const getSelectedText = () => {
    if (!editor) return '';
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, ' ');
  };

  const handleSelectionSend = (instruction: string, agent: AgentType) => {
    const text = getSelectedText();
    if (!text.trim() || !onSelectionQuery) return;
    onSelectionQuery(text, instruction, agent);
    setSelectionInstruction('');
    setShowSelectionBar(false);
  };

  const handleInsertCitation = (source: ManuscriptSource) => {
    if (!editor || !onInsertCitation) return;
    const num = onInsertCitation(source.id);
    const atPos = atInsertPos.current;
    const curPos = editor.state.selection.from;
    // Delete from atPos (the '@') to current cursor position, then insert [N]
    editor.chain().focus()
      .deleteRange({ from: atPos, to: curPos })
      .insertContent(`[${num}]`)
      .run();
    setCitationPicker(null);
    setCitationFilter('');
  };

  const filteredCitationSources = useMemo(() => {
    if (!sources) return [];
    const f = citationFilter.trim();
    return sources.filter(s => s.type !== 'bib' && (
      !f || s.name.toLowerCase().includes(f) || s.apiMeta?.authors?.toLowerCase().includes(f) || s.apiMeta?.title?.toLowerCase().includes(f)
    ));
  }, [sources, citationFilter]);

  const handleThesaurus = useCallback(async () => {
    const text = getSelectedText().trim();
    const isSingleWord = text && !text.includes(' ') && text.length > 1;
    if (!isSingleWord) return;
    setThesaurusWord(text);
    setThesaurusSynonyms([]);
    setThesaurusLoading(true);
    try {
      const synonyms = await getThesaurus(text, aiSettings || { provider: 'local', localBaseUrl: 'http://localhost:1234/v1/chat/completions', localApiKey: '', localModel: 'local-model', geminiApiKey: '', openaiApiKey: '', anthropicApiKey: '', geminiModel: '', openaiModel: '', anthropicModel: '' });
      setThesaurusSynonyms(synonyms);
    } finally {
      setThesaurusLoading(false);
    }
  }, [aiSettings]);

  const replaceWithSynonym = (synonym: string) => {
    if (!editor || !thesaurusWord) return;
    const { from, to } = editor.state.selection;
    editor.chain().focus().setTextSelection({ from, to }).insertContent(synonym).run();
    setThesaurusWord(null);
    setThesaurusSynonyms([]);
    onChange(editor.getHTML());
  };

  // Extract plain text for the H2 section that contains `sectionTitle`
  const getSectionText = (sectionTitle: string): string => {
    if (!editor) return sectionTitle;
    let inSection = false;
    let stopped = false;
    const parts: string[] = [sectionTitle];
    editor.state.doc.descendants((node) => {
      if (stopped) return false;
      if (node.type.name === 'heading' && node.attrs.level === 2) {
        if (inSection) { stopped = true; return false; }
        if (node.textContent === sectionTitle) inSection = true;
      } else if (inSection && node.isBlock && node.textContent.trim()) {
        parts.push(node.textContent);
      }
      return true;
    });
    return parts.join('\n\n');
  };

  useImperativeHandle(ref, () => ({
    applySuggestion: (originalText, suggestedText) => {
      if (!editor) return false;
      const posMatch = findTextPosition(editor.state.doc, originalText);
      if (posMatch) {
        // First scroll to the text so user can see the change
        editor.chain().focus()
          .setTextSelection({ from: posMatch.from, to: posMatch.to })
          .scrollIntoView()
          .run();

        // Brief pause so user sees what's being replaced, then apply
        setTimeout(() => {
          editor.chain().focus()
            .setTextSelection({ from: posMatch.from, to: posMatch.to })
            .insertContent(suggestedText)
            .run();
          
          // Flash animation on the new text
          const newPosMatch = findTextPosition(editor.state.doc, suggestedText);
          if (newPosMatch) {
            editor.chain()
              .setTextSelection({ from: newPosMatch.from, to: newPosMatch.to })
              .scrollIntoView()
              .run();
          }

          // Apply DOM-level flash animation
          setTimeout(() => {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
              const range = sel.getRangeAt(0);
              const span = document.createElement('span');
              span.className = 'accept-flash';
              try {
                range.surroundContents(span);
                setTimeout(() => {
                  // Unwrap the flash span after animation
                  if (span.parentNode) {
                    const parent = span.parentNode;
                    while (span.firstChild) parent.insertBefore(span.firstChild, span);
                    parent.removeChild(span);
                  }
                }, 1200);
              } catch (_) {
                // Can fail if selection spans multiple elements — that's fine
              }
            }
          }, 50);

          const newHtml = editor.getHTML();
          lastExternalContent.current = newHtml;
          onChange(newHtml);
        }, 200);

        return true;
      }
      return false;
    },
    revertSuggestion: (originalText, suggestedText) => {
      if (!editor) return false;
      const posMatch = findTextPosition(editor.state.doc, suggestedText);
      if (posMatch) {
        editor.chain().focus()
          .setTextSelection({ from: posMatch.from, to: posMatch.to })
          .insertContent(originalText)
          .run();
        const newHtml = editor.getHTML();
        lastExternalContent.current = newHtml;
        onChange(newHtml);
        return true;
      }
      return false;
    },
    scrollToSuggestion: (text) => {
      if (!editor) return;
      const posMatch = findTextPosition(editor.state.doc, text);
      if (posMatch) {
        // Set selection and scroll into view
        editor.chain().focus()
          .setTextSelection({ from: posMatch.from, to: posMatch.to })
          .scrollIntoView()
          .run();

        // The editor's scrollIntoView uses the built-in ProseMirror scroll.
        // Also do a manual scroll of the parent container for reliable centering.
        setTimeout(() => {
          const coords = editor.view.coordsAtPos(posMatch.from);
          if (coords) {
            const editorDom = editor.view.dom;
            const scrollParent = editorDom.closest('.overflow-y-auto') || editorDom.parentElement?.closest('.overflow-y-auto');
            if (scrollParent) {
              const scrollRect = scrollParent.getBoundingClientRect();
              const targetY = coords.top - scrollRect.top + scrollParent.scrollTop - scrollParent.clientHeight / 3;
              scrollParent.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
            }
          }
        }, 50);
      }
    },
    getHTML: () => editor?.getHTML() || '',
    setContent: (html: string) => {
      if (!editor) return;
      isExternalUpdate.current = true;
      editor.commands.setContent(html);
      lastExternalContent.current = html;
      setTimeout(() => { isExternalUpdate.current = false; }, 0);
    },
    getSelectedText,
    getCurrentSection: () => currentSectionTitle,
    scrollToHeading: (headingText: string) => {
      if (!editor) return;
      let targetPos: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (targetPos !== null) return false;
        if (node.type.name === 'heading' && node.textContent === headingText) {
          targetPos = pos;
          return false;
        }
        return true;
      });
      if (targetPos !== null) {
        editor.chain().focus().setTextSelection(targetPos + 1).scrollIntoView().run();
        setTimeout(() => {
          const coords = editor.view.coordsAtPos(targetPos! + 1);
          if (coords) {
            const scrollParent = editor.view.dom.closest('.overflow-y-auto') || editor.view.dom.parentElement?.closest('.overflow-y-auto');
            if (scrollParent) {
              const rect = scrollParent.getBoundingClientRect();
              const targetY = coords.top - rect.top + scrollParent.scrollTop - 80;
              scrollParent.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
            }
          }
        }, 50);
      }
    },
  }));

  if (!editor) return null;

  const wordCount = editor.state.doc.textContent.split(/\s+/).filter(w => w.length > 0).length;
  const charCount = editor.state.doc.textContent.length;
  const stats = {
    words: wordCount,
    characters: charCount,
    paragraphs: editor.state.doc.childCount,
    readingTime: Math.ceil(wordCount / 200),
  };

  const ToolbarButton = ({ onClick, isActive = false, children, title }: any) => (
    <button onClick={onClick} title={title}
      className={`p-1.5 rounded transition-colors ${isActive ? 'bg-stone-200 text-stone-900' : 'text-stone-500 hover:bg-stone-100'}`}
    >{children}</button>
  );

  const widthClass = editorWidth === 'wide' ? 'max-w-6xl' : editorWidth === 'full' ? 'max-w-none' : 'max-w-4xl';

  return (
    <div className={`w-full ${widthClass} mx-auto ${isDistractionFree ? 'focus-mode' : ''}`}>
      <div className="bg-[var(--editor-bg)] min-h-[600px] shadow-[var(--editor-shadow)] rounded-sm border border-[var(--border-subtle)] transition-colors duration-300">
        
        {/* Floating Toolbar (Portal) */}
        {isMounted && createPortal(
          <div className="flex items-center gap-0.5 bg-[var(--surface-1)] border border-[var(--border)] rounded-lg p-1 shadow-sm flex-wrap justify-end">
            <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} isActive={editor.isActive('bold')} title="Bold"><Bold size={15} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} isActive={editor.isActive('italic')} title="Italic"><Italic size={15} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().toggleUnderline().run()} isActive={editor.isActive('underline')} title="Underline"><UnderlineIcon size={15} /></ToolbarButton>
            <div className="w-px h-4 bg-stone-200 mx-0.5" />
            <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} isActive={editor.isActive('heading', { level: 2 })} title="H2"><Heading2 size={15} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} isActive={editor.isActive('heading', { level: 3 })} title="H3"><Heading3 size={15} /></ToolbarButton>
            <div className="w-px h-4 bg-stone-200 mx-0.5" />
            <ToolbarButton onClick={() => editor.chain().focus().toggleBulletList().run()} isActive={editor.isActive('bulletList')} title="List"><List size={15} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().toggleOrderedList().run()} isActive={editor.isActive('orderedList')} title="Numbers"><ListOrdered size={15} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().toggleBlockquote().run()} isActive={editor.isActive('blockquote')} title="Quote"><Quote size={15} /></ToolbarButton>
            <div className="w-px h-4 bg-stone-200 mx-0.5" />
            <ToolbarButton onClick={() => editor.chain().focus().setTextAlign('left').run()} isActive={editor.isActive({ textAlign: 'left' })} title="Left"><AlignLeft size={15} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().setTextAlign('center').run()} isActive={editor.isActive({ textAlign: 'center' })} title="Center"><AlignCenter size={15} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().setTextAlign('justify').run()} isActive={editor.isActive({ textAlign: 'justify' })} title="Justify"><AlignJustify size={15} /></ToolbarButton>
            <div className="w-px h-4 bg-stone-200 mx-0.5" />
            <ToolbarButton onClick={() => editor.chain().focus().undo().run()} title="Undo"><Undo size={15} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().redo().run()} title="Redo"><Redo size={15} /></ToolbarButton>
          </div>,
          document.getElementById('toolbar-portal') || document.body
        )}

        <div
          className="px-8 sm:px-12 md:px-16 py-12 md:py-20"
          style={{
            fontSize: `${editorZoom}%`,

          }}
        >
          <EditorContent editor={editor} />
        </div>

        {/* Stats Bar */}
        <div className="border-t border-[var(--border-subtle)] px-4 sm:px-8 py-3 flex items-center justify-between text-[11px] font-medium text-[var(--text-tertiary)] bg-[var(--surface-0)] rounded-b-sm">
          <div className="flex items-center gap-4 sm:gap-6">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
              {stats.words} words
            </span>
            <span className="hidden sm:inline">{stats.characters} chars</span>
            <span className="hidden md:inline">{stats.paragraphs} paragraphs</span>
          </div>
          <div className="flex items-center gap-3">
            {currentSectionTitle && (
              <span className="flex items-center gap-1.5 max-w-[160px] truncate" title={`In section: ${currentSectionTitle}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                <span className="truncate">{currentSectionTitle}</span>
              </span>
            )}
            {currentSectionTitle && onAnalyzeSection && (
              <button
                onClick={() => onAnalyzeSection(getSectionText(currentSectionTitle), currentSectionTitle)}
                className="flex items-center gap-1 px-2 py-0.5 rounded bg-stone-100 hover:bg-stone-200 transition-colors text-[10px] font-semibold"
                style={{ color: 'var(--text-secondary)' }}
                title={`Analyze "${currentSectionTitle}" section only`}
              >
                <Sparkles size={10} />
                Analyze Section
              </button>
            )}
            <span className="flex items-center gap-1.5"><Clock size={12} />{stats.readingTime} min read</span>
          </div>
        </div>
      </div>

      {/* Enhanced Bubble Menu — formatting + AI actions when text is selected */}
      <BubbleMenu editor={editor}>
        <div className="bg-stone-900 text-white rounded-xl shadow-2xl border border-stone-700 overflow-hidden" style={{ maxWidth: '480px' }}>
          {/* Formatting row */}
          <div className="flex items-center gap-0.5 p-1 border-b border-stone-700 flex-wrap">
            <button onClick={() => editor.chain().focus().toggleBold().run()} className={`p-1.5 rounded hover:bg-stone-800 ${editor.isActive('bold') ? 'text-blue-400' : ''}`}><Bold size={14} /></button>
            <button onClick={() => editor.chain().focus().toggleItalic().run()} className={`p-1.5 rounded hover:bg-stone-800 ${editor.isActive('italic') ? 'text-blue-400' : ''}`}><Italic size={14} /></button>
            <button onClick={() => editor.chain().focus().toggleUnderline().run()} className={`p-1.5 rounded hover:bg-stone-800 ${editor.isActive('underline') ? 'text-blue-400' : ''}`}><UnderlineIcon size={14} /></button>
            <div className="w-px h-4 bg-stone-700 mx-1" />
            {BUBBLE_ACTIONS.map(action => (
              <button
                key={action.label}
                onClick={() => {
                  const text = getSelectedText();
                  if (!text) return;
                  if (action.mode === 'transform' && onTransformSelection) {
                    onTransformSelection(text, action.instruction, action.agent);
                  } else {
                    handleSelectionSend(action.instruction, action.agent);
                  }
                }}
                className="px-2 py-1.5 rounded hover:bg-stone-800 text-[10px] font-medium flex items-center gap-1 whitespace-nowrap"
                title={`${action.label} — ${action.mode === 'transform' ? 'creates accept/reject suggestion' : 'opens in chat'}`}
              >
                <action.icon size={11} />
                {action.label}
              </button>
            ))}
            <div className="w-px h-4 bg-stone-700 mx-1" />
            <button
              onClick={() => { const text = getSelectedText(); if (text && onRewriteSection) onRewriteSection(text); }}
              className="px-2 py-1.5 rounded hover:bg-stone-800 text-[10px] font-medium flex items-center gap-1 whitespace-nowrap text-amber-400"
              title="Rewrite and get accept/reject suggestion"
            >
              <RefreshCw size={11} />
              Rewrite
            </button>
            <button
              onClick={() => { const text = getSelectedText(); if (text && onVerifyClaim) onVerifyClaim(text); }}
              className="px-2 py-1.5 rounded hover:bg-stone-800 text-[10px] font-medium flex items-center gap-1 whitespace-nowrap text-cyan-400"
              title="Verify this claim against uploaded PDF sources"
            >
              <FileSearch size={11} />
              Verify
            </button>
            <button
              onClick={() => { const text = getSelectedText(); if (text && onSearchSimilar) onSearchSimilar(text); }}
              className="px-2 py-1.5 rounded hover:bg-stone-800 text-[10px] font-medium flex items-center gap-1 whitespace-nowrap text-violet-400"
              title="Find similar published manuscripts for this selection"
            >
              <Search size={11} />
              Find Similar
            </button>
            {(() => {
              const sel = getSelectedText().trim();
              if (!sel || sel.includes(' ') || sel.length <= 1) return null;
              return (
                <button
                  onClick={handleThesaurus}
                  className="px-2 py-1.5 rounded hover:bg-stone-800 text-[10px] font-medium flex items-center gap-1 whitespace-nowrap text-green-400"
                  title="Find synonyms"
                >
                  <BookOpen size={11} />
                  Synonyms
                </button>
              );
            })()}
            <button
              onClick={() => { setShowSelectionBar(true); setTimeout(() => instructionInputRef.current?.focus(), 100); }}
              className="px-2 py-1.5 rounded hover:bg-stone-800 text-[10px] font-medium flex items-center gap-1"
              title="Custom instruction for selected text"
            >
              <MessageSquare size={11} />
              Ask AI
            </button>
          </div>

          {/* Thesaurus panel */}
          {thesaurusWord && (
            <div className="p-2 border-b border-stone-700">
              <div className="text-[9px] uppercase tracking-widest text-stone-400 mb-1.5">Synonyms for "{thesaurusWord}"</div>
              {thesaurusLoading ? (
                <span className="text-[11px] text-stone-400 animate-pulse">Looking up...</span>
              ) : thesaurusSynonyms.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {thesaurusSynonyms.map(syn => (
                    <button
                      key={syn}
                      onClick={() => replaceWithSynonym(syn)}
                      className="px-2 py-0.5 rounded bg-stone-700 hover:bg-stone-600 text-[11px] font-medium transition-colors"
                    >
                      {syn}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="text-[11px] text-stone-400">No synonyms found</span>
              )}
            </div>
          )}

          {/* Custom instruction input — shown when "Ask AI" clicked */}
          {showSelectionBar && (
            <div className="flex items-center gap-1 p-1.5">
              <select
                value={selectionAgent}
                onChange={e => setSelectionAgent(e.target.value as AgentType)}
                className="bg-stone-800 text-white text-[10px] rounded px-1.5 py-1 border border-stone-600 focus:outline-none"
              >
                <option value="editor">Language Surgeon</option>
                <option value="reviewer-2">Reviewer 2</option>
                <option value="researcher">Clarity & Impact</option>
                <option value="manager">Structure</option>
              </select>
              <input
                ref={instructionInputRef}
                value={selectionInstruction}
                onChange={e => setSelectionInstruction(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && selectionInstruction.trim()) handleSelectionSend(selectionInstruction, selectionAgent); }}
                placeholder="e.g. Make this more concise..."
                className="flex-1 bg-stone-800 text-white text-[11px] rounded px-2 py-1 border border-stone-600 focus:outline-none focus:border-stone-400 placeholder-stone-500 min-w-[160px]"
              />
              <button
                onClick={() => handleSelectionSend(selectionInstruction || 'Suggest improvements for this text.', selectionAgent)}
                className="p-1.5 rounded bg-blue-600 hover:bg-blue-500 transition-colors"
              >
                <Send size={12} />
              </button>
            </div>
          )}
        </div>
      </BubbleMenu>

      {/* @ Citation picker */}
      {citationPicker && isMounted && createPortal(
        <div
          className="fixed z-[9999] bg-white border rounded-xl shadow-xl overflow-hidden"
          style={{ left: Math.min(citationPicker.x, window.innerWidth - 280), top: citationPicker.y, width: 260, borderColor: 'var(--border)' }}
          onMouseDown={e => e.preventDefault()} // prevent blur
        >
          <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}>
            <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Insert Citation</p>
          </div>
          {filteredCitationSources.length === 0 ? (
            <p className="px-3 py-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>No sources — upload PDFs or find similar papers first.</p>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {filteredCitationSources.map(src => {
                const num = citationRegistry?.[src.id];
                const label = src.type === 'api'
                  ? (src.apiMeta?.authors?.split(/[,;]/)[0]?.trim() ?? src.name) + (src.apiMeta?.year ? `, ${src.apiMeta.year}` : '')
                  : src.name.replace(/\.pdf$/i, '');
                return (
                  <button
                    key={src.id}
                    className="w-full text-left px-3 py-2 hover:bg-stone-50 transition-colors border-b last:border-0"
                    style={{ borderColor: 'var(--border)' }}
                    onMouseDown={e => { e.preventDefault(); handleInsertCitation(src); }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold tabular-nums shrink-0 w-5 text-center rounded" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                        {num ?? '?'}
                      </span>
                      <span className="text-[11px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{label}</span>
                    </div>
                    {src.type === 'api' && src.apiMeta?.title && (
                      <p className="text-[10px] truncate pl-7" style={{ color: 'var(--text-muted)' }}>{src.apiMeta.title}</p>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <div className="px-3 py-1.5 border-t" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}>
            <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>Press Esc to close</p>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
});

export default Editor;
