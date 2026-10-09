import { Coins } from 'lucide-react';
import type { PageEstimate } from '../../services/pagination';

const APPROX_NOTE = 'Estimated from character density. It ignores figure and table flow, so treat it as a lower bound until pagination lands.';

/** What the model is, as the status bar names it. */
export const providerLabel = (p: string) => (p === 'local' ? 'Local' : p === 'anthropic' ? 'Claude' : p === 'openai' ? 'OpenAI' : 'Gemini');

export interface DocStats { chars: number; paragraphs: number; readingMin: number }
export interface AiStatus { tokens: number; suggestions: number; provider: string; localModel?: string }

export function StatusBar({ estimate, limitPages, overBudget, words, voiceDistance, saveState, stats, ai }: {
  estimate: PageEstimate;
  limitPages: number | null;
  /** The grant section furthest over its page budget. Absent when nothing is over, so the bar stays quiet. */
  overBudget?: { title: string; pages: number; limit: number } | null;
  words: number;
  voiceDistance: number | null;
  saveState: string;
  /** Characters, paragraphs and reading time of the document. */
  stats?: DocStats;
  /** The token estimate, the suggestion count and which model answers. */
  ai?: AiStatus;
}) {
  const n = `${estimate.approximate ? '~' : ''}${estimate.pages}`;
  const pages = limitPages ? `${n} of ${limitPages}` : `${n} pp`;
  const over = limitPages !== null && estimate.pages > limitPages;
  return (
    <div className="u-status" role="status">
      <span
        className={over ? 'u-status-pages is-over' : 'u-status-pages'}
        title={estimate.approximate ? APPROX_NOTE : undefined}
      >
        {pages}
      </span>
      {overBudget && <span className="u-status-pages is-over" data-testid="status-over-budget">{overBudget.title}: {overBudget.pages} of {overBudget.limit} pg</span>}
      <span>{words.toLocaleString()} words</span>
      {stats && <span>{stats.chars.toLocaleString()} chars</span>}
      {stats && <span>{stats.paragraphs.toLocaleString()} paragraphs</span>}
      {stats && <span>{stats.readingMin} min read</span>}
      {voiceDistance !== null ? <span>voice {voiceDistance}</span> : null}
      {ai && <span>~{ai.tokens.toLocaleString()} tokens</span>}
      {ai && <span>{ai.suggestions} suggestions</span>}
      {ai && (
        <span className="flex items-center gap-1">
          <Coins size={10} />
          {providerLabel(ai.provider)}
          {ai.provider === 'local' && ai.localModel ? <span className="truncate max-w-[120px]">{ai.localModel}</span> : null}
        </span>
      )}
      <span className="u-status-save">{saveState}</span>
    </div>
  );
}
