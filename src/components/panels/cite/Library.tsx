import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Sparkles, UploadCloud, FolderOpen, Hash, Plus } from 'lucide-react';
import type { AISettings, ManuscriptSource } from '../../../types';
import { fetchCrossrefDoi, normalizeDoi } from '../../../services/citations';
import { useSourceStore } from '../../../stores/useSourceStore';
import { SourceCard } from './SourceCard';
import type { PendingPdfMatches, SourceUpload } from './useSourceUpload';

export interface LibraryProps {
  sources: ManuscriptSource[];
  aiSettings?: AISettings;
  manuscriptContent: string;
  /** The file pipeline (CitePanel owns it so an upload keeps running while the panel is closed). */
  upload: SourceUpload;
  /** Sources whose summary is being generated right now. */
  digestingApiIds: Set<string>;
  pendingMatches: PendingPdfMatches;
  onPendingMatchesChange: Dispatch<SetStateAction<PendingPdfMatches>>;
  analyzingSourceId?: string | null;
  onCompare: (source: ManuscriptSource) => void;
  onChat: (source: ManuscriptSource) => void;
}

/** Everything uploaded or added to the manuscript: the drop zone, add-by-DOI, and one card per source. */
export function Library({ sources, aiSettings, manuscriptContent, upload, digestingApiIds, pendingMatches, onPendingMatchesChange, analyzingSourceId, onCompare, onChat }: LibraryProps) {
  const { addSources } = useSourceStore();
  const [doiInput, setDoiInput] = useState('');
  const [doiLoading, setDoiLoading] = useState(false);
  const [doiError, setDoiError] = useState<string | null>(null);

  const handleAddDoi = async () => {
    const doi = normalizeDoi(doiInput);
    if (!doi) return;
    // Check if DOI already in store
    const existing = sources.find(s => s.apiMeta?.doi?.toLowerCase() === doi.toLowerCase());
    if (existing) {
      setDoiError('This DOI is already in your sources.');
      return;
    }
    setDoiLoading(true);
    setDoiError(null);
    try {
      const source = await fetchCrossrefDoi(doi);
      addSources([source]);
      setDoiInput('');
    } catch (err) {
      setDoiError(err instanceof Error ? err.message : 'Failed to fetch DOI.');
    } finally {
      setDoiLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {(upload.isParsing || upload.digestingId || digestingApiIds.size > 0) && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border" style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}>
          <Sparkles className="animate-spin text-blue-500 shrink-0" size={14} />
          <div className="min-w-0">
            <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {upload.isParsing ? 'Parsing files...' : 'Generating AI summary...'}
            </span>
            {upload.parsingFileName && <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{upload.parsingFileName}</p>}
            {(upload.digestingId || digestingApiIds.size > 0) && !upload.parsingFileName && <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Summarizing in context of your manuscript</p>}
          </div>
        </div>
      )}
      {analyzingSourceId && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border" style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}>
          <Sparkles className="animate-spin text-violet-500 shrink-0" size={14} />
          <div className="min-w-0">
            <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>Comparing manuscripts...</span>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Literature Reviewer is analyzing support &amp; contradictions</p>
          </div>
        </div>
      )}
      <div
        className={`text-center py-6 border-2 border-dashed rounded-xl transition-colors cursor-pointer ${upload.isDragging ? 'border-blue-500 bg-blue-50/50' : 'hover:border-stone-400 hover:bg-stone-50/50'}`}
        style={{ borderColor: upload.isDragging ? 'var(--accent-blue)' : 'var(--border)' }}
        data-testid="control-dropzone"
        onClick={() => upload.fileUploadRef.current?.click()}
      >
        <UploadCloud size={24} className="mx-auto mb-2 opacity-50" style={{ color: 'var(--text-muted)' }} />
        <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Drop or click to upload sources</p>
        <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>PDF, .bib, .docx, .txt, .md — AI-digested automatically</p>
        <div className="mt-2 flex items-center justify-center gap-1.5">
          <button
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-semibold border transition-colors hover:bg-stone-100"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
            data-testid="control-upload"
            onClick={(e) => { e.stopPropagation(); upload.fileUploadRef.current?.click(); }}
          >
            <FolderOpen size={11} /> Browse files
          </button>
        </div>
      </div>
      <input
        ref={upload.fileUploadRef}
        type="file"
        accept=".pdf,.bib,.txt,.md,.docx"
        multiple
        className="hidden"
        onChange={upload.handleFileInput}
      />

      {/* Add by DOI */}
      <div className="border rounded-xl overflow-hidden" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}>
          <Hash size={12} style={{ color: 'var(--text-muted)' }} />
          <span className="text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>Add by DOI</span>
        </div>
        <div className="p-3 space-y-1.5">
          <div className="flex gap-1.5">
            <input
              value={doiInput}
              onChange={e => { setDoiInput(e.target.value); setDoiError(null); }}
              onKeyDown={e => { if (e.key === 'Enter') handleAddDoi(); }}
              placeholder="10.1234/journal.article"
              className="flex-1 text-[11px] px-2.5 py-1.5 border rounded-lg focus:outline-none font-mono"
              style={{ borderColor: doiError ? '#f87171' : 'var(--border)', background: 'var(--surface-0)', color: 'var(--text-primary)' }}
            />
            <button
              data-testid="control-doi"
              disabled={doiLoading || !doiInput.trim()}
              onClick={handleAddDoi}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-40"
              style={{ background: 'var(--accent-blue)', color: '#fff' }}
            >
              {doiLoading ? <Sparkles size={11} className="animate-spin" /> : <Plus size={11} />}
              {doiLoading ? '' : 'Add'}
            </button>
          </div>
          {doiError && (
            <p className="text-[10px] px-1" style={{ color: '#ef4444' }}>{doiError}</p>
          )}
        </div>
      </div>

      {sources.length === 0 && (
        <p className="text-[10px] text-center" style={{ color: 'var(--text-muted)' }}>No sources yet</p>
      )}

      {sources.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
            Sources ({sources.length})
            {sources.some(s => s.type === 'api') && (
              <span className="ml-1.5 normal-case font-medium" style={{ color: 'var(--accent-blue)' }}>
                · {sources.filter(s => s.type === 'api').length} from search
              </span>
            )}
          </h3>
          {sources.map((source) => (
            <SourceCard
              key={source.id}
              source={source}
              aiSettings={aiSettings}
              manuscriptContent={manuscriptContent}
              isDigesting={digestingApiIds.has(source.id)}
              digestingId={upload.digestingId}
              pendingMatches={pendingMatches}
              onPendingMatchesChange={onPendingMatchesChange}
              analyzingSourceId={analyzingSourceId}
              onRemove={() => {
                useSourceStore.getState().removeSource(source.id);
                onPendingMatchesChange(prev => { const { [source.id]: _, ...rest } = prev; return rest; });
              }}
              onCompare={onCompare}
              onChat={onChat}
            />
          ))}
        </div>
      )}
    </div>
  );
}
