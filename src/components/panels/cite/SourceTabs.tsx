import { useState } from 'react';
import { ExternalLink, BookMarked, Copy, RefreshCw, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AISettings, ManuscriptSource } from '../../../types';
import { resultToBibtex, doiToUrl } from '../../../services/manuscriptSearch';
import { digestApiSource, extractPdfAbstractAea } from '../../../services/ai';
import { useSourceStore } from '../../../stores/useSourceStore';

/** Re-summarise and re-extract-abstract for one source, each with its own "in progress" flag. */
function useDigestActions(source: ManuscriptSource, aiSettings: AISettings | undefined) {
  const { updateSource } = useSourceStore();
  const [reDigesting, setReDigesting] = useState(false);
  const [extractingAbstract, setExtractingAbstract] = useState(false);

  const extract = async () => {
    if (!aiSettings || extractingAbstract) return;
    setExtractingAbstract(true);
    try {
      const abstractText = await extractPdfAbstractAea(source.text ?? '', source.name, aiSettings);
      updateSource(source.id, { abstractText });
    } catch (_) {
      updateSource(source.id, { abstractText: 'Abstract not available.' });
    }
    setExtractingAbstract(false);
  };

  const reDigest = async () => {
    if (!aiSettings || reDigesting) return;
    setReDigesting(true);
    try {
      const digest = await digestApiSource(source.text ?? '', source.name, aiSettings);
      updateSource(source.id, { digest });
    } catch (_) {}
    setReDigesting(false);
  };

  return { reDigesting, extractingAbstract, extract, reDigest };
}

export interface ApiSourceDetailsProps {
  source: ManuscriptSource;
  aiSettings?: AISettings;
  /** The summary is being generated right now (the search result was just added). */
  isDigesting: boolean;
  analyzingSourceId?: string | null;
  onCompare: (source: ManuscriptSource) => void;
}

