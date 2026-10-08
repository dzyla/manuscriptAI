// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { StylePanel } from './StylePanel';
import { auditText } from '../../services/proseAudit/metrics';

afterEach(cleanup);

const metrics = auditText(
  'Significance\n\nThe problem matters; it matters a great deal to patients, clinicians, and funders.\n\nApproach\n\nWe purified the complex by gel filtration in three runs.',
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
