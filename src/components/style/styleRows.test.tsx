// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { StylePanel } from './StylePanel';
import { styleRows } from './styleRows';
import { auditText } from '../../services/proseAudit/metrics';
import { GENERIC_HUMAN_SUMMARY, buildProfile } from '../../services/proseAudit/profile';
import { useAIStore } from '../../stores/useAIStore';

afterEach(cleanup);

const TEXT =
  'We chose a method rather than a guess. We pooled samples instead of splitting them. ' +
  'The result is what matters; the rest follows from it. We ran three replicates on each plate.';
const metrics = auditText(TEXT);

describe('styleRows', () => {
  it('names the metric next to a label that two metrics share', () => {
    const rows = styleRows(metrics.summary, GENERIC_HUMAN_SUMMARY).rows;
    const rather = rows.find(r => r.metric === 'rather than')!;
    const instead = rows.find(r => r.metric === 'instead of')!;
    expect(rather.label).toBe(instead.label);
    expect(rather.name).toBe('rather than');
    expect(instead.name).toBe('instead of');
    // a label that already is the metric name is not repeated
    expect(rows.find(r => r.metric === 'semicolon')!.name).toBeNull();
    expect(rows.find(r => r.metric === 'meanWords')!.name).toBeNull();
  });

  it('keeps lengthCv out of the scored rows and null for a generic baseline', () => {
    const r = styleRows(metrics.summary, GENERIC_HUMAN_SUMMARY);
    expect(r.rows.some(x => x.metric === 'lengthCv')).toBe(false);
    expect(r.lengthCv.draft).toBe(metrics.summary.lengthCv);
    expect(r.lengthCv.voice).toBeNull();
  });

  it('omits metrics that are zero on both sides', () => {
    const r = styleRows(metrics.summary, GENERIC_HUMAN_SUMMARY);
    expect(r.rows.some(x => x.metric === 'stock vocabulary')).toBe(false);
  });
});

describe('StylePanel rows', () => {
  const props = { metrics, highlightsOn: false, onToggleHighlights: vi.fn() };

  it('renders both contrastive rows distinguishably and the unscored CV row separately', () => {
    render(<StylePanel {...props} />);
    const table = screen.getByTestId('style-table').textContent ?? '';
    expect(table).toMatch(/\(rather than\)/);
    expect(table).toMatch(/\(instead of\)/);
    expect(table).not.toMatch(/variation/i);
    expect(screen.getByTestId('style-unscored').textContent).toMatch(/not scored/i);
    expect(screen.getByTestId('style-unscored').textContent).toMatch(/variation/i);
  });

  it('reports the highlight toggle', () => {
    render(<StylePanel {...props} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(props.onToggleHighlights).toHaveBeenCalledWith(true);
  });

  const CLAIM = /\bAI\b|probab|detect|written by|generated|human|machine/i;
  const text = (c: HTMLElement) => c.textContent ?? '';

  it('never claims to detect authorship in the populated render', () => {
    const { container } = render(<StylePanel {...props} />);
    expect(text(container)).not.toMatch(CLAIM);
  });

  it('never claims to detect authorship in the empty state', () => {
    const { container } = render(<StylePanel {...props} metrics={null} />);
    expect(text(container)).not.toMatch(CLAIM);
  });

  it('never claims to detect authorship with a voice profile present', () => {
    const sentence = 'We purified the complex by gel filtration and measured binding at three pH values. ';
    const { profile } = buildProfile('Mine', [sentence.repeat(160)]);
    useAIStore.setState(st => ({ aiSettings: { ...st.aiSettings, voiceProfile: profile } }));
    try {
      const { container } = render(<StylePanel {...props} />);
      expect(text(container)).toMatch(/Mine/);
      expect(text(container)).not.toMatch(CLAIM);
    } finally {
      useAIStore.setState(st => ({ aiSettings: { ...st.aiSettings, voiceProfile: undefined } }));
    }
  });

  it('tells the reader that heavy use of down-weighted patterns can look closer to their voice', () => {
    render(<StylePanel {...props} />);
    expect(screen.getByTestId('style-discount-note').textContent).toMatch(/weighted down.*closer to your voice than it reads/i);
  });
});
