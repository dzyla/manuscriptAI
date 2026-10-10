/**
 * IMRAD manuscript for the review eval: the July 2026 fixture (scripts/eval/fixture.ts) re-tagged with check ids,
 * given an Abstract and headings, plus traps. Editing seeds (passive voice, filler) stay in the old harness for R4.
 * The qPCR seed was replaced by an undefined, non-standard abbreviation (TCD), so the check has a clear target.
 */
import type { ReviewFixture } from './types';

export const ABSTRACT = 'Abstract';
export const INTRO = 'Introduction';
export const METHODS = 'Methods';
export const RESULTS = 'Results';
export const DISCUSSION = 'Discussion';

export const MANUSCRIPT_FIXTURE: ReviewFixture = {
  id: 'manuscript-compound-x',
  docType: 'manuscript',
  sections: [
    { level: 1, title: ABSTRACT, paragraphs: [
      'Compound X killed tumor cells in culture. In a survival model, survival increased by 30% with treatment. These results suggest compound X as a candidate anticancer agent.',
    ] },
    { level: 1, title: INTRO, paragraphs: [
      'It was observed by us that tumor cells died rapidly following exposure to compound X. This is well established in the literature. Cancer is a disease that affects 10 million people. Compound X inhibits the proteasome [3]. In order to characterize this effect, we performed an analysis of cell viability across many samples.',
    ] },
    { level: 1, title: METHODS, paragraphs: [
      'Cells were treated with compound X. Viability was measured. We used a t-test. The experiment was performed and the data were collected by the team over a period of time. RNA was extracted using standard methods, and TCD was scored on all samples.',
    ] },
    { level: 1, title: RESULTS, paragraphs: [
      'Treatment significantly improved survival. The results prove that compound X is the gold standard for cancer therapy. Viability increased by a lot (p < 0.05). Of note, the treated group showed a mean of 42 while, importantly, the control group was much lower. In the abstract we reported that survival increased by 30%, but here the increase was 50%.',
      "Apoptosis rose from 8% to 31% (mean ± SD, n = 6 independent cultures per group; Welch's t-test, p = 0.002).",
    ] },
    { level: 1, title: DISCUSSION, paragraphs: [
      'Our findings are very important and could potentially possibly suggest a new avenue. This proves that compound X will cure cancer in humans. The mechanism, which is complex, remains to be determined — but the implications are clear.',
      'A limitation of this study is that all experiments used a single cell line, so the effect may not generalize.',
    ] },
  ],
  planted: [
    { id: 'M1-results-prove', checkId: 'm-imp-overclaim', sectionTitles: [RESULTS], quoteHints: ['The results prove that compound X'],
      keywords: /prove|overclaim|overstat|unsupported|causal|exceed/i, note: '"prove" exceeds the data' },
    { id: 'M2-cure-cancer', checkId: 'm-imp-overclaim', sectionTitles: [DISCUSSION], quoteHints: ['This proves that compound X will cure cancer in humans.'],
      keywords: /prove|overclaim|overstat|generali|humans|cure/i, note: 'generalises from cells to curing humans' },
    { id: 'M3-well-established', checkId: 'm-con-uncited', sectionTitles: [INTRO], quoteHints: ['This is well established in the literature.'],
      keywords: /citation|cite|reference|source/i, note: 'claim with no citation' },
    { id: 'M4-prevalence', checkId: 'm-con-uncited', sectionTitles: [INTRO], quoteHints: ['Cancer is a disease that affects 10 million people.'],
      keywords: /citation|cite|reference|source/i, note: 'prevalence with no citation' },
    { id: 'M5-gold-standard', checkId: 'm-con-uncited', sectionTitles: [RESULTS], quoteHints: ['the gold standard for cancer therapy'],
      keywords: /citation|cite|reference|evidence for/i, note: 'definitive claim with no citation' },
    { id: 'M6-significant-no-test', checkId: 'm-rig-tests', sectionTitles: [RESULTS], quoteHints: ['Treatment significantly improved survival.'],
      keywords: /test|statistic|significan|effect size|p.value/i, note: '"significantly" with no test' },
    { id: 'M7-p-no-test', checkId: 'm-rig-tests', sectionTitles: [RESULTS], quoteHints: ['Viability increased by a lot (p < 0.05).'],
      keywords: /test|statistic|effect size|p.value/i, note: 'p-value with no named test or effect size' },
    { id: 'M8-mean-no-variability', checkId: 'm-rig-variability', sectionTitles: [RESULTS], quoteHints: ['the treated group showed a mean of 42'],
      keywords: /\bsd\b|\bsem\b|standard (deviation|error)|variab|confidence interval|\bci\b/i, note: 'mean with no variability' },
    { id: 'M9-abstract-mismatch', checkId: 'm-con-numbers', sectionTitles: [ABSTRACT, RESULTS],
      quoteHints: ['survival increased by 30% with treatment', 'but here the increase was 50%'],
      keywords: /\b30\b|\b50\b|inconsisten|mismatch|discrepan|contradict/i, note: 'abstract 30% vs results 50%' },
    { id: 'M10-viability-method', checkId: 'm-met-reproducible', sectionTitles: [METHODS], quoteHints: ['Viability was measured.'],
      keywords: /assay|not (described|specified)|insufficient detail|reproduc|how (viability )?was measured/i, note: 'no assay named' },
    { id: 'M11-tcd-undefined', checkId: 'm-con-terms', sectionTitles: [METHODS], quoteHints: ['TCD was scored on all samples'],
      keywords: /abbreviat|defin|\btcd\b/i, note: 'TCD is never defined' },
    { id: 'M12-n-missing', checkId: 'm-rig-n', sectionTitles: [INTRO, RESULTS], quoteHints: ['cell viability across many samples'],
      keywords: /\bn\b|sample size|number of (samples|replicates|cultures|animals|experiments)|how many/i, note: 'no n for the viability and survival experiments' },
  ],
  traps: [
    { id: 'MT1-welch-test', checkId: 'm-rig-tests', sectionTitles: [RESULTS], quoteHints: ["Welch's t-test, p = 0.002"],
      keywords: /t-test|welch|statistical test|named test|which test/i, note: 'test is named' },
    { id: 'MT2-sd', checkId: 'm-rig-variability', sectionTitles: [RESULTS], quoteHints: ['Apoptosis rose from 8% to 31% (mean ± SD'],
      keywords: /\bsd\b|\bsem\b|standard (deviation|error)|variab/i, note: 'variability is named' },
    { id: 'MT3-n-reported', checkId: 'm-rig-n', sectionTitles: [RESULTS], quoteHints: ['n = 6 independent cultures per group'],
      keywords: /\bn\b|sample size|number of/i, note: 'n is reported' },
    { id: 'MT4-limitation', checkId: 'm-met-limitations', sectionTitles: [DISCUSSION],
      quoteHints: ['A limitation of this study is that all experiments used a single cell line'],
      keywords: /(does not|doesn't|fails to) (discuss|state|acknowledge)[^.]{0,20}limitation|no limitations|limitations (are|were) not/i, note: 'limitation is stated' },
    { id: 'MT5-proteasome-cited', checkId: 'm-con-uncited', sectionTitles: [INTRO], quoteHints: ['Compound X inhibits the proteasome'],
      keywords: /citation|cite|reference|source/i, note: 'claim is cited' },
  ],
};
