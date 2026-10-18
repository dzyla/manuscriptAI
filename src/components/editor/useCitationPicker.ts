import { useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { ManuscriptSource } from '../../types';
import { expandCitationNums, fetchCrossrefDoi, looksLikeDoi, normalizeDoi } from '../../services/citations';
import { useSourceStore } from '../../stores/useSourceStore';

/**
 * The `@` citation picker's behaviour: typing `@` opens it at the caret, the text typed after the `@` filters the sources (or is read as one or
 * more DOIs), and choosing a source (or looking up a DOI) replaces the `@text` with a citation node. `open()` does the same from a menu: it
 * types the `@` itself. The picker is drawn by CitationPicker; this holds the state and the editor edits.
 */
export function useCitationPicker({ editor, sources, onInsertCitation }: {
  editor: Editor | null;
  sources?: ManuscriptSource[];
  onInsertCitation?: (sourceId: string) => number;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [filter, setFilter] = useState('');
  const filterRef = useRef('');
  const atInsertPos = useRef(-1);
  const openRef = useRef(false);
  openRef.current = !!at;
  const [doiState, setDoiState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [doiError, setDoiError] = useState<string | null>(null);
  const { sources: allSources, addSources } = useSourceStore();
  const lookupDoiRef = useRef<(doi: string) => void>(() => {});
  const lookupDoisRef = useRef<(dois: string[]) => void>(() => {});

  const close = () => { setAt(null); setFilter(''); filterRef.current = ''; setDoiState('idle'); setDoiError(null); };

  const showAt = (pos: number) => {
    atInsertPos.current = pos; // the '@' sits at this document position
    try {
      const coords = editor!.view.coordsAtPos(pos + 1);
      setFilter('');
      setAt({ x: coords.left, y: coords.bottom + 6 });
    } catch (_) { /* no layout yet: the picker simply does not open */ }
  };

  // `@` opens it; Escape closes it; Space inserts DOIs that are typed after the `@`.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom;
    const onKey = (e: KeyboardEvent) => {
      if (openRef.current) {
        if (e.key === 'Escape') close();
        if (e.key === ' ') {
          const parts = [...new Set(filterRef.current.split(',').map(p => normalizeDoi(p.trim())).filter(p => looksLikeDoi(p)))];
          if (parts.length > 0) {
            e.preventDefault();
            if (parts.length === 1) lookupDoiRef.current(parts[0]); else lookupDoisRef.current(parts);
          }
        }
        return;
      }
      if (e.key === '@') {
        const pos = editor.state.selection.from;
        // Delay so the '@' character is inserted first, then we know its position
        setTimeout(() => showAt(pos), 0);
      }
    };
    dom.addEventListener('keydown', onKey);
    return () => dom.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // While open, the filter is whatever was typed after the '@'.
  useEffect(() => {
    if (!at || !editor) return;
    const cur = editor.state.selection.from;
    const from = atInsertPos.current;
    if (cur > from) {
      const typed = editor.state.doc.textBetween(from, Math.min(cur, from + 40), '');
      const f = typed.replace(/^@/, '').toLowerCase();
      setFilter(f);
      filterRef.current = f;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor?.state.selection.from, at]);

  const chooseSource = (source: ManuscriptSource) => {
    if (!editor || !onInsertCitation) return;
    const num = onInsertCitation(source.id);
    const atPos = atInsertPos.current;
    const cur = editor.state.selection.from;

    // Delete the '@filter' typed text, leaving the cursor at atPos
    editor.chain().focus().deleteRange({ from: atPos, to: cur }).run();

    // An adjacent citation node that already holds this number: nothing more to insert
    const before = editor.state.doc.resolve(atPos).nodeBefore;
    if (before?.type.name === 'citation' && (before.attrs.nums ?? []).includes(num)) { close(); return; }
    // Legacy plain-text [N] groups too
    const textBefore = editor.state.doc.textBetween(Math.max(0, atPos - 50), atPos, '\n');
    const adjacent = textBefore.match(/\[([\d,\-]+)\]\s*$/);
    if (adjacent && expandCitationNums(adjacent[1]).includes(num)) { close(); return; }

    (editor.chain().focus() as any).insertCitation(source.id, num).run();
    close();
  };

  const lookupDoi = async (doi: string) => {
    const bare = normalizeDoi(doi);
    setDoiState('loading');
    setDoiError(null);
    try {
      let source = allSources.find(s => s.apiMeta?.doi?.toLowerCase() === bare.toLowerCase());
      if (!source) {
        source = await fetchCrossrefDoi(bare);
        addSources([source]);
      }
      chooseSource(source);
    } catch (err) {
      setDoiState('error');
      setDoiError(err instanceof Error ? err.message : 'DOI lookup failed.');
    }
  };

  const lookupDois = async (dois: string[]) => {
    if (!editor || !onInsertCitation) return;
    setDoiState('loading');
    setDoiError(null);
    // Snapshot positions before any awaits: the editor state may change during the fetch
    const atPos = atInsertPos.current;
    const cur = editor.state.selection.from;
    const results = await Promise.allSettled(dois.map(async (doi) => {
      let source = allSources.find(s => s.apiMeta?.doi?.toLowerCase() === doi.toLowerCase());
      if (!source) {
        source = await fetchCrossrefDoi(doi);
        addSources([source]);
      }
      return source;
    }));
    const ok = results.filter((r): r is PromiseFulfilledResult<ManuscriptSource> => r.status === 'fulfilled').map(r => r.value);
    const failed = dois.filter((_, i) => results[i].status === 'rejected');
    if (ok.length === 0) {
      setDoiState('error');
      setDoiError(`Could not fetch: ${failed.join(', ')}`);
      return;
    }
    const nums = ok.map(s => onInsertCitation(s.id));
    editor.chain().focus().deleteRange({ from: atPos, to: cur }).run();
    (editor.chain().focus() as any).insertCitationBatch(ok.map(s => s.id), nums).run();
    close();
    if (failed.length > 0) {
      console.warn('DOI batch: failed to fetch', failed.join(', '));
      setDoiError(`Inserted ${ok.length}; could not fetch: ${failed.join(', ')}`);
      setDoiState('error');
    }
  };

  // No dependency array on purpose: keeps the refs pointing at the latest closures
  useEffect(() => { lookupDoiRef.current = lookupDoi; lookupDoisRef.current = lookupDois; });

  const filtered = useMemo(() => {
    if (!sources) return [];
    const f = filter.trim();
    return sources.filter(s => s.type !== 'bib' && (
      !f || s.name.toLowerCase().includes(f) || s.apiMeta?.authors?.toLowerCase().includes(f) || s.apiMeta?.title?.toLowerCase().includes(f)
    ));
  }, [sources, filter]);

  /** Type the `@` at the caret (after any selection, never over it) and open the picker, as typing it would. */
  const open = () => {
    if (!editor || editor.isDestroyed) return;
    const pos = editor.state.selection.to;
    editor.chain().focus().setTextSelection(pos).insertContent('@').run();
    showAt(pos);
  };

  return { at, filter, filtered, doiState, doiError, chooseSource, lookupDoi, lookupDois, dismissError: () => { setDoiError(null); setDoiState('idle'); }, open };
}
