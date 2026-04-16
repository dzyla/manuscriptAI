import { useEditor, EditorContent } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Link from '@tiptap/extension-link';
import { TableKit } from '@tiptap/extension-table';
import { forwardRef, useImperativeHandle, useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { AgentType, Suggestion, ManuscriptSource } from '../types';
import { GrammarChecker } from '../extensions/GrammarChecker';
import { ResizableImage } from '../extensions/ResizableImage';
import { CitationNode } from '../extensions/CitationNode';
import {
  Bold, Italic, Underline as UnderlineIcon, List, ListOrdered,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, Quote, Heading2,
  Heading3, Undo, Redo, Clock, Sparkles, PenLine, FlaskConical, Beaker, Send, MessageSquare, BookOpen, RefreshCw, FileSearch, Search,
  Table as TableIcon, ImagePlus, Menu, X, ScanEye, Trash2, ShieldCheck, Eye as EyeIcon, Wand2, Loader2
} from 'lucide-react';
import { getThesaurus, generateCompletion } from '../services/ai';
import { AISettings } from '../types';
import { AutoComplete } from '../extensions/AutoComplete';
import { NodeSelection } from 'prosemirror-state';
import { expandCitationNums } from '../services/citations';

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
  onAnalyzeImage?: (dataUrl: string, prompt: string, contextText?: string) => void;
}

