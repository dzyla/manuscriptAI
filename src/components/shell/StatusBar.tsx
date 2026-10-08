import type { PageEstimate } from '../../services/pagination';

const APPROX_NOTE = 'Estimated from character density. It ignores figure and table flow, so treat it as a lower bound until pagination lands.';

export function StatusBar({ estimate, limitPages, words, voiceDistance, saveState }: {
  estimate: PageEstimate;
  limitPages: number | null;
  words: number;
  voiceDistance: number | null;
  saveState: string;
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
      <span>{words.toLocaleString()} words</span>
      {voiceDistance !== null ? <span>voice {voiceDistance}</span> : null}
      <span className="u-status-save">{saveState}</span>
    </div>
  );
}
