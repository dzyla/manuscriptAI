# AI actions on the floating selection bar

Bar: [B][I][U] | [block v][align v] | [Polish][Shorten] | [AI v], text selections only. Table selections unchanged.
Files: editor/SelectionAIMenu.tsx (new: DirectPresets, AIMenu, SelectionAI type), editor/press.ts (shared press()), SelectionBar.tsx (optional `ai` prop), Editor.tsx (optional `selectionAI` prop), App.tsx (one `selectionActions` object feeds both TopBar items and Editor).
Width: selects fixed at 92px/88px, bar max-w-[520px], flex-nowrap; estimated ~480px, NOT measured in a browser (forbidden). Direct buttons keep words; fall back to icon-only if it measures wider.
`agents` omitted from the bundle: InstructForm hardcodes its four agents and the top bar's `agents` feeds only "Run a single agent".
Gate: tsc 0, vitest 0 (1893 passed, baseline 1872), build 0.
Reachability: 12 rows added (2 direct, 7 menu, instruct-send, synonyms, synonym replace); SelectionAIMenu.tsx added to GUARDED, TEMPLATED_TESTIDS (1), ICON_ONLY (0), text-scope KINDS.
Mutations caught: Polish without press -> "every AI control swallows mousedown"; Shorten calls Polish -> direct-buttons test; similar never disabled / synonyms never disabled / no disabledReason title -> disabled-item test; AI on table -> table test; order swapped -> order test; Critique/Explain dropped -> order test, handler test, 2 reachability rows; menu container mousedown guard removed -> swallow test; rewrite testid renamed -> order, handler, reachability row.
Survivor: removing press() from menu items alone passes, because the menu container also swallows mousedown (defence in depth; not a vacuous test).
Concerns: dropdown opens below the bar, covering the selected text; the instruction input takes focus, and whether the BubbleMenu stays up when the editor blurs is unverified in a real browser.