export interface EditorRef {
  applySuggestion: (originalText: string, suggestedText: string) => boolean;
  revertSuggestion: (originalText: string, suggestedText: string) => boolean;
  scrollToSuggestion: (text: string, id: string) => void;
  getHTML: () => string;
  setContent: (html: string) => void;
  getSelectedText: () => string;
  getCurrentSection: () => string | null;
  getCurrentSectionText: () => string | null;
  scrollToHeading: (headingText: string) => void;
  scrollToCitation: (num: number) => void;
  getCitationOrder: () => string[];
  updateCitations: (registry: Record<string, number>) => void;
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

const Editor = forwardRef<EditorRef, EditorProps>(({ content, onChange, suggestions, onSuggestionClick, onSelectionQuery, onTransformSelection, onRewriteSection, onAnalyzeSection, onVerifyClaim, onSearchSimilar, sources, citationRegistry, onInsertCitation, isDistractionFree, editorZoom = 100, editorWidth = 'normal', aiSettings, onAnalyzeImage }, ref) => {
  const [isMounted, setIsMounted] = useState(false);
  const [showSelectionBar, setShowSelectionBar] = useState(false);
  const [selectionInstruction, setSelectionInstruction] = useState('');
  const [selectionAgent, setSelectionAgent] = useState<AgentType>('editor');
  const [thesaurusWord, setThesaurusWord] = useState<string | null>(null);
  const [thesaurusSynonyms, setThesaurusSynonyms] = useState<string[]>([]);
  const [thesaurusLoading, setThesaurusLoading] = useState(false);
  const [currentSectionTitle, setCurrentSectionTitle] = useState<string | null>(null);
  const [selectionWordCount, setSelectionWordCount] = useState(0);
  const isExternalUpdate = useRef(false);
  const lastExternalContent = useRef(content);
  const instructionInputRef = useRef<HTMLInputElement>(null);
  const [citationPicker, setCitationPicker] = useState<{ x: number; y: number } | null>(null);
  const [citationFilter, setCitationFilter] = useState('');
  const atInsertPos = useRef(-1);
  const showCitationPickerRef = useRef(false);
  showCitationPickerRef.current = !!citationPicker;
  const [showTablePicker, setShowTablePicker] = useState(false);
  const [tablePickerPos, setTablePickerPos] = useState<{ x: number; y: number } | null>(null);
  const [tableHover, setTableHover] = useState<{ rows: number; cols: number }>({ rows: 0, cols: 0 });
  const tableButtonRef = useRef<HTMLButtonElement>(null);
  const [tableContextMenu, setTableContextMenu] = useState<{ x: number; y: number } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [showToolbar, setShowToolbar] = useState(false);
  const selectedTextRef = useRef('');
  const [showAskInput, setShowAskInput] = useState(false);
  const [askInputValue, setAskInputValue] = useState('');
  const askInputRef = useRef<HTMLInputElement>(null);
  const [autocompleteEnabled, setAutocompleteEnabled] = useState(false);
  const [autocompleteLoading, setAutocompleteLoading] = useState(false);
  const autocompleteEnabledRef = useRef(false);
  const aiSettingsRef = useRef<AISettings | undefined>(aiSettings);

  useEffect(() => { setIsMounted(true); }, []);

  useEffect(() => { aiSettingsRef.current = aiSettings; }, [aiSettings]);
  useEffect(() => { autocompleteEnabledRef.current = autocompleteEnabled; }, [autocompleteEnabled]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({ placeholder: 'Start writing your manuscript here...' }),
      Highlight.configure({ multicolor: true }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Link.configure({ openOnClick: false }),
      GrammarChecker,
      TableKit.configure({ table: { resizable: true } }),
      ResizableImage,
      CitationNode,
      AutoComplete.configure({
        getEnabled: () => autocompleteEnabledRef.current,
        onSuggest: (contextText, signal) => {
          if (!aiSettingsRef.current) return Promise.resolve('');
          return generateCompletion(contextText, aiSettingsRef.current, signal);
        },
        onLoadingChange: setAutocompleteLoading,
      }),
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
      selectedTextRef.current = hasSelection ? editor.state.doc.textBetween(from, to, ' ') : '';
      setSelectionWordCount(
        hasSelection
          ? editor.state.doc.textBetween(from, to, ' ').trim().split(/\s+/).filter(Boolean).length
          : 0
      );
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

  // Close table picker on click outside
  useEffect(() => {
    if (!showTablePicker) return;
    const handler = (e: MouseEvent) => {
      const picker = document.getElementById('table-picker-portal');
      if (picker && !picker.contains(e.target as Node) &&
          tableButtonRef.current && !tableButtonRef.current.contains(e.target as Node)) {
        setShowTablePicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTablePicker]);

  // Right-click context menu for table editing
  useEffect(() => {
    if (!editor) return;
    const editorEl = editor.view.dom;
    const handleContextMenu = (e: MouseEvent) => {
      if (!editor.isActive('tableCell') && !editor.isActive('tableHeader')) return;
      e.preventDefault();
      setTableContextMenu({ x: e.clientX, y: e.clientY });
    };
    const handleMouseDown = (e: MouseEvent) => {
      if (tableContextMenu) {
        const menu = document.getElementById('table-context-menu');
        if (menu && !menu.contains(e.target as Node)) setTableContextMenu(null);
      }
    };
    editorEl.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      editorEl.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [editor, tableContextMenu]);

  const openTablePicker = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (showTablePicker) { setShowTablePicker(false); return; }
    const rect = tableButtonRef.current?.getBoundingClientRect();
    if (rect) setTablePickerPos({ x: rect.left, y: rect.bottom + 4 });
    setShowTablePicker(true);
  };

  const insertTable = (rows: number, cols: number) => {
    if (!editor) return;
    setShowTablePicker(false);
    setTableHover({ rows: 0, cols: 0 });
    // Delay to let picker close and allow editor to be ready
    setTimeout(() => {
      editor.commands.focus();
      editor.commands.insertTable({ rows, cols, withHeaderRow: true });
    }, 50);
  };

  const insertImageFromFile = async (file: File) => {
    if (!editor) return;
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    const base64 = btoa(binary);
    const dataUrl = `data:${file.type};base64,${base64}`;
    (editor.chain().focus() as any).insertResizableImage({ src: dataUrl, alt: file.name, width: '100%', align: 'center' }).run();
  };

  const getImageContext = (): string => {
    if (!editor) return '';
    const sel = editor.state.selection;

    // When the user clicks an image, TipTap creates a NodeSelection.
    if (sel instanceof NodeSelection) {
      const doc = editor.state.doc;
      const imagePos = sel.from;
      const clickedNode = doc.nodeAt(imagePos);
      if (!clickedNode || clickedNode.type.name !== 'resizableImage') return '';

      // Pass 1 (caption-aware): look for adjacent "Figure X…" paragraphs.
      let captionBefore = '';
      let captionAfter = '';
      doc.descendants((node, pos) => {
        if (node.type.name !== 'paragraph') return true;
        const text = node.textContent.trim();
        if (!/^figure/i.test(text)) return true;
        const nodeEnd = pos + node.nodeSize;
        if (nodeEnd <= imagePos) {
          captionBefore = text; // keep overwriting — last before image wins (nearest)
        } else if (pos > imagePos && !captionAfter) {
          captionAfter = text; // first after image wins (nearest)
        }
        return true;
      });
      const caption = captionAfter || captionBefore;
      if (caption) return caption;

      // Pass 2 (surrounding paragraphs): nearest preceding + following paragraph.
      let preceding = '';
      let following = '';
      doc.descendants((node, pos) => {
        if (node.type.name !== 'paragraph') return true;
        const text = node.textContent.trim();
        if (!text) return true;
        const nodeEnd = pos + node.nodeSize;
        if (nodeEnd <= imagePos) {
          preceding = text;
        } else if (pos > imagePos && !following) {
          following = text; // first one after image
        }
        return true;
      });
      return [preceding, following].filter(Boolean).join('\n').trim();
    }

    // Text selection path — user dragged over image + surrounding text.
    const { from, to } = sel;
    if (from === to) return '';
    const parts: string[] = [];
    editor.state.doc.nodesBetween(from, to, node => {
      if (node.type.name === 'resizableImage') return false;
      if (node.isText && node.text) parts.push(node.text);
      return true;
    });
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };

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

    // Delete the '@filter' typed text, leaving cursor at atPos
    editor.chain().focus().deleteRange({ from: atPos, to: curPos }).run();

    // Check for an adjacent CitationNode immediately before the cursor that already contains this num.
    const nodeBefore = editor.state.doc.resolve(atPos).nodeBefore;
    if (nodeBefore?.type.name === 'citation') {
      const existingNums: number[] = nodeBefore.attrs.nums ?? [];
      if (existingNums.includes(num)) {
        setCitationPicker(null);
        setCitationFilter('');
        return;
      }
    }

    // Also check legacy [N] text groups for backward compat
    const textBefore = editor.state.doc.textBetween(Math.max(0, atPos - 50), atPos, '\n');
    const adjacentMatch = textBefore.match(/\[([\d,\-]+)\]\s*$/);
    if (adjacentMatch && expandCitationNums(adjacentMatch[1]).includes(num)) {
      setCitationPicker(null);
      setCitationFilter('');
      return;
    }

    (editor.chain().focus() as any).insertCitation(source.id, num).run();
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
    getCurrentSectionText: () => currentSectionTitle ? getSectionText(currentSectionTitle) : null,
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
    scrollToCitation: (num: number) => {
      if (!editor) return;
      let targetPos: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (targetPos !== null) return false;
        // CitationNode atom: check nums attribute
        if (node.type.name === 'citation') {
          const nums: number[] = node.attrs.nums ?? [];
          if (nums.includes(num)) { targetPos = pos; return false; }
        }
        // Legacy plain-text citations: [1], [1-3], [1,2]
        if (node.isText && node.text) {
          const pat = /\[([\d,\-]+)\]/g;
          let m;
          while ((m = pat.exec(node.text)) !== null) {
            if (expandCitationNums(m[1]).includes(num)) {
              targetPos = pos + m.index;
              return false;
            }
          }
        }
        return true;
      });
      if (targetPos !== null) {
        editor.chain().focus().setTextSelection(targetPos).scrollIntoView().run();
        setTimeout(() => {
          const coords = editor.view.coordsAtPos(targetPos!);
          if (coords) {
            const scrollParent = editor.view.dom.closest('.overflow-y-auto') || editor.view.dom.parentElement?.closest('.overflow-y-auto');
            if (scrollParent) {
              const rect = scrollParent.getBoundingClientRect();
              const targetY = coords.top - rect.top + scrollParent.scrollTop - scrollParent.clientHeight / 3;
              scrollParent.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
            }
          }
        }, 50);
      }
    },
    getCitationOrder: () => {
      if (!editor) return [];
      const seen = new Set<string>();
      const order: string[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name !== 'citation') return true;
        const sourceIds: string[] = node.attrs.sourceIds ?? [];
        for (const id of sourceIds) {
          if (!seen.has(id)) { seen.add(id); order.push(id); }
        }
        return true;
      });
      return order;
    },
    updateCitations: (registry: Record<string, number>) => {
      if (!editor) return;
      editor.commands.updateAllCitationNums(registry);
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

  const ToolbarButton = ({ onClick, onMouseDown, isActive = false, children, title }: any) => (
    <button
      onClick={onClick}
      onMouseDown={onMouseDown}
      title={title}
      className="p-1.5 rounded transition-colors shrink-0"
      style={{
        background: isActive ? 'var(--surface-3, var(--surface-2))' : 'transparent',
        color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
        outline: isActive ? '1px solid var(--border)' : 'none',
      }}
      onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-2)'; }}
      onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
    >{children}</button>
  );

  const widthClass = editorWidth === 'wide' ? 'max-w-6xl' : editorWidth === 'full' ? 'max-w-none' : 'max-w-4xl';

  return (
    <div className={`w-full ${widthClass} mx-auto ${isDistractionFree ? 'focus-mode' : ''}`}>
      <div className="bg-[var(--editor-bg)] min-h-[600px] shadow-[var(--editor-shadow)] rounded-sm border border-[var(--border-subtle)] transition-colors duration-300">
        
        {/* Sticky Toolbar */}
        <div className="sticky top-0 z-20 flex flex-col" style={{ background: 'var(--surface-1)', borderBottom: '1px solid var(--border)' }}>
          {/* Mobile toggle row */}
          <div className="flex sm:hidden items-center justify-between px-2 py-1">
            <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Toolbar</span>
            <button
              onMouseDown={e => e.preventDefault()}
              onClick={() => setShowToolbar(p => !p)}
              className="p-1.5 rounded hover:bg-stone-100 transition-colors"
              style={{ color: 'var(--text-secondary)' }}
            >
              {showToolbar ? <X size={14} /> : <Menu size={14} />}
            </button>
          </div>
          {/* Toolbar buttons — always visible on sm+, toggled on mobile */}
          <div className={`${showToolbar ? 'flex' : 'hidden'} sm:flex items-center gap-0.5 px-2 py-1 overflow-x-auto`} style={{ scrollbarWidth: 'none' }}>
            <ToolbarButton onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); editor.chain().focus().toggleBold().run(); }} isActive={editor.isActive('bold')} title="Bold"><Bold size={14} /></ToolbarButton>
            <ToolbarButton onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); editor.chain().focus().toggleItalic().run(); }} isActive={editor.isActive('italic')} title="Italic"><Italic size={14} /></ToolbarButton>
            <ToolbarButton onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); editor.chain().focus().toggleUnderline().run(); }} isActive={editor.isActive('underline')} title="Underline"><UnderlineIcon size={14} /></ToolbarButton>
            <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--border)' }} />
            <ToolbarButton onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 2 }).run(); }} isActive={editor.isActive('heading', { level: 2 })} title="Heading 2"><Heading2 size={14} /></ToolbarButton>
            <ToolbarButton onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 3 }).run(); }} isActive={editor.isActive('heading', { level: 3 })} title="Heading 3"><Heading3 size={14} /></ToolbarButton>
            <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--border)' }} />
            <ToolbarButton onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); editor.chain().focus().toggleBulletList().run(); }} isActive={editor.isActive('bulletList')} title="Bullet list"><List size={14} /></ToolbarButton>
            <ToolbarButton onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); editor.chain().focus().toggleOrderedList().run(); }} isActive={editor.isActive('orderedList')} title="Numbered list"><ListOrdered size={14} /></ToolbarButton>
            <ToolbarButton onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); editor.chain().focus().toggleBlockquote().run(); }} isActive={editor.isActive('blockquote')} title="Blockquote"><Quote size={14} /></ToolbarButton>
            <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--border)' }} />
            <ToolbarButton onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); editor.chain().focus().setTextAlign('left').run(); }} isActive={editor.isActive({ textAlign: 'left' })} title="Align left"><AlignLeft size={14} /></ToolbarButton>
            <ToolbarButton onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); editor.chain().focus().setTextAlign('center').run(); }} isActive={editor.isActive({ textAlign: 'center' })} title="Center"><AlignCenter size={14} /></ToolbarButton>
            <ToolbarButton onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); editor.chain().focus().setTextAlign('justify').run(); }} isActive={editor.isActive({ textAlign: 'justify' })} title="Justify"><AlignJustify size={14} /></ToolbarButton>
            <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--border)' }} />
            {/* Table picker button */}
            <button
              ref={tableButtonRef}
              onMouseDown={openTablePicker}
              title="Insert table"
              className="p-1.5 rounded transition-colors shrink-0"
              style={{
                background: showTablePicker ? 'var(--surface-2)' : 'transparent',
                color: showTablePicker ? 'var(--text-primary)' : 'var(--text-secondary)',
                outline: showTablePicker ? '1px solid var(--border)' : 'none',
              }}
            >
              <TableIcon size={14} />
            </button>
            {/* Image insert */}
            <div className="shrink-0">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) { insertImageFromFile(file); e.target.value = ''; }
                }}
              />
              <ToolbarButton onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); imageInputRef.current?.click(); }} title="Insert figure / image"><ImagePlus size={14} /></ToolbarButton>
            </div>
            <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--border)' }} />
            <ToolbarButton onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); editor.chain().focus().undo().run(); }} title="Undo"><Undo size={14} /></ToolbarButton>
            <ToolbarButton onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); editor.chain().focus().redo().run(); }} title="Redo"><Redo size={14} /></ToolbarButton>
            <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--border)' }} />
            <ToolbarButton
              onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); setAutocompleteEnabled(v => !v); }}
              title={autocompleteEnabled ? 'Autocomplete on (Tab to accept)' : 'Autocomplete off'}
              isActive={autocompleteEnabled}
            >
              {autocompleteLoading
                ? <Loader2 size={14} className="animate-spin" />
                : <Wand2 size={14} />}
            </ToolbarButton>
          </div>
        </div>

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
      <BubbleMenu
        editor={editor}
        options={{ placement: 'top', offset: 10 }}
        shouldShow={({ editor: e, from, to }) => {
          if (e.isActive('resizableImage')) return false;
          // Suppress text menu if selection spans an image node
          let hasImg = false;
          if (from !== to) e.state.doc.nodesBetween(from, to, n => { if (n.type.name === 'resizableImage') { hasImg = true; return false; } return true; });
          return !hasImg && from !== to;
        }}
      >
        <div className="bg-stone-900 text-white rounded-xl shadow-2xl border border-stone-700 overflow-hidden" style={{ maxWidth: '480px' }}>
          {/* Formatting row */}
          <div className="flex items-center gap-0.5 p-1 border-b border-stone-700 flex-wrap">
            <button onMouseDown={e => { e.preventDefault(); editor.chain().focus().toggleBold().run(); }} className={`p-1.5 rounded hover:bg-stone-800 ${editor.isActive('bold') ? 'text-blue-400' : ''}`}><Bold size={14} /></button>
            <button onMouseDown={e => { e.preventDefault(); editor.chain().focus().toggleItalic().run(); }} className={`p-1.5 rounded hover:bg-stone-800 ${editor.isActive('italic') ? 'text-blue-400' : ''}`}><Italic size={14} /></button>
            <button onMouseDown={e => { e.preventDefault(); editor.chain().focus().toggleUnderline().run(); }} className={`p-1.5 rounded hover:bg-stone-800 ${editor.isActive('underline') ? 'text-blue-400' : ''}`}><UnderlineIcon size={14} /></button>
            <div className="w-px h-4 bg-stone-700 mx-1" />
            {BUBBLE_ACTIONS.map(action => (
              <button
                key={action.label}
                onMouseDown={e => {
                  e.preventDefault();
                  const text = selectedTextRef.current || getSelectedText();
                  if (!text) return;
                  if (action.mode === 'transform' && onTransformSelection) {
                    onTransformSelection(text, action.instruction, action.agent);
                  } else {
                    onSelectionQuery?.(text, action.instruction, action.agent);
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
              onMouseDown={e => { e.preventDefault(); const text = selectedTextRef.current || getSelectedText(); if (text && onRewriteSection) onRewriteSection(text); }}
              className="px-2 py-1.5 rounded hover:bg-stone-800 text-[10px] font-medium flex items-center gap-1 whitespace-nowrap text-amber-400"
              title="Rewrite and get accept/reject suggestion"
            >
              <RefreshCw size={11} />
              Rewrite
            </button>
            <button
              onMouseDown={e => { e.preventDefault(); const text = selectedTextRef.current || getSelectedText(); if (text && onVerifyClaim) onVerifyClaim(text); }}
              className="px-2 py-1.5 rounded hover:bg-stone-800 text-[10px] font-medium flex items-center gap-1 whitespace-nowrap text-cyan-400"
              title="Verify this claim against uploaded PDF sources"
            >
              <FileSearch size={11} />
              Verify
            </button>
            {selectionWordCount > 5 && (
              <button
                onMouseDown={e => { e.preventDefault(); const text = selectedTextRef.current || getSelectedText(); if (text && onSearchSimilar) onSearchSimilar(text); }}
                className="px-2 py-1.5 rounded hover:bg-stone-800 text-[10px] font-medium flex items-center gap-1 whitespace-nowrap text-violet-400"
                title="Find similar published manuscripts for this selection"
              >
                <Search size={11} />
                Find Similar
              </button>
            )}
            {selectionWordCount >= 1 && selectionWordCount <= 2 && (
              <button
                onMouseDown={e => { e.preventDefault(); handleThesaurus(); }}
                className="px-2 py-1.5 rounded hover:bg-stone-800 text-[10px] font-medium flex items-center gap-1 whitespace-nowrap text-green-400"
                title="Find synonyms / alternatives"
              >
                <BookOpen size={11} />
                Synonyms
              </button>
            )}
            <button
              onMouseDown={e => { e.preventDefault(); setShowSelectionBar(true); setTimeout(() => instructionInputRef.current?.focus(), 100); }}
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
                onMouseDown={e => { e.preventDefault(); handleSelectionSend(selectionInstruction || 'Suggest improvements for this text.', selectionAgent); }}
                className="p-1.5 rounded bg-blue-600 hover:bg-blue-500 transition-colors"
              >
                <Send size={12} />
              </button>
            </div>
          )}
        </div>
      </BubbleMenu>

      {/* Image / Figure BubbleMenu — shows when image is selected, or when selection spans an image */}
      <BubbleMenu
        editor={editor}
        shouldShow={({ editor: e, from, to }) => {
          if (e.isActive('resizableImage')) return true;
          let hasImg = false;
          e.state.doc.nodesBetween(from, to, n => { if (n.type.name === 'resizableImage') { hasImg = true; return false; } return true; });
          return hasImg;
        }}
        options={{ placement: 'top', offset: 8 }}
      >
        <div className="bg-stone-900 text-white rounded-xl shadow-2xl border border-stone-700 overflow-hidden" style={{ maxWidth: '520px' }}>
          {/* Row 1: layout controls */}
          <div className="flex items-center gap-0.5 p-1.5 border-b border-stone-700 flex-wrap">
            <span className="text-[9px] uppercase tracking-widest text-stone-500 px-1">Align</span>
            {(['left', 'center', 'right'] as const).map(a => (
              <button
                key={a}
                onMouseDown={e => { e.preventDefault(); editor.commands.updateAttributes('resizableImage', { align: a }); }}
                className={`px-2 py-1 rounded text-[10px] transition-colors ${editor.getAttributes('resizableImage').align === a ? 'bg-stone-600' : 'hover:bg-stone-700'}`}
                title={`Align ${a}`}
              >
                {a === 'left' ? '◧' : a === 'center' ? '▣' : '◨'}
              </button>
            ))}
            <div className="w-px h-4 bg-stone-700 mx-1 shrink-0" />
            <span className="text-[9px] uppercase tracking-widest text-stone-500 px-1">Size</span>
            {([['S', '25%'], ['M', '50%'], ['L', '75%'], ['Full', '100%']] as const).map(([label, w]) => (
              <button
                key={label}
                onMouseDown={e => { e.preventDefault(); editor.commands.updateAttributes('resizableImage', { width: w }); }}
                className="px-2 py-1 rounded text-[10px] hover:bg-stone-700 transition-colors"
                title={`Set width to ${w}`}
              >
                {label}
              </button>
            ))}
            <div className="w-px h-4 bg-stone-700 mx-1 shrink-0" />
            <button
              onMouseDown={e => { e.preventDefault(); editor.chain().focus().deleteSelection().run(); }}
              className="px-2 py-1 rounded text-[10px] hover:bg-rose-700 transition-colors text-rose-400"
              title="Delete figure"
            >
              <Trash2 size={11} />
            </button>
          </div>
          {/* Row 2: AI actions */}
          <div className="flex items-center gap-0.5 p-1.5 flex-wrap">
            <span className="text-[9px] uppercase tracking-widest text-stone-500 px-1 shrink-0">Figure AI</span>
            {/* Visual description — what you literally see */}
            <button
              onMouseDown={e => {
                e.preventDefault();
                const attrs = editor.getAttributes('resizableImage');
                if (!attrs.src || !onAnalyzeImage) return;
                onAnalyzeImage(
                  attrs.src,
                  'Describe what you can see in this figure purely visually: shapes, colors, spatial layout, objects, text labels, axes, legends, and any other visible elements. Do not interpret the scientific meaning — focus only on what is visually present.',
                  getImageContext()
                );
              }}
              className="px-2 py-1 rounded text-[10px] hover:bg-stone-700 transition-colors flex items-center gap-1 text-sky-400"
              title="Visual description of what is seen in the figure"
            >
              <EyeIcon size={11} />
              Describe
            </button>
            {/* Integrity check — quality, spelling, colors, readability */}
            <button
              onMouseDown={e => {
                e.preventDefault();
                const attrs = editor.getAttributes('resizableImage');
                if (!attrs.src || !onAnalyzeImage) return;
                onAnalyzeImage(
                  attrs.src,
                  'Review this figure for visual integrity and quality issues. Check: (1) Is the resolution sufficient for publication? (2) Are all text labels, axis titles, and legends readable? (3) Check spelling of any text visible in the figure. (4) Are colors distinguishable (colorblind-friendly)? (5) Are there any visual artifacts, blurriness, or distortions? (6) Are axes properly labeled with units? (7) Is the overall layout clear and uncluttered? List each issue found with a specific recommendation.',
                  getImageContext()
                );
              }}
              className="px-2 py-1 rounded text-[10px] hover:bg-stone-700 transition-colors flex items-center gap-1 text-emerald-400"
              title="Check figure quality, spelling, colors, readability"
            >
              <ShieldCheck size={11} />
              Integrity
            </button>
            {/* Manuscript review — how well it supports the surrounding text */}
            <button
              onMouseDown={e => {
                e.preventDefault();
                const attrs = editor.getAttributes('resizableImage');
                if (!attrs.src || !onAnalyzeImage) return;
                onAnalyzeImage(
                  attrs.src,
                  'Review this figure in the context of the surrounding manuscript text. Does the figure clearly support the claims made in the text? Is it self-explanatory? Would a peer reviewer find it clear and convincing? What improvements would make it more effective for the manuscript?',
                  getImageContext()
                );
              }}
              className="px-2 py-1 rounded text-[10px] hover:bg-stone-700 transition-colors flex items-center gap-1 text-amber-400"
              title="Review figure relevance and clarity in context of manuscript"
            >
              <FlaskConical size={11} />
              Review
            </button>
            {/* Ask / custom */}
            <button
              onMouseDown={e => {
                e.preventDefault();
                setShowAskInput(p => !p);
                setAskInputValue('');
                setTimeout(() => askInputRef.current?.focus(), 50);
              }}
              className={`px-2 py-1 rounded text-[10px] transition-colors flex items-center gap-1 text-violet-400 ${showAskInput ? 'bg-stone-700' : 'hover:bg-stone-700'}`}
              title="Ask a custom question about this figure"
            >
              <MessageSquare size={11} />
              Ask
            </button>
          </div>
          {/* Inline ask input */}
          {showAskInput && (
            <div className="flex items-center gap-1 px-1.5 pb-1.5">
              <input
                ref={askInputRef}
                value={askInputValue}
                onChange={e => setAskInputValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && askInputValue.trim()) {
                    e.preventDefault();
                    const attrs = editor.getAttributes('resizableImage');
                    if (attrs.src && onAnalyzeImage) {
                      onAnalyzeImage(attrs.src, askInputValue.trim(), getImageContext() || undefined);
                    }
                    setShowAskInput(false);
                    setAskInputValue('');
                  } else if (e.key === 'Escape') {
                    setShowAskInput(false);
                    setAskInputValue('');
                  }
                }}
                placeholder="Ask about this figure… (Enter to send)"
                className="flex-1 bg-stone-800 text-white text-[11px] rounded px-2 py-1 border border-stone-600 focus:outline-none focus:border-stone-400 placeholder-stone-500 min-w-[200px]"
              />
              <button
                onMouseDown={e => {
                  e.preventDefault();
                  if (!askInputValue.trim()) return;
                  const attrs = editor.getAttributes('resizableImage');
                  if (attrs.src && onAnalyzeImage) {
                    onAnalyzeImage(attrs.src, askInputValue.trim(), getImageContext() || undefined);
                  }
                  setShowAskInput(false);
                  setAskInputValue('');
                }}
                className="p-1.5 rounded bg-violet-600 hover:bg-violet-500 transition-colors"
              >
                <Send size={11} />
              </button>
            </div>
          )}
          {/* Context hint — only show when text is selected around the figure */}
          {getImageContext().length > 0 && (
            <div className="px-2 pb-1.5">
              <p className="text-[9px] text-stone-500">
                Context: "{getImageContext().substring(0, 70)}{getImageContext().length > 70 ? '…' : ''}"
              </p>
            </div>
          )}
        </div>
      </BubbleMenu>

      {/* Table grid picker — position:fixed escapes overflow clipping */}
      {showTablePicker && tablePickerPos && (
        <div
          id="table-picker-portal"
          className="rounded-lg shadow-xl p-2.5"
          style={{
            position: 'fixed',
            zIndex: 9999,
            left: tablePickerPos.x,
            top: tablePickerPos.y,
            background: 'var(--surface-1)',
            border: '1px solid var(--border)',
          }}
          onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
        >
          <p className="text-[9px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-muted)' }}>
            {tableHover.rows > 0 ? `${tableHover.rows} × ${tableHover.cols} table` : 'Insert table'}
          </p>
          <div style={{ display: 'grid', gap: '4px', gridTemplateColumns: 'repeat(6, 20px)' }}>
            {(() => {
              const cells = [];
              for (let r = 0; r < 6; r++) {
                for (let c = 0; c < 6; c++) {
                  const highlighted = r < tableHover.rows && c < tableHover.cols;
                  cells.push(
                    <div
                      key={`${r}-${c}`}
                      onMouseEnter={() => setTableHover({ rows: r + 1, cols: c + 1 })}
                      onMouseLeave={() => setTableHover({ rows: 0, cols: 0 })}
                      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); insertTable(r + 1, c + 1); }}
                      style={{
                        width: 20,
                        height: 20,
                        border: `1px solid ${highlighted ? 'var(--accent-blue)' : 'var(--border)'}`,
                        background: highlighted ? 'rgba(59,111,212,0.2)' : 'var(--surface-2)',
                        borderRadius: 2,
                        cursor: 'pointer',
                      }}
                    />
                  );
                }
              }
              return cells;
            })()}
          </div>
        </div>
      )}

      {/* Table right-click context menu */}
      {tableContextMenu && (
        <div
          id="table-context-menu"
          style={{
            position: 'fixed',
            zIndex: 9999,
            left: tableContextMenu.x,
            top: tableContextMenu.y,
            background: 'var(--surface-1)',
            border: '1.5px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
            minWidth: 160,
            overflow: 'hidden',
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
            <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Table</span>
          </div>
          {[
            { label: 'Add column before', icon: '←', cmd: () => editor.chain().focus().addColumnBefore().run(), danger: false },
            { label: 'Add column after',  icon: '→', cmd: () => editor.chain().focus().addColumnAfter().run(), danger: false },
            { label: 'Add row above',     icon: '↑', cmd: () => editor.chain().focus().addRowBefore().run(), danger: false },
            { label: 'Add row below',     icon: '↓', cmd: () => editor.chain().focus().addRowAfter().run(), danger: false },
            null,
            { label: 'Delete column', icon: '×', cmd: () => editor.chain().focus().deleteColumn().run(), danger: true },
            { label: 'Delete row',    icon: '×', cmd: () => editor.chain().focus().deleteRow().run(), danger: true },
            { label: 'Delete table',  icon: '⊠', cmd: () => editor.chain().focus().deleteTable().run(), danger: true },
          ].map((item, i) => item === null
            ? <div key={i} className="border-t my-0.5" style={{ borderColor: 'var(--border)' }} />
            : (
              <button
                key={item.label}
                onMouseDown={e => { e.preventDefault(); item.cmd(); setTableContextMenu(null); }}
                className="w-full text-left flex items-center gap-2.5 px-3 py-1.5 text-[12px] transition-colors"
                style={{ color: item.danger ? '#e11d48' : 'var(--text-primary)', background: 'transparent' }}
                onMouseEnter={e => (e.currentTarget.style.background = item.danger ? 'rgba(225,29,72,0.08)' : 'var(--surface-2)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span className="w-4 text-center font-bold shrink-0" style={{ color: item.danger ? '#e11d48' : 'var(--accent-blue)', fontSize: 13 }}>{item.icon}</span>
                {item.label}
              </button>
            )
          )}
        </div>
      )}

      {/* @ Citation picker */}
      {citationPicker && isMounted && createPortal(
        <div
          className="fixed z-[9999] rounded-xl shadow-2xl overflow-hidden"
          style={{
            left: Math.min(citationPicker.x, window.innerWidth - 280),
            top: citationPicker.y,
            width: 260,
            background: 'var(--surface-1)',
            border: '1.5px solid var(--border)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          }}
          onMouseDown={e => e.preventDefault()}
        >
          <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
            <BookOpen size={10} style={{ color: 'var(--accent-blue)' }} />
            <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Insert Citation</p>
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
                    className="w-full text-left px-3 py-2 border-b last:border-0 transition-colors"
                    style={{ borderColor: 'var(--border)', background: 'transparent' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    onMouseDown={e => { e.preventDefault(); handleInsertCitation(src); }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold tabular-nums shrink-0 w-5 h-5 flex items-center justify-center rounded-md" style={{ background: 'var(--accent-blue)', color: '#fff' }}>
                        {num ?? '?'}
                      </span>
                      <span className="text-[11px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{label}</span>
                    </div>
                    {src.type === 'api' && src.apiMeta?.title && (
                      <p className="text-[10px] truncate pl-7 mt-0.5" style={{ color: 'var(--text-muted)' }}>{src.apiMeta.title}</p>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <div className="px-3 py-1.5 border-t" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
            <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>Press Esc to close</p>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
});

export default Editor;
