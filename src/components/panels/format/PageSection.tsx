import { useState } from 'react';
import type { DocFormat, FormatPreset } from '../../../types';
import { getGrantTemplate } from '../../../services/grantTemplates';
import { MAX_PAGE_LIMIT, parsePageLimitInput, readPageLimit, withPageLimit } from '../../../services/pageLimit';
import { FONT_RANGE, bodyFontPt, MARGIN_RANGE, SIDES, baseFormat, fontWarning, marginWarning, parseBounded, withMargin, withPageSize, withPreset, withStyleField } from './formatEdit';
import { NumField } from './NumField';

const PRESETS: { id: Exclude<FormatPreset, 'custom'>; label: string }[] = [
  { id: 'nih', label: 'NIH: Letter, Arial, single spaced' },
  { id: 'manuscript', label: 'Manuscript: Letter, Times, double spaced' },
  { id: 'a4', label: 'A4: Arial, single spaced' },
];
const fieldStyle = { background: 'var(--surface-1)', borderColor: 'var(--border)', color: 'var(--text-primary)' };
const Warn = ({ id, text }: { id: string; text: string }) => (
  <p data-testid={id} role="alert" className="text-[11px] leading-snug rounded-lg border px-2 py-1.5 text-amber-800 bg-amber-50 border-amber-200">{text}</p>
);

/** Sheet, margins, preset, body font and the author's own page limit, with the two NIH checks that are hard limits. */
export function PageSection({ format, templateId, onChange }: { format: DocFormat | null; templateId: string | null; onChange: (f: DocFormat) => void }) {
  const f = baseFormat(format);
  // A preset replaces the page and the built-in styles, so the format it replaced is kept for one Undo, offered only while that preset's result is still the format.
  const [applied, setApplied] = useState<{ previous: DocFormat | null; result: DocFormat } | null>(null);
  const applyPreset = (id: Exclude<FormatPreset, 'custom'>) => { const result = withPreset(f, id); setApplied({ previous: format, result }); onChange(result); };
  const limit = readPageLimit(f.pageLimitPages);
  const budgets = (getGrantTemplate(templateId)?.sections ?? []).filter(s => s.pageLimit);
  const mWarn = marginWarning(f), fWarn = fontWarning(f);
  const bodyPt = bodyFontPt(f);

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="format-preset" className="block text-[10px] font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Format preset</label>
        <select id="format-preset" data-testid="control-preset" value={f.preset} onChange={e => applyPreset(e.target.value as Exclude<FormatPreset, 'custom'>)}
          className="w-full text-xs rounded-lg border px-2 py-1" style={fieldStyle}>
          {f.preset === 'custom' && <option value="custom" disabled>Custom</option>}
          {PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        {applied && format === applied.result && (
          <p data-testid="preset-applied" role="status" className="text-[11px] mt-1 flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
            Preset applied.
            <button data-testid="control-preset-undo" onClick={() => { onChange(applied.previous ?? baseFormat(null)); setApplied(null); }} className="font-semibold underline">Undo</button>
          </p>
        )}
        <p className="text-[10px] mt-1 leading-snug" style={{ color: 'var(--text-muted)' }}>A preset sets the sheet, margins, body font and the built-in styles. Your page limit is kept.</p>
      </div>

      <div>
        <label htmlFor="format-page-size" className="block text-[10px] font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Paper</label>
        <select id="format-page-size" data-testid="control-page-size" value={f.page.size} onChange={e => onChange(withPageSize(f, e.target.value as 'letter' | 'a4'))}
          className="w-full text-xs rounded-lg border px-2 py-1" style={fieldStyle}>
          <option value="letter">US Letter</option>
          <option value="a4">A4</option>
        </select>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {SIDES.map(side => (
          <NumField key={side} id={`margin-${side}`} label={`${side[0].toUpperCase()}${side.slice(1)} margin`} unit="in" step={0.05}
            value={f.page.marginsIn[side]} parse={t => parseBounded(t, MARGIN_RANGE.min, MARGIN_RANGE.max) ?? undefined}
            onCommit={v => v !== null && onChange(withMargin(f, side, v))} rule={`Enter ${MARGIN_RANGE.min} to ${MARGIN_RANGE.max} inches.`} />
        ))}
      </div>
      {mWarn && <Warn id="margin-warning" text={mWarn} />}

      <NumField id="body-font-size" label="Body font size" unit="pt" step={0.5} value={bodyPt}
        parse={t => parseBounded(t, FONT_RANGE.min, FONT_RANGE.max) ?? undefined}
        onCommit={v => v !== null && onChange(withStyleField(f, 'normal', { fontSizePt: v }))} rule={`Enter ${FONT_RANGE.min} to ${FONT_RANGE.max} points.`} />
      {fWarn && <Warn id="font-warning" text={fWarn} />}

      <div className="border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <NumField id="page-limit" label="Document page limit (optional)" unit="pages" step={0.5} value={limit}
          parse={t => { const p = parsePageLimitInput(t); return p.kind === 'ok' ? p.value : p.kind === 'unset' ? null : undefined; }}
          onCommit={v => onChange(withPageLimit(f, v))} rule={`Enter a number of pages above 0 and up to ${MAX_PAGE_LIMIT}, or leave it blank for no limit.`} />
        <p className="text-[10px] mt-1 leading-snug" style={{ color: 'var(--text-muted)' }}>
          {limit === null ? 'No limit is set, so the status bar shows the page estimate alone.' : `The status bar compares the estimate with ${limit} pages.`} The app does not assume a total: the real figure depends on the activity code and your funding announcement.
        </p>
        {budgets.length > 0 && (
          <p data-testid="page-limit-guidance" className="text-[10px] mt-1 leading-snug" style={{ color: 'var(--text-secondary)' }}>
            Template guidance, per section and not a document total: {budgets.map(s => `${s.title} ${s.pageLimit} pg`).join('; ')}. Sections can sit in separate attachments, so check your announcement before adding them up.
          </p>
        )}
      </div>
    </div>
  );
}
