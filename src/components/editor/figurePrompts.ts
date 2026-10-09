/** The prompts the figure-AI controls send with the image. Kept in one place so the wording is easy to find and to pin in a test. */
export const FIGURE_PROMPTS = {
  describe:
  'Describe what you can see in this figure purely visually: shapes, colors, spatial layout, objects, text labels, axes, legends, and any other visible elements. Do not interpret the scientific meaning — focus only on what is visually present.',
  quality:
  'Review this figure for visual integrity and quality issues. Check: (1) Is the resolution sufficient for publication? (2) Are all text labels, axis titles, and legends readable? (3) Check spelling of any text visible in the figure. (4) Are colors distinguishable (colorblind-friendly)? (5) Are there any visual artifacts, blurriness, or distortions? (6) Are axes properly labeled with units? (7) Is the overall layout clear and uncluttered? List each issue found with a specific recommendation.',
  relevance:
  'Review this figure in the context of the surrounding manuscript text. Does the figure clearly support the claims made in the text? Is it self-explanatory? Would a peer reviewer find it clear and convincing? What improvements would make it more effective for the manuscript?',
} as const;
