import { useMemo } from 'react';
import { useAIStore } from '../../stores/useAIStore';
import { activeSummary } from '../../services/proseAudit/profile';
import type { AuditMetrics, SentenceAudit } from '../../types';
import { VoiceProfileManager } from './VoiceProfileManager';
import { styleRows, sectionRows } from './styleRows';

/*
 * Reading the score (for maintainers; nothing here is shown to the user).
 *
 * - This is a distance from the author's own measured style. It says nothing about who
 *   wrote the text, and no user-facing string may claim otherwise.
 * - The nine lower-weighted tells (the "untabulated" block of WEIGHTS in score.ts) are
 *   discounted to 0.5 and each deviation is clamped at 1.5. With all nine saturated and
 *   the calibrated metrics at the author's voice, the score tops out around
 *   (9 x 0.5 x 1.5) / 16 = 42, below the 50 "far" threshold. A mid-range score can
 *   therefore still hide heavy use of those tells: read the per-metric rows and the
 *   flagged sentences, not just the headline number.
 * - lengthCv is measured but unscored (its direction is inverted: uniform sentence
 *   length is the tell). Tricolon is measured but unscored (the author's own prose saturates it).
 *   Both are shown in the "not scored" block.
 * - Scores are densities (per 100 sentences, mean length), so adding clean text lowers them;
 *   they are not a count of tells.
 */

export interface StylePanelProps {
  metrics: AuditMetrics | null;
  highlightsOn: boolean;
  onToggleHighlights: (on: boolean) => void;
}

const BAND_STYLES = {
  close: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  drifting: 'bg-amber-50 text-amber-700 border-amber-200',
  far: 'bg-rose-50 text-rose-700 border-rose-200',
} as const;

const BAND_TEXT = {
  close: 'close to your voice',
  drifting: 'drifting from your voice',
  far: 'far from your voice',
} as const;

/** With no voice profile the reference is another scientist's draft, so no phrase may claim it is "your voice". */
const BAND_TEXT_GENERIC = {
  close: 'close to the typical-writing baseline',
  drifting: 'drifting from the typical-writing baseline',
  far: 'far from the typical-writing baseline',
} as const;

const HEADING = 'mb-1 text-[10px] font-bold uppercase tracking-widest';

/** Stable id for a sentence (the in-flight rewrite's id). Flagged sentences are listed and acted on in the Review panel's style rows, not here. */
export const sentenceId = (s: SentenceAudit) => `${s.start}-${s.end}`;

export function StylePanel({ metrics, highlightsOn, onToggleHighlights }: StylePanelProps) {
  const voiceProfile = useAIStore(s => s.aiSettings.voiceProfile);
  const { summary: voice, isGeneric } = activeSummary(voiceProfile);

  const readout = useMemo(() => (metrics ? styleRows(metrics.summary, voice) : null), [metrics, voice]);
  const sections = useMemo(() => (metrics ? sectionRows(metrics.sections, voice) : []), [metrics, voice]);

  if (!metrics || !readout || metrics.summary.sentences === 0) {
    return (
      <div className="space-y-4">
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          Start writing and this panel will compare the draft with your own writing style.
        </p>
        <VoiceProfileManager />
      </div>
    );
  }

  const muted = { color: 'var(--text-muted)' };

  return (
    <div className="space-y-4 text-xs">
      <div className={`rounded-xl border p-3 ${BAND_STYLES[readout.band]}`}>
        <div className="flex items-baseline gap-2">
          <span data-testid="style-score" className="text-2xl font-semibold">{readout.score}</span>
          <span className="text-[11px]">/ 100 · {(isGeneric ? BAND_TEXT_GENERIC : BAND_TEXT)[readout.band]}</span>
        </div>
        <div className="mt-1 text-[10px] opacity-80">
          Measures writing style, not authorship.
          {isGeneric && ' Using a typical-writing baseline until you add your own samples.'}
        </div>
        <div data-testid="style-discount-note" className="mt-1 text-[10px] opacity-80">
          Some patterns are weighted down because no measurement backs their scale, so heavy use of them can score closer to your voice than it reads.
        </div>
      </div>

      <VoiceProfileManager />

      <label className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
        <input type="checkbox" data-testid="control-highlight-flagged" checked={highlightsOn} onChange={e => onToggleHighlights(e.target.checked)} />
        Highlight flagged sentences in the editor
      </label>

      <div>
        <div className={HEADING} style={muted}>{isGeneric ? 'Typical writing vs this draft' : 'Your voice vs this draft'}</div>
        <table data-testid="style-table" className="w-full text-[11px]">
          <thead>
            <tr style={{ color: 'var(--text-tertiary)' }}>
              <th className="text-left font-medium">metric</th>
              <th className="text-right font-medium">{isGeneric ? 'baseline' : 'yours'}</th>
              <th className="text-right font-medium">draft</th>
            </tr>
          </thead>
          <tbody>
            {readout.rows.map(r => (
              <tr
                key={r.metric}
                className={r.deviation >= 0.5 ? 'text-rose-700' : ''}
                style={r.deviation >= 0.5 ? undefined : { color: 'var(--text-secondary)' }}
              >
                <td className="py-0.5 pr-2">
                  <span>{r.label}</span>
                  {r.name && <span className="ml-1 text-[10px] opacity-60">({r.name})</span>}
                  <span className="ml-1 text-[10px] opacity-60">{r.unit}</span>
                </td>
                <td className="py-0.5 text-right tabular-nums">{r.voice}</td>
                <td className="py-0.5 text-right font-medium tabular-nums">{r.draft}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div data-testid="style-unscored" className="mt-2 border-t pt-1.5" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="text-[10px] font-semibold uppercase tracking-wide" style={muted}>Not scored</div>
          <div className="flex justify-between gap-2" style={{ color: 'var(--text-secondary)' }}>
            <span>sentence-length variation (CV)</span>
            <span className="tabular-nums">
              {readout.lengthCv.voice ?? '–'} <span className="opacity-50">/</span> <span className="font-medium">{readout.lengthCv.draft}</span>
            </span>
          </div>
          <div className="text-[10px]" style={muted}>For information only. Very even sentence lengths read as mechanical.</div>
          <div className="mt-1 flex justify-between gap-2" style={{ color: 'var(--text-secondary)' }}>
            <span>lists of three (tricolon, per 100)</span>
            <span className="tabular-nums">
              {readout.tricolon.voice ?? '–'} <span className="opacity-50">/</span> <span className="font-medium">{readout.tricolon.draft}</span>
            </span>
          </div>
          <div className="text-[10px]" style={muted}>For information only. Triples are common in ordinary prose; many more than usual for you can read as mechanical.</div>
        </div>
      </div>

      {sections.length > 0 && (
        <div>
          <div className={HEADING} style={muted}>By section</div>
          <ul data-testid="style-sections" className="space-y-0.5 text-[11px]">
            {sections.map(sec => (
              <li key={sec.title} className="flex justify-between gap-2">
                <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{sec.title}</span>
                <span className={`tabular-nums ${sec.band === 'far' ? 'text-rose-600' : ''}`} style={sec.band === 'far' ? undefined : muted}>
                  {sec.score === null ? `not measured · ${sec.sentences} ${sec.sentences === 1 ? 'sentence' : 'sentences'}` : `${sec.score} · ${sec.sentences} sentences`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
