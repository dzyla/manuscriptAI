export const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export const LEGACY_V2_HTML = [
  '<h1>Title of the Application</h1>',
  '<h2>Specific Aims</h2>',
  '<p style="text-align: justify">HERV-K envelope <strong>bold</strong> <em>italic</em> <u>under</u> ',
  '<s>strike</s> <code>code</code> <mark data-color="#fef08a" style="background-color: #fef08a">highlighted</mark> ',
  '<a href="https://example.org" target="_blank" rel="noopener noreferrer nofollow">link</a> ',
  'cited <span data-citation-node="" data-source-ids="src-a,src-b" data-nums="1,2">[1,2]</span> and ',
  '<span data-figure-label="" data-figure-id="fig-1" data-figure-num="1">Figure 1</span>.</p>',
  '<h3>Aim 1</h3>',
  '<ul><li><p>bullet</p><ul><li><p>nested bullet</p></li></ul></li></ul>',
  '<ol><li><p>first</p></li><li><p>second</p></li></ol>',
  '<blockquote><p>quoted</p></blockquote>',
  '<pre><code>code block</code></pre>',
  '<hr>',
  '<table><tbody><tr><th colspan="2"><p>Header</p></th></tr><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>',
  `<img src="${PNG_1PX}" alt="fig" style="width:50%;margin-right:auto;margin-left:0" data-align="left">`,
  `<img src="${PNG_1PX}" alt="same fig again">`,
  '<p>Last paragraph.</p>',
].join('');

export const LEGACY_V2_ROW = {
  id: 'current' as const,
  title: 'R01 HERV-K (legacy)',
  content: LEGACY_V2_HTML,
  saveState: 'Saved' as const,
  citationRegistry: { 'src-a': 1, 'src-b': 2 },
  citationCounter: 2,
  figureRegistry: { 'fig-1': 1 },
  figureCounter: 1,
  updatedAt: 1_700_000_000_000,
  mode: 'grant' as const,
  grantInstructions: 'PAR-25-123 notes',
  grantTemplateId: 'nih-r01',
};
