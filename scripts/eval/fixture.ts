// Seeded-error fixture for the agent evaluation harness.
//
// A short manuscript deliberately salted with known problems, each tagged with
// the agent that SHOULD catch it and a `needle` — a verbatim substring the
// flagged `originalText` is expected to contain. The runner measures, per agent,
// how many of its seeds it recalls. This is what turns "the agents feel weak"
// into a number you can attribute to the model vs. the pipeline.

import type { AgentType } from '../../src/types';

export interface Seed {
  id: string;
  agent: AgentType;      // which agent is primarily responsible for catching it
  needle: string;        // verbatim substring the flagged text should contain
  note: string;          // what the problem is
}

export const FIXTURE_MANUSCRIPT = `Introduction

It was observed by us that tumor cells died rapidly following exposure to compound X. This is well established in the literature. Cancer is a disease that affects 10 million people. In order to characterize this effect, we performed an analysis of cell viability across many samples.

Methods

Cells were treated with compound X. Viability was measured. We used a t-test. The experiment was performed and the data were collected by the team over a period of time. RNA was extracted using standard methods, and qPCR was carried out on all samples.

Results

Treatment significantly improved survival. The results prove that compound X is the gold standard for cancer therapy. Viability increased by a lot (p < 0.05). Of note, the treated group showed a mean of 42 while, importantly, the control group was much lower. In the abstract we reported that survival increased by 30%, but here the increase was 50%.

Discussion

Our findings are very important and could potentially possibly suggest a new avenue. This proves that compound X will cure cancer in humans. The mechanism, which is complex, remains to be determined — but the implications are clear.`;

export const SEEDS: Seed[] = [
  { id: 'passive-1', agent: 'editor', needle: 'It was observed by us', note: 'passive voice, should be active' },
  { id: 'wordy-1', agent: 'editor', needle: 'In order to', note: 'wordy filler, "In order to" -> "To"' },
  { id: 'nominalization-1', agent: 'editor', needle: 'performed an analysis of', note: 'nominalization -> "analyzed"' },
  { id: 'filler-1', agent: 'researcher', needle: 'Of note', note: 'conversational filler' },
  { id: 'filler-2', agent: 'researcher', needle: 'importantly', note: 'conversational filler' },
  { id: 'hedge-1', agent: 'researcher', needle: 'could potentially possibly suggest', note: 'excessive hedging' },
  { id: 'vague-quant-1', agent: 'researcher', needle: 'increased by a lot', note: 'vague quantifier where a number exists' },

  { id: 'overclaim-1', agent: 'reviewer-2', needle: 'results prove', note: 'conclusion exceeds the data ("prove")' },
  { id: 'overclaim-2', agent: 'reviewer-2', needle: 'will cure cancer', note: 'overgeneralization to humans' },
  { id: 'unsupported-1', agent: 'reviewer-2', needle: 'well established', note: 'claim stated as fact without citation' },

  { id: 'cite-1', agent: 'citation-checker', needle: 'affects 10 million people', note: 'prevalence statistic needs a citation' },
  { id: 'cite-2', agent: 'citation-checker', needle: 'gold standard', note: 'definitive claim needs a citation' },

  { id: 'stat-1', agent: 'statistician', needle: 'significantly improved survival', note: 'significant without a test/effect size' },
  { id: 'stat-2', agent: 'statistician', needle: 'p < 0.05', note: 'p-value without the named test or effect size' },
  { id: 'stat-3', agent: 'statistician', needle: 'mean of 42', note: 'mean with no measure of variability' },

  { id: 'consistency-1', agent: 'consistency', needle: 'survival increased by 30%', note: 'abstract 30% vs results 50% contradiction' },

  { id: 'structure-1', agent: 'manager', needle: 'Viability was measured', note: 'methods lack detail / how measured' },
  { id: 'dash-1', agent: 'editor', needle: 'remains to be determined', note: 'em dash usage to fix' },
];
