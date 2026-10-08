// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { StylePanel } from './StylePanel';
import { auditText } from '../../services/proseAudit/metrics';
import { useAIStore } from '../../stores/useAIStore';
import { buildProfile } from '../../services/proseAudit/profile';

afterEach(cleanup);

const metrics = auditText(
  'Significance\n\nThe problem matters rather than the cost, which is clear; it matters a great deal to patients, clinicians, and funders.\n\nApproach\n\nWe purified the complex by gel filtration in three runs.',
);

const props = {
  metrics,
  onJumpToSentence: vi.fn(),
  onRewrite: vi.fn(),
  highlightsOn: true,
  onToggleHighlights: vi.fn(),
};

describe('StylePanel', () => {
  it('shows the distance score, its band and the honesty note', () => {
    render(<StylePanel {...props} />);
    expect(screen.getByTestId('style-score').textContent).toMatch(/\d/);
    expect(screen.getByText(/style, not authorship/i)).toBeTruthy();
  });

  it('never claims to detect AI', () => {
    const { container } = render(<StylePanel {...props} />);
    expect(container.textContent).not.toMatch(/\bAI[- ]?(?:probability|detected|written|generated)\b/i);
  });

  it('lists the comparison table with voice and draft columns', () => {
    render(<StylePanel {...props} />);
    expect(screen.getByText(/mean sentence length/i)).toBeTruthy();
    expect(screen.getByTestId('style-table').textContent).toMatch(/semicolon/i);
  });

  it('lists sections and worst sentences, and jumps on click', () => {
    render(<StylePanel {...props} />);
    expect(screen.getByText('Significance')).toBeTruthy();
    const first = screen.getAllByTestId('worst-sentence')[0];
    fireEvent.click(first);
    expect(props.onJumpToSentence).toHaveBeenCalled();
  });

  it('asks for a rewrite', () => {
    render(<StylePanel {...props} />);
    fireEvent.click(screen.getAllByRole('button', { name: /rewrite/i })[0]);
    expect(props.onRewrite).toHaveBeenCalled();
  });

  it('shows an empty state with no metrics', () => {
    render(<StylePanel {...props} metrics={null} />);
    expect(screen.getByText(/start writing/i)).toBeTruthy();
  });
});

describe('StylePanel: honesty about what is measured (final review)', () => {
  it('with no voice profile it names the baseline, not "your voice", and heads the column "baseline"', () => {
    useAIStore.setState(st => ({ aiSettings: { ...st.aiSettings, voiceProfile: undefined } }));
    const { container } = render(<StylePanel {...props} />);
    expect(container.textContent).toMatch(/typical-writing baseline/);
    expect(container.textContent).not.toMatch(/(?:close to|drifting from|far from) your voice/);
    expect(screen.getByTestId('style-table').textContent).toMatch(/baseline/);
    expect(screen.getByTestId('style-table').textContent).not.toMatch(/yours/);
    expect(container.textContent).toMatch(/Typical writing vs this draft/);
  });

  it('with a profile it says "your voice" and "yours"', () => {
    const { profile } = buildProfile('mine', [Array.from({ length: 200 }, () => 'We purified the complex by gel filtration in three runs.').join(' ')]);
    useAIStore.setState(st => ({ aiSettings: { ...st.aiSettings, voiceProfile: profile } }));
    const { container } = render(<StylePanel {...props} />);
    expect(container.textContent).toMatch(/(?:close to|drifting from|far from) your voice/);
    expect(screen.getByTestId('style-table').textContent).toMatch(/yours/);
    useAIStore.setState(st => ({ aiSettings: { ...st.aiSettings, voiceProfile: undefined } }));
  });

  it('shows sentence counts per section and "not measured" for a short one, and never a bare 0', () => {
    render(<StylePanel {...props} />);
    const rows = screen.getByTestId('style-sections').textContent ?? '';
    expect(rows).toMatch(/Significance.*not measured · 1 sentence/);
    expect(rows).toMatch(/Approach.*not measured · 1 sentence/);
  });

  it('drops a section with no sentences', () => {
    const m = auditText('Within 8 pages\n\nSignificance\n\nThe problem matters rather than the cost, which is clear; it matters a great deal to patients, clinicians, and funders.');
    render(<StylePanel {...props} metrics={m} />);
    expect(screen.getByTestId('style-sections').textContent).not.toMatch(/Within 8 pages/);
  });

  it('measures a long-enough section and shows its count', () => {
    const body = Array.from({ length: 6 }, () => 'We purified the complex by gel filtration in three independent runs.').join(' ');
    render(<StylePanel {...props} metrics={auditText(`Methods\n\n${body}`)} />);
    expect(screen.getByTestId('style-sections').textContent).toMatch(/Methods.*\d+ · 6 sentences/);
  });

  it('lists no worst sentences for a clean draft', () => {
    const clean = auditText('We purified the complex by gel filtration. Binding fell at low pH in every replicate. The structure was solved at three angstrom resolution.');
    render(<StylePanel {...props} metrics={clean} />);
    expect(screen.queryAllByTestId('worst-sentence')).toHaveLength(0);
  });

  it('labels a tell-free long sentence by its length, never as the word "long"', () => {
    const longClean = 'We purified the complex by gel filtration and then ' + Array.from({ length: 40 }, (_, i) => `step${i}`).join(' ') + ' in the end.';
    render(<StylePanel {...props} metrics={auditText(longClean)} />);
    const label = screen.getAllByTestId('worst-sentence')[0].textContent ?? '';
    expect(label).toMatch(/\d+ words · over 35 words/);
    expect(label).not.toMatch(/long sentence/);
  });

  it('offers no rewrite for a sentence over the cap, with a reason', () => {
    const blob = 'The blob ' + Array.from({ length: 120 }, (_, i) => `entry${i}`).join(' ') + ' ends here.';
    const { container } = render(<StylePanel {...props} metrics={auditText(blob)} />);
    expect(screen.queryAllByRole('button', { name: /rewrite/i })).toHaveLength(0);
    expect(container.textContent).toMatch(/Too long to rewrite/);
  });

  it('shows tricolon as information and does not list it among the scored rows', () => {
    const m = auditText('We saw alpha, beta and gamma in the first run of the assay. We saw delta, epsilon and zeta in the second run of the assay.');
    render(<StylePanel {...props} metrics={m} />);
    expect(screen.getByTestId('style-unscored').textContent).toMatch(/tricolon/);
    expect(screen.getByTestId('style-table').textContent).not.toMatch(/tricolon|list of three/i);
  });
});
