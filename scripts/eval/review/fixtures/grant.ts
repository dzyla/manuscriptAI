/**
 * Synthetic R01 for the review eval (about 1,500 words). The topic is invented and unrelated to the author's own
 * grants. 15 planted weaknesses, 8 traps. Every quoteHint must appear verbatim exactly once (fixtures.test.ts).
 */
import type { ReviewFixture } from './types';

export const SUMMARY = 'Project Summary';
export const AIMS = 'Specific Aims';
export const STRATEGY = 'Research Strategy';
export const SIG = 'Significance';
export const INNOV = 'Innovation';
export const APPROACH = 'Approach';
export const PRELIM = 'Preliminary Data';
export const AIM1 = 'Aim 1: Define how S124 phosphorylation changes MICU1 gating';
export const AIM2 = 'Aim 2: Determine whether blocking MICU1 phosphorylation protects the heart under pressure overload';
export const AIM3 = 'Aim 3: Test whether inhibiting the S124 kinase reverses established hypertrophy';
export const RIGOR = 'Rigor and Reproducibility';
export const TIMELINE = 'Timeline';

export const GRANT_FIXTURE: ReviewFixture = {
  id: 'grant-r01-micu1',
  docType: 'grant',
  mechanism: 'R01',
  projectYears: 5,
  sections: [
    { level: 1, title: SUMMARY, paragraphs: [
      'Heart failure affects more than six million adults in the United States, and half of patients die within five years of diagnosis [1]. Mitochondrial calcium overload is a shared step in cardiomyocyte death across many forms of heart disease. The mitochondrial calcium uniporter (MCU) carries calcium into the mitochondrial matrix, and its gatekeeper subunit MICU1 sets the threshold at which the channel opens. We found that MICU1 is phosphorylated at serine 124 in failing human hearts and that this modification lowers the opening threshold. This application will define how MICU1 phosphorylation controls calcium uptake, test whether blocking it protects the heart under pressure overload, and develop an AAV gene therapy vector that delivers a phosphorylation-resistant MICU1 to failing hearts. The work will identify a regulatory switch that could be targeted to slow the progression of heart failure.',
    ] },
    { level: 1, title: AIMS, paragraphs: [
      'Calcium overload of mitochondria is a final common pathway of cardiomyocyte death in heart failure. The MCU channel admits calcium into mitochondria, and its activity is gated by MICU1, which keeps the channel closed at resting cytosolic calcium. How this gate is regulated in the diseased heart is unknown.',
      'Our preliminary data show that MICU1 is phosphorylated at serine 124 (S124) in left ventricular tissue from patients with heart failure and in mice after transverse aortic constriction (TAC). A phosphomimetic MICU1 lowered the calcium threshold for MCU opening in isolated cardiomyocytes. We hypothesize that MCU plays an important role in cardiac disease. The objective of this application is to determine how S124 phosphorylation regulates MICU1 and whether preventing it protects the pressure-overloaded heart.',
      'Aim 1. Define how S124 phosphorylation changes MICU1 gating. We will measure mitochondrial calcium uptake in cardiomyocytes expressing wild-type, phosphomimetic (S124D) and phosphorylation-resistant (S124A) MICU1, identify the kinase responsible, and generate S124A and S124D knock-in mouse lines.',
      'Aim 2. Determine whether blocking MICU1 phosphorylation protects the heart under pressure overload. Aim 2 will use the MICU1 knock-in lines generated and validated in Aim 1, and will subject S124A knock-in mice to TAC. Aim 2b will test the same mechanism in human iPSC-derived cardiomyocytes from patients with dilated cardiomyopathy.',
      'Aim 3. Test whether inhibiting the S124 kinase reverses established hypertrophy. We will treat mice with the kinase inhibitor after hypertrophy has developed and follow cardiac function by echocardiography.',
      'Completion of these aims will establish MICU1 phosphorylation as a regulated gate of mitochondrial calcium entry in the failing heart and will test a druggable route to protect it.',
    ] },
    { level: 1, title: STRATEGY, paragraphs: [] },
    { level: 2, title: SIG, paragraphs: [
      'Heart failure remains a leading cause of death, and current therapies slow but do not stop its progression [1,2]. Mitochondrial calcium overload opens the permeability transition pore and triggers cardiomyocyte necrosis, a process documented in pressure overload, ischemia and chemotherapy-induced cardiomyopathy [5].',
      'Prior work [3,4] established that deleting MCU protects the heart from acute ischemic injury, although those studies used global knockouts and could not separate cardiac from systemic effects. Our cardiomyocyte-specific approach addresses this limitation.',
      'No study has yet examined MICU1 phosphorylation in cardiomyocytes; this gap must be filled.',
      'In our preliminary cohort of 40 patients with end-stage heart failure, MICU1 S124 phosphorylation was elevated in every sample compared with non-failing donor hearts.',
      "If phosphorylation of MICU1 lowers the gate in disease, preventing it would limit calcium overload while preserving the physiological calcium signals that match energy supply to demand. This would be a more selective strategy than blocking MCU itself, which impairs the heart's response to adrenergic stress [6].",
    ] },
    { level: 2, title: INNOV, paragraphs: [
      'This proposal is the first to identify a post-translational switch on MICU1 in the heart. We will combine knock-in mouse models with patient-derived cardiomyocytes to test the switch in both species.',
      'The use of echocardiography to measure cardiac function in mice is a highly innovative aspect of this proposal.',
      'Aim 2 also introduces serial block-face scanning electron microscopy (SBF-SEM) to reconstruct mitochondrial networks across entire cardiomyocytes after pressure overload.',
    ] },
    { level: 2, title: APPROACH, paragraphs: [] },
    { level: 3, title: PRELIM, paragraphs: [
      'MICU1 S124 phosphorylation was detected with a phospho-specific antibody that we validated in MICU1 knockout cardiomyocytes. In isolated adult cardiomyocytes, expression of MICU1 S124D increased mitochondrial calcium uptake by 2.1-fold relative to wild-type MICU1 (n = 6 independent preparations, Fig. 1).',
      'Phosphorylation was elevated in left ventricular samples from the 60-patient cohort described in Significance, and it rose within one week of TAC in mice (Fig. 2).',
      'In HEK293 cells, a kinase screen identified CaMKII and PKD1 as candidate S124 kinases; both phosphorylated recombinant MICU1 in vitro (Fig. 3).',
    ] },
    { level: 3, title: AIM1, paragraphs: [
      'Rationale. Our preliminary data show that S124D lowers the calcium threshold for MCU opening, but the structural basis and the responsible kinase are unknown.',
      'Experimental design. Adult cardiomyocytes from male and female mice will be transduced with adenovirus expressing wild-type, S124D or S124A MICU1 on a MICU1-knockout background. Mitochondrial calcium uptake will be measured with the matrix-targeted indicator mtGCaMP6f at clamped cytosolic calcium concentrations from 100 nM to 10 µM. In parallel, we will generate S124A and S124D knock-in mouse lines by CRISPR editing and confirm the edit by sequencing and phospho-specific immunoblotting. To identify the kinase, we will test CaMKII and PKD1 with selective inhibitors and with cardiomyocyte-specific knockout mice.',
      "Statistical analysis. Comparisons between genotypes will use two-way ANOVA (genotype × sex) with Tukey's post hoc test; the calcium threshold will be fitted with a Hill equation and compared by extra-sum-of-squares F test.",
      'Expected outcomes. We expect S124D to shift the threshold to lower calcium and S124A to resist the shift, which would support the hypothesis; no shift with S124D would argue that phosphorylation acts through a different subunit.',
      'Potential problems and alternative strategies. If adenoviral expression alters MICU1 stoichiometry, we will use the knock-in lines instead. If neither CaMKII nor PKD1 is responsible, we will perform an unbiased kinase screen with phosphoproteomics of TAC hearts.',
    ] },
    { level: 3, title: AIM2, paragraphs: [
      'Rationale. If S124 phosphorylation drives calcium overload, mice that cannot phosphorylate MICU1 should be protected from TAC-induced heart failure.',
      'Experimental design. This aim can only begin once the S124A knock-in line from Aim 1 is validated. Male C57BL/6J mice aged 10-12 weeks, wild-type or S124A knock-in, will undergo TAC or sham surgery. Cardiac function will be followed by echocardiography for eight weeks, after which hearts will be collected for histology, mitochondrial calcium retention capacity and SBF-SEM.',
      'Although our laboratory has not previously performed SBF-SEM, we expect to learn it quickly.',
      'Data will be analyzed using appropriate statistical methods.',
      'Expected outcomes. S124A mice should preserve ejection fraction and show less fibrosis and mitochondrial swelling after TAC than wild-type mice.',
    ] },
    { level: 3, title: AIM3, paragraphs: [
      'Rationale. A therapy for heart failure must work after disease is established. We will test whether inhibiting the S124 kinase after hypertrophy develops restores function.',
      'Experimental design. Mice will undergo TAC and, four weeks later, receive the kinase inhibitor or vehicle for four weeks, using eight mice per group. Mice will be assigned to treatment groups and echocardiography will be performed by the PI.',
      'Expected outcomes. We expect kinase inhibition to lower MICU1 phosphorylation and to improve ejection fraction relative to vehicle.',
      'Potential problems and alternative strategies. If the inhibitor has off-target effects on cardiac contractility, we will use an inducible cardiomyocyte-specific knockout of the kinase.',
    ] },
    { level: 3, title: RIGOR, paragraphs: [
      'Power analysis. For Aims 1 and 2, n = 12 mice per group gives 80% power (alpha = 0.05, two-sided) to detect a 25% difference in ejection fraction, based on the variance in our TAC studies (SD 15%).',
      'Male and female mice will be studied in equal numbers in Aim 1, and sex will be included as a biological variable in all Aim 1 analyses.',
      'All antibodies are validated in knockout tissue, and cell lines are authenticated by STR profiling, as described in the Authentication of Key Resources attachment.',
      'Investigators performing histology and image analysis in Aims 1 and 2 will be blinded to genotype, and animals will be randomized to surgery by a random number table.',
    ] },
    { level: 3, title: TIMELINE, paragraphs: [
      'Aim 1 studies will run from Year 1 through Year 3. Aim 2 will start in Year 2, once the knock-in lines are validated, and finish in Year 4. Aim 3 studies will run from Year 4 through Year 6.',
    ] },
  ],
  planted: [
    { id: 'P1-dependent-aims', checkId: 'g-log-independent', sectionTitles: [AIMS, AIM2, AIM3, TIMELINE],
      quoteHints: ['Aim 2 will use the MICU1 knock-in lines generated and validated in Aim 1', 'This aim can only begin once the S124A knock-in line from Aim 1 is validated', 'We will test whether inhibiting the S124 kinase after hypertrophy develops restores function.'],
      keywords: /depend|interdepend|contingent|sequential|relies on aim 1|requires aim 1|cannot (begin|start|proceed)/i,
      note: 'Aim 2 needs the knock-in lines from Aim 1' },
    { id: 'P2-no-power-aim3', checkId: 'g-rig-power', sectionTitles: [AIM3], quoteHints: ['using eight mice per group'],
      keywords: /power|sample size/i, alsoIn: [{ sectionTitle: RIGOR, mention: /aim 3/i }],
      note: 'Aim 3 n = 8 is not justified; the power analysis covers Aims 1 and 2 only' },
    { id: 'P3-sabv-aim2', checkId: 'g-rig-sabv', sectionTitles: [AIM2, AIM3], quoteHints: ['Male C57BL/6J mice aged 10-12 weeks', 'Mice will undergo TAC and, four weeks later'],
      keywords: /\bsex\b|female|biological variable|sabv/i, alsoIn: [{ sectionTitle: RIGOR, mention: /aim 2/i }],
      note: 'Aim 2 uses male mice only, without justification' },
    { id: 'P4-aim2b-missing', checkId: 'g-log-aims-approach', sectionTitles: [AIMS, AIM2],
      quoteHints: ['Aim 2b will test the same mechanism in human iPSC-derived cardiomyocytes'],
      keywords: /ipsc|aim 2b|not (described|addressed|covered)|absent from|missing from/i,
      note: 'Aim 2b on the Aims page never appears in the Approach' },
    { id: 'P5-cohort-size', checkId: 'g-con-numbers', sectionTitles: [SIG, PRELIM],
      quoteHints: ['our preliminary cohort of 40 patients', 'the 60-patient cohort described in Significance'],
      keywords: /\b40\b|\b60\b|inconsisten|mismatch|discrepan/i,
      note: 'Cohort is 40 in Significance and 60 in Preliminary Data' },
    { id: 'P6-innovation-echo', checkId: 'g-imp-innovation', sectionTitles: [INNOV],
      quoteHints: ['The use of echocardiography to measure cardiac function in mice is a highly innovative aspect of this proposal.'],
      keywords: /innovat|standard|routine|incremental|not novel|conventional/i,
      note: 'Echocardiography is routine, not innovative' },
    { id: 'P7-no-alternatives-aim2', checkId: 'g-fea-pitfalls', sectionTitles: [AIM2],
      keywords: /alternative|pitfall|potential problem|contingency|fallback/i,
      note: 'Aim 2 has no potential problems or alternatives' },
    { id: 'P8-timeline-overrun', checkId: 'g-fea-timeline', sectionTitles: [TIMELINE],
      quoteHints: ['Aim 3 studies will run from Year 4 through Year 6'],
      keywords: /year 6|six years|beyond|exceed|project period|five-year|5-year/i,
      note: 'Timeline runs past the five-year period' },
    { id: 'P9-summary-extra-aim', checkId: 'g-con-summary', sectionTitles: [SUMMARY],
      quoteHints: ['develop an AAV gene therapy vector that delivers a phosphorylation-resistant MICU1'],
      keywords: /gene therapy|\baav\b|vector|not (in|among|part of) the (specific )?aims/i,
      note: 'Summary promises a gene therapy vector that no aim delivers' },
    { id: 'P10-vague-hypothesis', checkId: 'g-log-hypothesis', sectionTitles: [AIMS],
      quoteHints: ['We hypothesize that MCU plays an important role in cardiac disease.'],
      keywords: /hypothes|testable|falsifiable|vague|important role/i,
      note: 'Hypothesis is not testable' },
    { id: 'P11-stats-aim3', checkId: 'g-rig-stats', sectionTitles: [AIM3],
      keywords: /statistic|named test|analysis plan|which test/i, note: 'Aim 3 names no statistical test' },
    { id: 'P12-stats-aim2', checkId: 'g-rig-stats', sectionTitles: [AIM2],
      quoteHints: ['Data will be analyzed using appropriate statistical methods.'],
      keywords: /statistic|named test|analysis plan|which test/i,
      note: 'Aim 2 names no statistical test' },
    { id: 'P13-blinding-aim3', checkId: 'g-rig-bias', sectionTitles: [AIM3],
      quoteHints: ['echocardiography will be performed by the PI'],
      keywords: /blind|random/i, alsoIn: [{ sectionTitle: RIGOR, mention: /aim 3/i }],
      note: 'Aim 3 has no randomization or blinding; the PI scores outcomes' },
    { id: 'P14-no-prelim-aim3', checkId: 'g-fea-prelim', sectionTitles: [AIM3],
      quoteHints: ['receive the kinase inhibitor or vehicle for four weeks'],
      keywords: /preliminary|pilot|in vivo (data|evidence)|dose|feasibility data/i, alsoIn: [{ sectionTitle: PRELIM, mention: /aim 3|inhibitor/i }],
      note: 'No in vivo data that the inhibitor reaches the heart or lowers phosphorylation' },
    { id: 'P15-sbfsem-expertise', checkId: 'g-exp-expertise', sectionTitles: [AIM2],
      quoteHints: ['Although our laboratory has not previously performed SBF-SEM, we expect to learn it quickly.'],
      keywords: /expertise|collaborat|experience|consultant|core facility|train/i,
      note: 'No SBF-SEM expertise and no collaborator' },
  ],
  traps: [
    { id: 'T1-power-present', checkId: 'g-rig-power', sectionTitles: [RIGOR], quoteHints: ['n = 12 mice per group gives 80% power'],
      keywords: /power|sample size/i, note: 'Power analysis for Aims 1 and 2 is present' },
    { id: 'T2-sabv-aim1', checkId: 'g-rig-sabv', sectionTitles: [RIGOR], quoteHints: ['sex will be included as a biological variable in all Aim 1 analyses'],
      keywords: /\bsex\b|female|biological variable|sabv/i, note: 'SABV handled for Aim 1' },
    { id: 'T3-alternatives-aim1', checkId: 'g-fea-pitfalls', sectionTitles: [AIM1],
      quoteHints: ['If neither CaMKII nor PKD1 is responsible, we will perform an unbiased kinase screen'],
      keywords: /alternative|pitfall|potential problem|contingency|fallback/i, note: 'Aim 1 has alternatives' },
    { id: 'T4-mcu-defined', checkId: 'g-con-terms', sectionTitles: [SUMMARY], quoteHints: ['The mitochondrial calcium uniporter (MCU)'],
      keywords: /\bmcu\b[^.]{0,40}(undefined|not defined|abbreviat)|(undefined|not defined|abbreviat)[^.]{0,40}\bmcu\b/i, note: 'MCU is defined at first use' },
    { id: 'T5-stats-aim1', checkId: 'g-rig-stats', sectionTitles: [AIM1], quoteHints: ["two-way ANOVA (genotype × sex) with Tukey's post hoc test"],
      keywords: /statistic|anova|post hoc|multiple comparison/i, note: 'Aim 1 statistics are named' },
    { id: 'T6-prelim-aim1', checkId: 'g-fea-prelim', sectionTitles: [PRELIM],
      quoteHints: ['increased mitochondrial calcium uptake by 2.1-fold relative to wild-type MICU1'],
      keywords: /(no|lacks?|without|missing) (supporting )?(preliminary|pilot) data/i, note: 'Aim 1 is backed by preliminary data' },
    { id: 'T7-authentication', checkId: 'g-rig-resources', sectionTitles: [RIGOR],
      quoteHints: ['cell lines are authenticated by STR profiling'],
      keywords: /authenticat|str profil/i, note: 'Key resources are authenticated' },
    { id: 'T8-premise-limits', checkId: 'g-imp-premise', sectionTitles: [SIG],
      quoteHints: ['although those studies used global knockouts and could not separate cardiac from systemic effects'],
      keywords: /premise|prior (work|studies)|rigor of|global knockout/i, note: 'Premise cites prior work and its limits' },
  ],
};
