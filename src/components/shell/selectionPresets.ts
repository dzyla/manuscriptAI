import type { AgentType } from '../../types';

/** A one-click rewrite or analysis of the selected text. `transform` produces an accept/reject suggestion; `analyze` opens the answer in chat. */
export interface SelectionPreset { label: string; instruction: string; agent: AgentType; mode: 'transform' | 'analyze' }

export const SELECTION_PRESETS: SelectionPreset[] = [
  {
    label: 'Polish',
    instruction: 'Fix grammar, convert passive voice to active, tighten wordy phrases, and improve sentence flow. Keep all scientific content intact.',
    agent: 'editor',
    mode: 'transform'
  },
  {
    label: 'Shorten',
    instruction: 'Condense this text for a scientific manuscript: cut redundant words, remove unnecessary hedging, combine short sentences. Preserve all key scientific information and claims.',
    agent: 'editor',
    mode: 'transform'
  },
  {
    label: 'Sharpen',
    instruction: 'Strengthen the topic sentence to clearly state the paragraph\'s conclusion, reduce excessive hedging language ("may possibly" → "suggests"), and improve the opening for maximum impact.',
    agent: 'researcher',
    mode: 'transform'
  },
  {
    label: 'Strengthen',
    instruction: 'Revise this text to be more scientifically rigorous: make vague claims specific, add appropriate qualifications to overclaimed statements, and make the argument more concrete and evidenced.',
    agent: 'reviewer-2',
    mode: 'transform'
  },
  {
    label: 'Critique',
    instruction: 'Identify the specific scientific weaknesses in this text: unsupported claims, logical gaps, missing methodology details, conclusions that exceed the data. Be direct and concise.',
    agent: 'reviewer-2',
    mode: 'analyze'
  },
  {
    label: 'Explain',
    instruction: 'Explain the key scientific concept, finding, or argument in this passage clearly. What is the author trying to say? What assumptions are being made? What would make this clearer for the reader?',
    agent: 'researcher',
    mode: 'analyze'
  },
];
