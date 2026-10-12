/**
 * Per-check procedures and boundary examples (steps, one passing and one failing example), keyed by check id and
 * merged into CHECKS in checklist.ts. Measured on a weak local model: a short procedure plus one example either side of
 * the boundary raises recall and lowers false alarms. All examples are invented.
 */
import type { ReviewCheck } from './types';

export type CheckProcedure = Pick<ReviewCheck, 'steps' | 'passExample' | 'failExample'>;

export const PROCEDURES: Readonly<Record<string, CheckProcedure>> = {
  "g-imp-gap": {
    steps: [
      "Find sentences on the Specific Aims page and in Significance that say what is unknown, using cues such as 'unknown', 'not known', 'remains unclear', 'gap', 'however', 'no study has'.",
      "Check whether each such sentence names a specific unknown (a mechanism, relationship, cause or quantity), not just a topic area such as 'more research is needed on X'.",
      "Check that the aims are set up to answer that specific unknown.",
      "Answer pass if a specific unknown that the aims address is stated anywhere in the document; answer fail only if no gap sentence exists or every gap sentence names only a broad topic.",
    ],
    passExample: "It is not known whether root exudate sugars, rather than soil moisture, set the timing of drought-induced stomatal closure in maize.",
    failExample: "Drought tolerance in crops is poorly understood and requires further study.",
  },
  "g-imp-why": {
    steps: [
      "Find sentences on the Specific Aims page and in Significance that describe consequences of the work, using cues such as 'will enable', 'would allow', 'will inform', 'could lead to', 'patients', 'clinical', 'public health', 'treatment'.",
      "Check whether a sentence names a concrete thing that would change once the gap is closed: a decision, a therapy, a diagnostic, a practice, or a model the field uses.",
      "Do not accept sentences that only call the gap important, understudied, or say the work will 'fill a gap in knowledge'.",
      "Answer pass if at least one concrete consequence of closing the gap is stated anywhere in the document; answer fail only if importance is asserted without any concrete consequence.",
    ],
    passExample: "Knowing which biofilm matrix protein blocks antibiotic entry would let clinicians choose between existing catheter coatings for patients on long-term dialysis.",
    failExample: "This work will fill an important gap in our understanding of biofilm formation.",
  },
  "g-imp-premise": {
    steps: [
      "Find the paragraphs in Significance or Background that describe the prior findings the project builds on, using citation markers such as [3] or (Smith et al., 2021) and phrases such as 'previous studies', 'we and others have shown'.",
      "Check that these key prior findings carry citations.",
      "Check whether at least the main weakness of that prior work is discussed (small samples, one model, correlational design, one sex, in vitro only), or whether the project is explicitly designed around it.",
      "Answer pass if the key prior work is cited and its main limitation is acknowledged or designed around anywhere in the document; answer fail if the key prior work is uncited or presented with no limitation at all.",
    ],
    passExample: "Two cohort studies linked gut Lactobacillus abundance to lower blood pressure [4,5], but both were cross-sectional and could not show direction, so Aim 1 uses a longitudinal design.",
    failExample: "Previous work has firmly established that Lactobacillus lowers blood pressure, and we will build directly on this.",
  },
  "g-imp-innovation": {
    steps: [
      "Find the Innovation section and any other sentences that claim novelty, using cues such as 'innovative', 'novel', 'first', 'new approach', 'unlike current methods'.",
      "For each claim, check that it names what is new relative to current practice in the field, not only relative to the applicant's laboratory.",
      "Check that standard, widely used methods (for example qPCR, western blot, RNA-seq, a standard knockout) are not presented as the innovation without a specific new element.",
      "Answer pass if every innovation claim states what is new compared with the field; answer fail if any claim rests only on being new to the lab or on routine methods. If there is no Innovation section and no novelty claim, answer not_applicable.",
    ],
    passExample: "Current biofilm imaging requires fixed samples; our microfluidic chamber records matrix assembly live at single-cell resolution, which no published system does.",
    failExample: "This project is innovative because our laboratory will use RNA-seq for the first time.",
  },
  "g-imp-payoff": {
    steps: [
      "Find the closing paragraph of the Specific Aims page and the end of Significance, using cues such as 'expected outcomes', 'upon completion', 'at the conclusion', 'we expect', 'impact', 'will provide'.",
      "Check that the outcomes named are concrete results (a mechanism, a map, a validated tool, a dataset, a candidate therapy).",
      "Check that the text says how those outcomes move the field forward.",
      "Answer pass if concrete expected outcomes and their impact are stated anywhere in the document; answer fail if the text only promises vague 'insights' or 'a better understanding'.",
    ],
    passExample: "Upon completion, we will have a validated panel of three drought-responsive promoters that breeders can use to screen wheat lines in one season instead of three.",
    failExample: "This project will provide new insights into plant stress biology.",
  },
  "g-log-objective": {
    steps: [
      "Find sentences on the Specific Aims page that state goals, using cues such as 'long-term goal', 'overall goal', 'objective of this application', 'the goal of this proposal', 'our objective'.",
      "Check whether the objective of this specific application is stated in one clear sentence.",
      "If a long-term goal is also stated, check that it is distinct from the application objective (broader, at program or career level).",
      "Answer pass if the application objective is clearly stated anywhere in the document, with or without a separate long-term goal; answer fail if no objective is stated or the goal and objective are the same vague sentence.",
    ],
    passExample: "Our long-term goal is to reduce nitrogen loss from farm soils. The objective of this application is to identify which soil bacteria convert fertilizer nitrate to nitrous oxide.",
    failExample: "We are interested in studying soil bacteria and nitrogen.",
  },
  "g-log-hypothesis": {
    steps: [
      "Find the hypothesis, usually on the Specific Aims page, using cues such as 'central hypothesis', 'we hypothesize', 'we propose that', 'we will test whether'; for discovery work, look for a clearly framed question.",
      "Check that it names a specific relationship or mechanism (X causes, increases, or is required for Y, through Z).",
      "Ask whether a defined experimental result could show it is wrong; 'X plays a role in Y', 'X is involved in Y' and 'X is important for Y' cannot be refuted.",
      "Answer pass if a testable hypothesis or a clearly framed discovery question appears anywhere in the document; answer fail if there is none or every stated hypothesis is untestable.",
    ],
    passExample: "We hypothesize that the efflux pump AcrB is required for ciprofloxacin tolerance in biofilms, so deleting acrB will lower the biofilm inhibitory concentration at least fourfold.",
    failExample: "We hypothesize that AcrB plays a role in biofilm antibiotic tolerance.",
  },
  "g-log-independent": {
    steps: [
      "Find the aims by looking for headings or sentences that begin 'Aim 1', 'Aim 2', 'Specific Aim', or 'Sub-aim 1a' on the Specific Aims page and in the Approach.",
      "For each aim, look for inputs it takes from another aim, using cues such as 'using the lines generated in Aim 1', 'based on the results of Aim 1', 'candidates identified in Aim 2', 'will depend on'.",
      "For each dependency found, check whether the text acknowledges it and gives a fallback, such as an alternative reagent, existing material, or a parallel start.",
      "Answer pass if no aim needs another aim's success or products, or every such dependency has a stated fallback anywhere in the document; answer fail only when an aim cannot proceed if another fails and no fallback is given. If there is only one aim, answer not_applicable.",
    ],
    passExample: "Aim 2 will test the mutant strains made in Aim 1; if those are delayed, Aim 2 will begin with two existing knockout strains from a public collection.",
    failExample: "Aim 3 will characterize the receptor candidates identified in the Aim 2 screen.",
  },
  "g-log-aims-approach": {
    steps: [
      "List every aim and sub-aim with its title from the Specific Aims page (cues: 'Aim 1', 'Specific Aim 2', 'Aim 1a', 'Sub-aim').",
      "List every aim and sub-aim heading or label in the Approach or Research Strategy.",
      "Match the two lists one to one by number and title, and check that each pair has the same scope (same model, question and main experiments).",
      "Answer pass if every Aims-page aim has a matching Approach part of the same scope and the Approach adds no extra aim; answer fail if an aim is missing, an extra aim appears, or the scope clearly differs. If the document has no Approach or no Aims page, answer not_applicable.",
    ],
    passExample: "The Aims page lists 'Aim 2. Define how salinity alters root hair density', and the Approach has a section with the same title that images roots at three salt levels.",
    failExample: "The Aims page lists Aims 1 and 2, but the Approach also contains 'Aim 3. Field trials in two climates', which the Aims page never mentions.",
  },
  "g-log-measurable": {
    steps: [
      "Find each aim on the Specific Aims page and in the Approach (cues: 'Aim 1', 'Aim 2', 'Specific Aim').",
      "For each aim, look for what will be measured, using cues such as 'primary outcome', 'readout', 'endpoint', 'we will measure', 'quantify', 'deliverable', 'success will be'.",
      "Check that the readout is a named quantity or product (colony counts, survival at 28 days, a validated assay, a released dataset), not only an activity such as 'study' or 'explore'.",
      "Answer pass if every aim names its primary readout or deliverable anywhere in the document; answer fail if at least one aim names none.",
    ],
    passExample: "The primary readout of Aim 1 is biofilm biomass, measured by crystal violet absorbance at 590 nm after 48 hours.",
    failExample: "In Aim 1 we will explore how biofilms respond to stress.",
  },
  "g-log-scope": {
    steps: [
      "Find the project period (cues: 'five-year', 'Years 1-5', '2-year', 'project period', a timeline table) and list the aims, model systems and major experiments.",
      "Count the aims, the distinct models or cohorts, and large undertakings such as new animal lines, clinical cohorts, genome-wide screens or multi-site studies.",
      "Compare that workload with the period and the team described; if no period is stated, judge against the mechanism (an R01 is about five years, an R21 or R03 two years).",
      "Answer pass if the workload is plausible for the period; answer fail only when the work clearly exceeds what the period and team allow, and name the reason.",
    ],
    passExample: "Over two years, the project will run one genetic screen in one bacterial species and validate the top five hits.",
    failExample: "In a two-year project we will generate four new knockout mouse lines, enroll a 500-patient cohort, and complete genome-wide screens in three species.",
  },
  "g-rig-design": {
    steps: [
      "Find each aim and its experiments in the Approach (cues: 'Aim 1', 'Experiment', 'Design', 'groups', 'cohort', 'conditions').",
      "For each experiment, look for named groups (treatment, genotype, dose, condition) and controls (vehicle, wild type, sham, untreated, scrambled, placebo).",
      "Check that the comparison is stated, meaning which group is compared with which.",
      "Answer pass if each experiment names its groups and controls anywhere in the document, including a separate rigor or design section; answer fail if any experiment gives no groups or no control.",
    ],
    passExample: "Wheat seedlings will be grown under well-watered, moderate drought and severe drought conditions, and each drought group will be compared with the well-watered control.",
    failExample: "We will expose seedlings to drought and measure gene expression.",
  },
  "g-rig-power": {
    steps: [
      "Find every sentence that states a sample size for proposed experiments (cues: 'n =', 'N =', 'per group', 'mice per', 'participants', 'plants per line', 'replicates').",
      "Find any justification of those numbers, using cues such as 'power', 'powered to', 'power analysis', 'effect size', 'detect a difference', 'alpha', '80%', 'based on our previous', including in separate rigor or statistics sections.",
      "Check that each sample size is backed by a power calculation (effect size, variance, alpha, power) or by explicit precedent, such as prior data showing that this n gave a clear result.",
      "Answer pass if each experiment's n is justified somewhere in the document; answer fail if a proposed experiment's n has no justification or no n is given. If the work has no experiments that need a sample size (for example pure software development), answer not_applicable.",
    ],
    passExample: "With 12 plants per line we have 80% power to detect a 20% difference in leaf water content (SD 15%, alpha 0.05, two-sided t-test).",
    failExample: "We will use 12 plants per line, which should be sufficient.",
  },
  "g-rig-stats": {
    steps: [
      "Find each aim's primary outcome and the analysis text (cues: 'statistical analysis', 'analyzed by', 't-test', 'ANOVA', 'regression', 'mixed model', 'Cox', 'chi-square', 'Mann-Whitney'), including any separate statistics section.",
      "For each aim, check that the primary comparison has a named test or model.",
      "Do not accept generic phrases such as 'appropriate statistical methods' or 'standard statistics' as a named test.",
      "Answer pass if every aim's primary comparison has a named test or model anywhere in the document; answer fail if any aim lacks one.",
    ],
    passExample: "Biofilm thickness will be compared across the four strains by one-way ANOVA with Dunnett's test against wild type.",
    failExample: "Data will be analyzed using appropriate statistical methods.",
  },
  "g-rig-sabv": {
    steps: [
      "Find whether the work uses vertebrate animals or human subjects (cues: 'mice', 'rats', 'zebrafish', 'patients', 'participants', 'volunteers', 'cohort', 'donors').",
      "For each aim with such subjects, find sentences about sex (cues: 'sex', 'male', 'female', 'both sexes', 'sex as a biological variable', 'SABV').",
      "Check that both sexes are studied and sex is considered in the analysis (for example as a factor), or that use of a single sex is justified.",
      "Answer not_applicable if the work uses no vertebrate animals or human subjects; answer pass if sex is addressed for each such aim anywhere in the document, including a separate rigor section; otherwise answer fail.",
    ],
    passExample: "Equal numbers of male and female rats will be used in each group, and sex will be included as a factor in the two-way ANOVA.",
    failExample: "Eight-week-old male mice will be used in all experiments.",
  },
  "g-rig-bias": {
    steps: [
      "Find each in vivo or clinical experiment (cues: 'mice', 'rats', 'animals', 'patients', 'participants', 'trial', 'cohort').",
      "For each, look for how subjects are allocated to groups (cues: 'randomized', 'randomly assigned', 'random allocation', 'block randomization', 'stratified').",
      "Look for who is blinded (cues: 'blinded', 'masked', 'unaware of group', 'coded samples') or a stated reason why blinding is not possible.",
      "Answer not_applicable if there are no in vivo or clinical experiments; answer pass if each such experiment states allocation and blinding, or why blinding is impossible, anywhere in the document including a rigor section; otherwise answer fail.",
    ],
    passExample: "Rats will be assigned to diet groups from a computer-generated random list, and the technician measuring tumors will not know the group assignments.",
    failExample: "Rats will be placed on the high-fat or control diet, and tumors will be measured weekly.",
  },
  "g-rig-replication": {
    steps: [
      "Find the main findings each aim will produce and any text on repetition, using cues such as 'independent experiments', 'biological replicates', 'replicated', 'repeated', 'validated', 'orthogonal', 'second method', 'confirmed by', 'independent cohort'.",
      "Check that the main findings will be repeated independently (separate experiments, cohorts or batches) or confirmed by a different method (for example sequencing hits confirmed by qPCR, a knockout confirmed with a second guide).",
      "Do not count technical replicates of the same sample as independent replication.",
      "Answer pass if independent replication or orthogonal validation is stated for the main findings anywhere in the document; answer fail if the plan gives neither.",
    ],
    passExample: "Each growth assay will be repeated in three independent experiments with separate cultures, and top hits will be confirmed with a second knockout made using a different guide.",
    failExample: "The top hits from the single RNA-seq run will be ranked and reported as the final result.",
  },
  "g-rig-resources": {
    steps: [
      "Find the key biological and chemical resources named (cues: 'antibody', 'cell line', 'strain', 'mice', 'plasmid', 'compound', 'inhibitor', 'ATCC', 'Jackson Laboratory').",
      "Look for authentication, using cues such as 'STR profiling', 'mycoplasma', 'validated', 'knockout-validated', 'sequence-verified', 'genotyped', 'purity', 'HPLC', 'Authentication of Key Resources'.",
      "Check whether authentication is described or the Authentication of Key Resources attachment or plan is referenced.",
      "Answer pass if authentication is described or the attachment is referenced anywhere in the document; answer fail if key resources are used with neither. If the work uses no key biological or chemical resources, answer not_applicable.",
    ],
    passExample: "Cell lines will be authenticated by STR profiling and tested for mycoplasma every three months, as described in the Authentication of Key Resources Plan.",
    failExample: "We will use HEK293 cells and a commercial anti-FLAG antibody.",
  },
  "g-fea-prelim": {
    steps: [
      "Find each aim (cues: 'Aim 1', 'Aim 2') and the preliminary data text (cues: 'Preliminary Data', 'Preliminary Studies', 'our data show', 'Fig.', 'we have shown', 'we previously reported').",
      "For each aim, identify its central premise or key method.",
      "Check whether shown data (a figure, result or number) or cited prior work by the team supports that premise or method.",
      "Answer pass if every aim has such support anywhere in the document; answer fail if at least one aim has neither preliminary data nor cited team track record.",
    ],
    passExample: "Our preliminary data (Fig. 2) show that the drought-tolerant line keeps 30% higher leaf water content, which supports the premise of Aim 1.",
    failExample: "Aim 2 will use single-cell RNA-seq of root tissue, which we expect to work well in our hands.",
  },
  "g-fea-pitfalls": {
    steps: [
      "Find each aim (cues: 'Aim 1', 'Aim 2') and its pitfalls text (cues: 'Potential Problems', 'Pitfalls', 'Alternative Approaches', 'Alternative Strategies', 'if this fails', 'should X not work', 'contingency').",
      "For each aim, check that at least one realistic problem is named (a specific method or result that might fail).",
      "Check that the same aim states what will be done instead.",
      "Answer pass if every aim names a realistic problem and an alternative anywhere in the document; answer fail if any aim lacks either.",
    ],
    passExample: "If the knockout strain cannot form biofilms at all, we will use an inducible knockdown so the gene is silenced only after attachment.",
    failExample: "We do not anticipate any problems with this aim.",
  },
  "g-fea-outcomes": {
    steps: [
      "Find each aim (cues: 'Aim 1', 'Aim 2') and its outcomes text (cues: 'Expected Outcomes', 'Expected Results', 'we expect', 'if ... then', 'would indicate', 'would suggest', 'would support').",
      "For each aim, check that the expected result is stated together with what it would mean for the hypothesis.",
      "Check that the negative or alternative result is also interpreted, meaning what it would mean if the expected result does not occur.",
      "Answer pass if every aim states expected outcomes with their interpretation, including the negative case, anywhere in the document; answer fail if any aim gives no interpretation or ignores the negative case.",
    ],
    passExample: "If nitrate uptake drops in the mutant, this supports the transporter model; if uptake is unchanged, a second transporter likely compensates, and we will test its paralog.",
    failExample: "We expect to see reduced nitrate uptake in the mutant.",
  },
  "g-fea-timeline": {
    steps: [
      "Find the timeline or milestones (cues: 'Timeline', 'Milestones', 'Gantt', 'Year 1', 'Months 1-12', 'Q1', a table of years).",
      "Find the project period (cues: 'five-year', '2-year', 'project period'); if none is stated, use the mechanism (an R01 is about five years, an R21 two years).",
      "Check that every aim appears on the timeline and that no milestone falls after the end of the period.",
      "Answer pass if a timeline exists anywhere in the document, every aim appears on it, and all milestones fall within the period; answer fail if there is no timeline, an aim is missing from it, or milestones run past the period.",
    ],
    passExample: "Timeline: Aim 1 in Years 1-2, Aim 2 in Years 2-4 and Aim 3 in Years 3-5, all within the five-year project period.",
    failExample: "A two-year proposal whose timeline places Aim 3 in Year 3 and does not list Aim 2.",
  },
  "g-exp-expertise": {
    steps: [
      "Find the specialised methods named in the Approach (for example cryo-EM, mass spectrometry, single-cell sequencing, animal surgery, clinical recruitment, machine learning).",
      "For each, look for who will do it, using cues such as 'our laboratory has', 'we have published', 'collaborator', 'Co-Investigator', 'core facility', 'consultant', 'letter of support', 'expertise in'.",
      "Check that each specialised method is matched to the team's stated experience, a named collaborator, or a core facility, judging only from the text; routine methods need no backing.",
      "Answer pass if every specialised method has such backing anywhere in the document; answer fail if any specialised method has none.",
    ],
    passExample: "Metabolomics will be run by the institutional Mass Spectrometry Core, and Dr. Lee (Co-Investigator), who has published 15 plant metabolomics studies, will guide the analysis.",
    failExample: "We will determine the structure of the matrix protein by cryo-EM, with no mention anywhere of who on the team has done cryo-EM.",
  },
  "g-exp-resources": {
    steps: [
      "Find the critical resources the work needs (cues: named equipment, 'cohort', 'samples', 'biobank', 'animals', 'colony', 'dataset', 'database', 'field site', 'greenhouse').",
      "For each, look for a statement that it is available, using cues such as 'we have access to', 'available in our laboratory', 'have been collected', 'already banked', 'maintained in our colony', 'data access approved', 'Facilities'.",
      "Check that access to each critical resource is stated, not assumed.",
      "Answer pass if access to each critical resource is stated anywhere in the document; answer fail if any critical resource has no stated access.",
    ],
    passExample: "The 400 soil samples are already banked in our freezer, and the department greenhouse has reserved two bays for this project.",
    failExample: "We will analyze 400 soil samples from a national survey.",
  },
  "g-con-numbers": {
    steps: [
      "Find every number that describes the study, such as sample sizes, group counts, doses, durations, ages, years and effect sizes, and note what each one describes.",
      "Group numbers that describe the same thing, for example the cohort size in the Project Summary, the Aims page and the Approach.",
      "Compare values within each group; unit changes (1.5 g and 1500 mg), rounding, and totals versus per-group numbers are not mismatches.",
      "Answer pass if every repeated number matches; answer fail only when two values for the same thing differ, and quote both.",
    ],
    passExample: "The Aims page and the Approach both state 120 participants and a 6-week intervention.",
    failExample: "The Project Summary states 120 participants, while the Approach enrolls 150 participants in the same cohort.",
  },
  "g-con-terms": {
    steps: [
      "Find every abbreviation (short capitalized tokens such as ROS, MIC, WT) and note where it is first used and where it is defined, as in 'reactive oxygen species (ROS)'.",
      "Check that each abbreviation is defined at or before its first use; a definition in the Project Summary or Specific Aims counts for the rest of the document, and common units and symbols (DNA, mg, pH) need no definition.",
      "Check that each entity (gene, strain, compound, cohort, method) keeps the same name throughout.",
      "Answer pass if every abbreviation is defined at or before first use and names do not drift; answer fail if an abbreviation is used before its definition or never defined, or one entity is given two different names.",
    ],
    passExample: "Reactive oxygen species (ROS) rise during drought, and ROS levels will be measured in Aim 1.",
    failExample: "Aim 2 blocks ROS signaling, but 'reactive oxygen species' is first spelled out two pages later in the Approach.",
  },
  "g-con-summary": {
    steps: [
      "Find the Project Summary (or Abstract) and list the aims or main work it describes.",
      "Find the aims on the Specific Aims page (cues: 'Aim 1', 'Aim 2', 'Specific Aim').",
      "Match them and check that each Specific Aim appears in the summary and that the summary describes no aim, model or major experiment that the Aims page lacks.",
      "Answer pass if the summary's aims correspond to the Specific Aims page; answer fail if an aim is omitted or added, or the scope clearly differs. If the Project Summary or the Specific Aims page is absent, answer not_applicable.",
    ],
    passExample: "The summary describes testing nitrate transporter function (Aim 1) and field drought response (Aim 2), matching the two Specific Aims.",
    failExample: "The Specific Aims page has three aims, but the summary describes only two and adds a clinical trial.",
  },
  "g-con-uncited": {
    steps: [
      "Find factual claims about the field in Significance and Innovation, such as prevalence or burden numbers, mechanisms and prior findings (cues: percentages, 'affects', 'is known to', 'studies have shown', 'has been reported').",
      "For each claim, check for a nearby citation such as [3], [1,4], [2-5], (Author, 2020) or a superscript number.",
      "Do not require citations for the applicant's own preliminary data shown in the application, for the aims, or for statements of what the project will do.",
      "Answer pass if each factual claim about the field carries a citation; answer fail only for a specific claim with no citation, and quote it.",
    ],
    passExample: "Biofilm infections account for about 65% of hospital-acquired infections [3].",
    failExample: "Biofilm infections account for about 65% of hospital-acquired infections, and most resist standard antibiotics.",
  },
  "m-imp-question": {
    steps: [
      "Find the end of the Introduction and any sentence stating the aim of the study, using cues such as 'here we', 'in this study', 'we asked', 'we hypothesized', 'the aim of this study', 'it remains unknown', 'however'.",
      "Check that a specific question or hypothesis is stated, not only a topic.",
      "Accept the question in any form (a question, a hypothesis, or an aim statement) as long as it is specific enough for the results to answer it.",
      "Answer pass if a specific question or hypothesis is stated by the end of the Introduction; answer fail if the Introduction ends without one. If there is no Introduction, answer not_applicable.",
    ],
    passExample: "Here we asked whether salt stress shortens root hairs through ethylene signaling in Arabidopsis.",
    failExample: "Root hairs are important for plants, and in this study we investigated them.",
  },
  "m-imp-novelty": {
    steps: [
      "Find sentences in the Introduction and Discussion that state what is new, using cues such as 'here we show', 'for the first time', 'unlike previous studies', 'in contrast to', 'extends', 'previous work'.",
      "Check that the statement names what is new relative to specific cited prior work.",
      "Compare the claim with the cited work the paper itself describes; a claim to be 'first' is inaccurate if the paper cites work that already did it.",
      "Answer pass if the paper says anywhere what is new relative to cited work and the claim does not contradict that work; answer fail if no advance is stated or the stated advance is contradicted by the cited literature.",
    ],
    passExample: "Earlier studies measured biofilm thickness only at fixed time points [5,6]; here we track matrix growth continuously over 72 hours.",
    failExample: "We are the first to follow biofilm growth over time, although we cite a time-lapse biofilm study [7] in the Introduction.",
  },
  "m-imp-overclaim": {
    steps: [
      "Find the conclusion sentences in the Abstract, the Results and the Discussion (cues: 'demonstrate', 'prove', 'show that', 'establish', 'causes', 'leads to', 'drives', 'determines', 'in humans', 'all').",
      "For each conclusion, find the data it rests on and note the design: correlational or interventional, which model or population, and how large.",
      "Flag causal words used for correlational data, claims about other species or settings from one model, and certainty words such as 'prove' or 'definitively'.",
      "Answer pass if each conclusion is proportionate to its evidence and its limits are stated somewhere in the paper; answer fail for any conclusion that goes beyond its data, and quote it.",
    ],
    passExample: "Soil microbial diversity correlated with plant drought survival across 40 plots, suggesting a link that needs experimental testing.",
    failExample: "Our survey of 40 plots proves that microbial diversity causes drought survival in all crops.",
  },
  "m-log-structure": {
    steps: [
      "Find the Methods, Results and Discussion sections by their headings.",
      "In the Results, look for interpretation (cues: 'this suggests', 'this indicates', 'likely because', 'consistent with', comparisons with the literature); in the Methods, look for results; in the Discussion, look for new data not shown in the Results.",
      "Accept a single short clause in the Results that links one experiment to the next; flag sustained interpretation or literature discussion in the Results, or results reported only in the Methods or Discussion.",
      "Answer pass if results and interpretation stay in their sections; answer fail if a section clearly does another section's job, and quote the passage. If the paper has no separate Methods, Results and Discussion sections, answer not_applicable.",
    ],
    passExample: "Results: 'Mutant colonies were 40% smaller than wild type after 48 hours (Fig. 2A).'",
    failExample: "Results: 'Mutant colonies were 40% smaller, which shows that the gene controls cell division, in line with our model and three earlier reports in yeast.'",
  },
  "m-log-flow": {
    steps: [
      "Find the research question or hypothesis stated in the Introduction (cues: 'here we', 'we asked', 'we hypothesized', 'the aim of this study').",
      "List the main Results subsections or findings in order.",
      "For each result, check that it connects to the question (it tests part of it or builds evidence needed for it) and that the order builds logically toward the answer.",
      "Answer pass if each result connects to the stated question; answer fail if a result has no link to the question or the results never answer it. If no question is stated anywhere or there are no Results, answer not_applicable.",
    ],
    passExample: "The Introduction asks whether the transporter NRT2 controls drought survival; the Results report NRT2 expression under drought, then survival of nrt2 mutants.",
    failExample: "The Introduction asks about drought survival, but the last Results section reports leaf color under cold stress with no link to drought.",
  },
  "m-log-abstract": {
    steps: [
      "List every finding claimed in the Abstract (cues: 'we found', 'we show', 'resulted in', numbers, percentages, p-values).",
      "For each finding, find the matching result in the Results section.",
      "Check that the finding appears there with the same direction and, where a number is given, the same number.",
      "Answer pass if every Abstract finding appears in the Results; answer fail for an Abstract finding that is missing from or contradicted by the Results, and quote it. If there is no Abstract, answer not_applicable.",
    ],
    passExample: "Abstract: 'Treated biofilms lost 50% of their biomass.' Results: 'Biomass fell by 50% after treatment (Fig. 3).'",
    failExample: "Abstract: 'Treatment also reduced bacterial virulence in mice,' but the Results contain no mouse experiment.",
  },
  "m-rig-tests": {
    steps: [
      "Find every p-value and significance claim in the Results and figure legends (cues: 'p <', 'P =', 'significant', 'significantly', asterisks).",
      "For each, find the named test in the same sentence, the figure legend, or the statistics paragraph of the Methods (cues: 't-test', 'ANOVA', 'Mann-Whitney', 'chi-square', 'regression', 'log-rank', 'mixed model').",
      "Check that the test fits the data: paired data with a paired test, more than two groups with ANOVA or a similar test rather than repeated t-tests, counts or proportions with a suitable test.",
      "Answer pass if each p-value or significance claim has a named, suitable test anywhere in the paper; answer fail for a claim with no named test or a clearly unsuitable test. If the paper reports no statistical tests, answer not_applicable.",
    ],
    passExample: "Root length differed between the three genotypes (one-way ANOVA, F(2,27) = 8.1, p = 0.002).",
    failExample: "Root length was significantly longer in the mutant (p < 0.05), and no test is named in the legend or the Methods.",
  },
  "m-rig-n": {
    steps: [
      "Find every sentence or legend that states a sample size (cues: 'n =', 'N =', 'per group', 'mice', 'patients', 'replicates', 'independent experiments', 'cells from').",
      "For each reported experiment, check that n is given.",
      "Check that the unit of n is clear: cells, fields, animals, patients, plants, or independent experiments.",
      "Answer pass if each result states n and its unit somewhere in the paper, including figure legends or Methods; answer fail if a result lacks n or the unit is unclear.",
    ],
    passExample: "Data are from n = 6 mice per group, each mouse measured once.",
    failExample: "Biofilm thickness was reduced (n = 30).",
  },
  "m-rig-variability": {
    steps: [
      "Find every mean or average reported in the Results and figure legends (cues: 'mean', 'average', '±', 'error bars').",
      "For each, check that a measure of variability is given (SD, SEM, 95% CI, IQR, range).",
      "Check that the measure is named; '±' or 'error bars' without saying SD, SEM or CI does not count as named.",
      "Answer pass if each mean comes with a named measure of variability anywhere in the paper, including a general statement in the Methods or legends such as 'values are mean ± SD'; answer fail for a mean with no variability or an unnamed one.",
    ],
    passExample: "Leaf water content was 68 ± 4% (mean ± SD, n = 10).",
    failExample: "Leaf water content was 68 ± 4%.",
  },
  "m-rig-effect": {
    steps: [
      "Find the key comparisons in the Results (cues: 'p <', 'significant', 'compared with', 'versus', 'increased', 'decreased').",
      "For each, look for the size of the effect: a difference, fold change, percent change, ratio, odds or hazard ratio, Cohen's d, or the group means themselves.",
      "Do not count a p-value, asterisks, or the word 'significant' as an effect size.",
      "Answer pass if key comparisons report the size of the effect anywhere in the paper; answer fail for a key comparison reported only as significant. If there are no statistical comparisons, answer not_applicable.",
    ],
    passExample: "Drought reduced grain yield by 22% (95% CI 15-29%, p < 0.001).",
    failExample: "Drought significantly reduced grain yield (p < 0.001).",
  },
  "m-rig-multiple": {
    steps: [
      "Find where several tests are run on the same data (cues: many pairwise comparisons, many genes or proteins tested, several time points or groups, 'for each').",
      "Look for a correction or justification (cues: 'Bonferroni', 'Holm', 'Benjamini-Hochberg', 'FDR', 'false discovery', 'Tukey', 'Dunnett', 'Sidak', 'adjusted p', 'q-value', 'pre-specified').",
      "Check that the correction applies to the set of tests it is meant for.",
      "Answer pass if each family of tests on the same data states a correction or justification anywhere in the paper, or only one test is run; answer fail if many tests are run with no correction or justification.",
    ],
    passExample: "Expression of 2,000 genes was compared between conditions, and p-values were adjusted by the Benjamini-Hochberg method (FDR < 0.05).",
    failExample: "We compared each of the 12 strains with every other strain using t-tests and report all comparisons with p < 0.05.",
  },
  "m-rig-controls": {
    steps: [
      "Find each experiment or treatment in the Methods and Results (cues: 'treated', 'exposed', 'knockout', 'overexpression', 'infected', 'drug', 'supplemented').",
      "For each, look for its control (cues: 'control', 'vehicle', 'untreated', 'wild type', 'sham', 'mock', 'empty vector', 'scrambled', 'placebo', 'baseline').",
      "Check that the control is suitable: it differs from the treatment only in the factor tested, for example solvent-only cells for a drug dissolved in DMSO.",
      "Answer pass if each treatment is compared with a suitable control anywhere in the paper; answer fail for a treatment with no control or an unsuitable one.",
    ],
    passExample: "Cells were treated with 10 uM inhibitor in 0.1% DMSO or with 0.1% DMSO alone.",
    failExample: "Cells treated with the inhibitor in DMSO were compared only with cells from an untreated culture grown the previous week.",
  },
  "m-met-reproducible": {
    steps: [
      "Find each measurement reported in the Results and its description in the Methods.",
      "For each measurement, check that the assay or instrument is named and the key conditions are given (concentrations, temperatures, durations, timings, settings).",
      "Accept a citation to a published protocol as sufficient detail if the protocol is named and any changes are stated.",
      "Answer pass if each measurement names its assay and conditions anywhere in the paper; answer fail for a measurement whose assay or conditions are missing.",
    ],
    passExample: "Biofilms were grown in 96-well plates in LB at 37 C for 24 hours, stained with 0.1% crystal violet for 15 minutes, and read at 590 nm.",
    failExample: "Biofilm formation was measured using standard methods.",
  },
  "m-met-materials": {
    steps: [
      "Find the key reagents, organisms, cell lines, antibodies, kits and software named in the Methods.",
      "For each, look for an identifier: supplier, catalogue number, RRID, strain or accession code, or software version.",
      "Accept a citation to the source publication for a strain or line, and accept identifiers given in a table or supplement that the text refers to.",
      "Answer pass if key materials are identified anywhere in the paper; answer fail if key reagents, organisms or software are named without any source, catalogue number, RRID or version.",
    ],
    passExample: "We used an anti-GFP antibody (Abcam ab290, RRID:AB_303395) and analyzed images in ImageJ version 1.54.",
    failExample: "An anti-GFP antibody was used, and images were analyzed in ImageJ.",
  },
  "m-met-limitations": {
    steps: [
      "Find the Discussion and any limitations paragraph (cues: 'limitation', 'limited', 'caveat', 'cannot exclude', 'we did not', 'one weakness').",
      "Check that at least one specific limitation of this study is stated (sample size, model, design, measurement, generalisability).",
      "Do not count a generic sentence such as 'further studies are needed' as a limitation.",
      "Answer pass if at least the main limitation is discussed anywhere in the paper; answer fail if no specific limitation is stated.",
    ],
    passExample: "We studied a single wheat cultivar grown in a greenhouse, so the effects may differ in field conditions.",
    failExample: "Further studies are needed to confirm these findings.",
  },
  "m-met-data": {
    steps: [
      "Look for a data or code availability statement anywhere in the paper (cues: 'Data availability', 'Data and code availability', 'available from', 'deposited in', 'accession', 'GEO', 'Zenodo', 'GitHub', 'upon request').",
      "Check that it says where the data can be obtained or how to request them.",
      "Treat a statement that access is restricted, with the reason given, as a statement that is present.",
      "Answer pass if a data availability statement is present anywhere in the paper; answer fail if none exists.",
    ],
    passExample: "Sequencing data are deposited in GEO under accession GSE000000, and analysis code is available on GitHub.",
    failExample: "RNA-seq libraries were sequenced on an Illumina platform and analyzed with custom scripts, and no sentence anywhere says where the data or scripts can be found.",
  },
  "m-con-numbers": {
    steps: [
      "Find every number reported in more than one place: Abstract, Results, figure legends, tables and Methods (sample sizes, percentages, means, p-values, doses, durations).",
      "Group numbers that describe the same quantity.",
      "Compare values within each group; rounding (12.3% and 12%), unit changes, and totals versus subgroups are not mismatches.",
      "Answer pass if every repeated number matches; answer fail only when two values for the same quantity differ, and quote both.",
    ],
    passExample: "The Abstract and the Results both report a 35% reduction in biofilm biomass.",
    failExample: "The Abstract reports a 35% reduction in biofilm biomass, while the Results report a 25% reduction for the same comparison.",
  },
  "m-con-terms": {
    steps: [
      "Find every abbreviation (short capitalized tokens such as MIC, ROS, WT) and note where it is first used and where it is defined, as in 'minimum inhibitory concentration (MIC)'.",
      "Check that each abbreviation is defined at or before its first use; common units and symbols (DNA, mg, pH) need no definition.",
      "Check that each entity (strain, gene, treatment, group) keeps the same name throughout.",
      "Answer pass if every abbreviation is defined at or before first use and terms are consistent; answer fail if an abbreviation is used before its definition or never defined, or one entity has two names.",
    ],
    passExample: "The minimum inhibitory concentration (MIC) was 4 ug/mL, and the MIC did not change after passage.",
    failExample: "The MIC rose fourfold in the first Results paragraph, but 'minimum inhibitory concentration (MIC)' is first defined in the Discussion.",
  },
  "m-con-figures": {
    steps: [
      "List every figure and table (cues: 'Figure 1', 'Fig. 2B', 'Table 1', 'Supplementary Fig.', legend headings).",
      "Check that each figure and table is cited in the text and that their first citations appear in numerical order.",
      "For each citation, check that what the text says matches what the legend describes (same panel, measurement and direction).",
      "Answer pass if each figure and table is cited in order and the text matches it; answer fail for an uncited figure or table, an out-of-order first citation, or a mismatch between text and legend. If the paper has no figures or tables, answer not_applicable.",
    ],
    passExample: "Growth curves are shown in Figure 1 and survival in Figure 2, and the text cites them in that order.",
    failExample: "The text cites Figure 3 before Figure 2 and describes Figure 2B as survival, while its legend describes root length.",
  },
  "m-con-uncited": {
    steps: [
      "Find factual claims about prior work or the field in the Introduction, Results and Discussion (cues: 'is known to', 'has been shown', 'previous studies', 'is associated with', prevalence numbers, mechanisms).",
      "For each claim, check for a nearby citation such as [3], [1,4], [2-5], (Author, 2020) or a superscript number.",
      "Do not require citations for the paper's own results, its own methods, or its own interpretation.",
      "Answer pass if each such claim is cited; answer fail only for a specific factual claim with no citation, and quote it.",
    ],
    passExample: "Pseudomonas biofilms tolerate up to 1,000-fold higher antibiotic concentrations than free-swimming cells [2].",
    failExample: "Pseudomonas biofilms are known to tolerate up to 1,000-fold higher antibiotic concentrations than free-swimming cells.",
  },
};
