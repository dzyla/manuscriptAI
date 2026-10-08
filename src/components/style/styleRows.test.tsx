// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { StylePanel } from './StylePanel';
import { styleRows } from './styleRows';
import { auditText } from '../../services/proseAudit/metrics';
import { GENERIC_HUMAN_SUMMARY } from '../../services/proseAudit/profile';

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
  const props = { metrics, onJumpToSentence: vi.fn(), onRewrite: vi.fn(), highlightsOn: false, onToggleHighlights: vi.fn() };

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

  it('never claims to detect authorship anywhere in the rendered output', () => {
    const { container } = render(<StylePanel {...props} />);
    expect(container.textContent).not.toMatch(/\bAI\b|probab|detect|written by|generated/i);
  });
});
