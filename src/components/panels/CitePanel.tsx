import { useEffect, useState } from 'react';
import { BookMarked, BookOpen, Search as SearchIcon } from 'lucide-react';
import type { AISettings, ManuscriptSource, SemanticSearchResult } from '../../types';
import { digestApiSource } from '../../services/ai';
import { useSourceStore } from '../../stores/useSourceStore';
import { Library } from './cite/Library';
import { Search } from './cite/Search';
import { ReferenceManager } from './cite/ReferenceManager';
import { useSourceUpload, type PendingPdfMatches } from './cite/useSourceUpload';
import { Section } from './Section';

export interface CitePanelProps {
  aiSettings?: AISettings;
  manuscriptContent?: string;
  documentHTML?: string;
  citationRegistry?: Record<string, number>;
  onRenumberCitations?: () => void;
  onRemoveCitation?: (sourceId: string) => void;
  onScrollToCitation?: (num: number) => void;
  /** Append HTML to the end of the manuscript. */
  onInsertHtml?: (html: string) => void;
  /** Called with the whole library each time it changes. */
  onSourcesChange?: (sources: ManuscriptSource[]) => void;
  /** Sources delivered by the host (e.g. from the editor's @ picker); merged in, de-duplicated by DOI, and summarised. */
  externalApiSources?: ManuscriptSource[];
  onExternalSourcesMerged?: () => void;
  /** Bumped when a new manuscript is started; the library empties. */
  clearSourcesTrigger?: number;
  /** The source being compared against the manuscript right now (the host runs the comparison and shows it in the chat). */
  analyzingSourceId?: string | null;
  onCompareSource: (source: ManuscriptSource) => void;
  onChatWithSource: (source: ManuscriptSource) => void;
}

/**
 * The Cite panel: the library of sources, the literature search, and the reference list. It stays mounted when another panel is open
 * (the host hides it), so a search, an upload or a digest in progress keeps running and its result lands.
 */
export function CitePanel(p: CitePanelProps) {
  const { aiSettings, manuscriptContent = '', externalApiSources, onExternalSourcesMerged, clearSourcesTrigger, onSourcesChange } = p;
  const { sources, addSources, updateSource, clearSources } = useSourceStore();
  const [open, setOpen] = useState({ library: true, search: false, references: false });
  const toggle = (k: keyof typeof open) => setOpen(o => ({ ...o, [k]: !o[k] }));
  // Pending PDF match confirmations: sourceId -> { results, matchIndex, scores? }
  const [pendingPdfMatches, setPendingPdfMatches] = useState<PendingPdfMatches>({});
  // Sources whose AI summary is being generated right now
  const [digestingApiIds, setDigestingApiIds] = useState<Set<string>>(new Set());
  const upload = useSourceUpload(aiSettings, setPendingPdfMatches);

  // Notify App.tsx of source changes (kept for backward compatibility while App.tsx is migrated)
  useEffect(() => {
    onSourcesChange?.(sources);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  /** Fire-and-forget digest of one source. */
  const digestInBackground = (src: ManuscriptSource) => {
    if (!aiSettings) return;
    setDigestingApiIds(prev => new Set([...prev, src.id]));
    digestApiSource(src.text, src.name, aiSettings)
      .then(digest => updateSource(src.id, { digest }))
      .catch(() => {})
      .finally(() => setDigestingApiIds(prev => { const n = new Set(prev); n.delete(src.id); return n; }));
  };

  const addSearchResult = (r: SemanticSearchResult, query: string) => {
    const src: ManuscriptSource = {
      id: `api-${Date.now()}-${Math.random()}`,
      name: r.title,
      type: 'api',
      text: r.abstract,
      apiMeta: r,
      queryText: query,
    };
    addSources([src]);
    digestInBackground(src);
  };

  // Merge API sources delivered by App.tsx and auto-generate AI summaries
  useEffect(() => {
    if (!externalApiSources?.length) return;

    // Deduplicate by DOI against existing store sources
    const existingDois = new Set(sources.map(s => s.apiMeta?.doi).filter(Boolean));
    const toAdd = externalApiSources.filter(s => !s.apiMeta?.doi || !existingDois.has(s.apiMeta.doi));
    if (toAdd.length) addSources(toAdd);
    onExternalSourcesMerged?.();

    // Fire-and-forget digest for each new source
    for (const src of externalApiSources) digestInBackground(src);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalApiSources]);

  // Clear all sources when a new manuscript is started
  useEffect(() => {
    if (!clearSourcesTrigger) return; // 0 = initial mount, skip
    clearSources();
    setPendingPdfMatches({});
  }, [clearSourcesTrigger]);

  const refCount = p.citationRegistry ? Object.keys(p.citationRegistry).length : 0;

  return (
    <div className="space-y-3"
      onDragOver={(e) => { e.preventDefault(); upload.setIsDragging(true); }}
      onDragLeave={(e) => { e.preventDefault(); upload.setIsDragging(false); }}
      onDrop={upload.handleFileDrop}
    >
      <Section id="library" label="Library" count={sources.length} icon={<BookOpen size={12} />} open={open.library} onToggle={() => toggle('library')}>
        <Library
          sources={sources}
          aiSettings={aiSettings}
          manuscriptContent={manuscriptContent}
          upload={upload}
          digestingApiIds={digestingApiIds}
          pendingMatches={pendingPdfMatches}
          onPendingMatchesChange={setPendingPdfMatches}
          analyzingSourceId={p.analyzingSourceId}
          onCompare={p.onCompareSource}
          onChat={p.onChatWithSource}
        />
      </Section>
      <Section id="search" label="Search" icon={<SearchIcon size={12} />} open={open.search} onToggle={() => toggle('search')}>
        <Search sources={sources} onAddResult={addSearchResult} />
      </Section>
      <Section id="references" label="References" count={refCount} icon={<BookMarked size={12} />} open={open.references} onToggle={() => toggle('references')}>
        <ReferenceManager
          sources={sources}
          citationRegistry={p.citationRegistry}
          documentHTML={p.documentHTML}
          onRenumberCitations={p.onRenumberCitations}
          onRemoveCitation={p.onRemoveCitation}
          onScrollToCitation={p.onScrollToCitation}
          onInsertHtml={p.onInsertHtml}
        />
      </Section>
    </div>
  );
}