/** A source found by search: its record, a Summary / Abstract switch, Copy BibTeX and Compare. */
export function ApiSourceDetails({ source, aiSettings, isDigesting, analyzingSourceId, onCompare }: ApiSourceDetailsProps) {
  const m = source.apiMeta!;
  const doiUrl = m.doi ? doiToUrl(m.doi) : null;
  const [activeTab, setActiveTab] = useState<'summary' | 'abstract'>('summary');
  const { reDigesting, reDigest } = useDigestActions(source, aiSettings);

  return (
    <div className="space-y-0">
      {/* Meta row: authors, journal, DOI, query */}
      <div className="px-3 pb-2 space-y-1">
        {source.queryText && (
          <p className="text-[9px] italic truncate" style={{ color: 'var(--text-muted)' }} title={`Query: ${source.queryText}`}>
            Query: "{source.queryText.slice(0, 60)}{source.queryText.length > 60 ? '…' : ''}"
          </p>
        )}
        <p className="text-[10px] truncate" style={{ color: 'var(--text-secondary)' }} title={m.authors}>
          {m.authors}
        </p>
        <p className="text-[10px] italic" style={{ color: 'var(--text-tertiary)' }}>
          {m.journal}
        </p>
        {doiUrl && (
          <a
            href={doiUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[10px] text-blue-600 hover:text-blue-800 hover:underline truncate"
          >
            <ExternalLink size={10} className="shrink-0" />
            <span className="truncate">{m.doi}</span>
          </a>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center border-b mx-3" style={{ borderColor: 'var(--border)' }}>
        {(['summary', 'abstract'] as const).map(tab => (
          <button
            data-testid="control-source-tabs"
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1 text-[10px] font-semibold capitalize transition-colors ${
              activeTab === tab
                ? 'border-b-2 -mb-px border-violet-500 text-violet-700'
                : 'text-stone-400 hover:text-stone-600'
            }`}
          >
            {tab}
          </button>
        ))}
        {aiSettings && activeTab === 'summary' && (
          <button
            data-testid="control-regenerate-summary"
            onClick={() => reDigest()}
            disabled={reDigesting || isDigesting}
            className="ml-auto p-0.5 rounded hover:bg-stone-100 transition-colors disabled:opacity-40"
            title="Regenerate AI summary"
            style={{ color: 'var(--text-muted)' }}
          >
            <RefreshCw size={10} className={reDigesting ? 'animate-spin' : ''} />
          </button>
        )}
      </div>

      {/* Tab content */}
      <div className="px-3 pt-2 pb-3">
        {activeTab === 'summary' ? (
          (isDigesting || reDigesting) ? (
            <div className="flex items-center gap-2 p-2 rounded-lg text-[10px]" style={{ background: 'rgba(139,92,246,0.06)', color: 'var(--text-muted)' }}>
              <Sparkles size={11} className="animate-spin text-violet-400 shrink-0" />
              {reDigesting ? 'Regenerating summary…' : 'Generating summary…'}
            </div>
          ) : source.digest ? (
            <div className="text-[11px] leading-relaxed p-2 rounded-lg" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                ul: ({...props}) => <ul className="list-disc pl-4 space-y-0.5" {...props} />,
                li: ({...props}) => <li {...props} />,
                p: ({...props}) => <p className="mb-1 last:mb-0" {...props} />,
              }}>
                {source.digest}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="text-[10px] italic" style={{ color: 'var(--text-muted)' }}>
              {aiSettings ? 'Summary not available.' : 'Configure an AI provider in Settings to generate summaries.'}
            </p>
          )
        ) : (
          /* Abstract tab */
          <div className="text-[10px] leading-relaxed p-2 rounded-lg" style={{ background: 'rgba(139,92,246,0.06)', color: 'var(--text-secondary)', border: '1px solid rgba(139,92,246,0.12)' }}>
            {m.abstract}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="px-3 pb-3 flex gap-1.5">
        <button
          data-testid="control-copy-bibtex"
          onClick={() => navigator.clipboard.writeText(resultToBibtex(m))}
          className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[10px] font-semibold transition-colors"
          style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
          title="Copy BibTeX entry to clipboard"
        >
          <Copy size={10} /> BibTeX
        </button>
        {aiSettings && (
          <button
            disabled={!!analyzingSourceId}
            data-testid="control-compare-source"
            onClick={() => onCompare(source)}
            className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[10px] font-semibold transition-colors disabled:opacity-50"
            style={{ background: 'rgba(109,40,217,0.08)', color: '#6d28d9', border: '1px solid rgba(109,40,217,0.2)' }}
          >
            <BookMarked size={10} />
            {analyzingSourceId === source.id ? 'Analyzing…' : 'Compare'}
          </button>
        )}
      </div>
    </div>
  );
}

export interface DocumentSourceTabsProps {
  source: ManuscriptSource;
  aiSettings: AISettings;
  /** The upload pipeline is summarising this source right now. */
  digestingId: string | null;
}

/** A PDF, text or BibTeX source's Summary / Abstract tabs, with a refresh that follows the active tab. */
export function DocumentSourceTabs({ source, aiSettings, digestingId }: DocumentSourceTabsProps) {
  const { updateSource } = useSourceStore();
  const [pdfTab, setPdfTab] = useState<'summary' | 'abstract'>('summary');
  const { reDigesting, extractingAbstract: isExtractingAbstract, extract, reDigest } = useDigestActions(source, aiSettings);
  const isRedigesting = reDigesting || digestingId === source.id;

  return (
    <div>
      {/* Tabs row */}
      <div className="flex items-center border-b border-t mx-3" style={{ borderColor: 'var(--border)' }}>
        {(['summary', 'abstract'] as const).map(tab => (
          <button
            data-testid="control-source-tabs"
            key={tab}
            onClick={() => {
              setPdfTab(tab);
              // Lazy-extract abstract on first click if not yet fetched,
              // or if the stored result is any prior failure string and the
              // source now has real text (e.g. PDF re-uploaded after parsing fix).
              const isFailure = !source.abstractText ||
                source.abstractText.startsWith('Abstract not available') ||
                source.abstractText.startsWith('PDF text could not');
              const hasText = (source.text?.trim().length ?? 0) > 20;
              if (tab === 'abstract' && isFailure && hasText && !isExtractingAbstract) {
                updateSource(source.id, { abstractText: undefined });
                extract();
              }
            }}
            className={`px-3 py-1 text-[10px] font-semibold capitalize transition-colors ${
              pdfTab === tab
                ? 'border-b-2 -mb-px border-blue-500 text-blue-700'
                : 'text-stone-400 hover:text-stone-600'
            }`}
          >
            {tab}
          </button>
        ))}
        {/* Refresh button — context-sensitive to active tab */}
        <button
          onClick={() => {
            if (pdfTab === 'summary') {
              reDigest();
            } else {
              updateSource(source.id, { abstractText: undefined });
              extract();
            }
          }}
          data-testid={pdfTab === 'summary' ? 'control-regenerate-summary' : 'control-reextract-abstract'}
          disabled={pdfTab === 'summary' ? isRedigesting : isExtractingAbstract}
          className="ml-auto p-0.5 rounded hover:bg-stone-100 transition-colors disabled:opacity-40"
          title={pdfTab === 'summary' ? 'Regenerate AI summary' : 'Re-extract abstract'}
          style={{ color: 'var(--text-muted)' }}
        >
          <RefreshCw size={10} className={(pdfTab === 'summary' ? isRedigesting : isExtractingAbstract) ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Tab content */}
      <div className="px-3 pt-2 pb-3">
        {pdfTab === 'summary' ? (
          isRedigesting ? (
            <div className="flex items-center gap-2 p-2 rounded-lg text-[10px]" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
              <Sparkles size={11} className="animate-spin shrink-0" style={{ color: 'var(--accent-blue)' }} />
              Regenerating summary…
            </div>
          ) : source.digest ? (
            <div className="text-[11px] leading-relaxed p-2 rounded-lg" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                ul: ({...props}) => <ul className="list-disc pl-4 space-y-0.5" {...props} />,
                li: ({...props}) => <li {...props} />,
                p: ({...props}) => <p className="mb-1 last:mb-0" {...props} />,
              }}>
                {source.digest}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="text-[10px] italic" style={{ color: 'var(--text-muted)' }}>
              No summary yet. Click <RefreshCw size={9} className="inline" /> to generate.
            </p>
          )
        ) : (
          /* Abstract tab */
          isExtractingAbstract ? (
            <div className="flex items-center gap-2 p-2 rounded-lg text-[10px]" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
              <Sparkles size={11} className="animate-spin shrink-0" style={{ color: 'var(--accent-blue)' }} />
              Extracting abstract…
            </div>
          ) : source.abstractText ? (
            <div className="text-[11px] leading-relaxed p-2 rounded-lg" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}>
              {source.abstractText}
            </div>
          ) : (
            <p className="text-[10px] italic" style={{ color: 'var(--text-muted)' }}>
              Click <RefreshCw size={9} className="inline" /> to extract abstract from the document.
            </p>
          )
        )}
      </div>
    </div>
  );
}
