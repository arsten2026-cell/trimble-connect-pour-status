# Pour status (Arsten), Trimble Connect 3D-viewer extension

Site staff record construction progress on Tekla pour objects (property set `Pour/Такт`): Formwork done, Rebar done,
Poured, Formwork removed. Each step stores date, who and an optional note, with a history; steps can be corrected
or undone. A summary per pour number and a colour-by-status view show progress.

Data lives in Trimble Connect's Property Set service, in the project library **CIP/Монолитно** (created once by
a project admin under Property Set Libraries → New library). Values are attached to the pour objects' IFC GUIDs, so
they also show in Connect's property panel and carry over to new IFC versions.

Install: project → Settings → Apps & Capabilities → + Add Custom →
`https://arsten2026-cell.github.io/trimble-connect-pour-status/manifest.json`.

Static files only; the panel talks to Trimble Connect directly with the signed-in user's access.

## Corrections and notes
- With objects selected that already have a step, its date and note boxes show the saved values; the button reads
  "Запиши" and overwrites (history: "corrected"). Different values across the selection: the box is empty and
  empty means keep each object's own value.
- "Незапочнатите прозрачни" (under "Оцвети по статус", remembered per browser): not-started objects see-through
  grey (on) or solid grey (off).
- Partly done selection: "Готово (n)" marks only the n objects without the step (today by default); the
  others are untouched. Select the done ones to correct them.
- "Без" (formwork, rebar, stripped): the step does not apply (dug footing without formwork, lean concrete without
  rebar). Stored as the step done + `{step}_na: true`; counts as done for progress and colour (the next step can go ahead;
  a "Без" step counts once the step before it is covered) but earns no quantity in the Excel export. Formwork "Без" also sets stripped "Без" unless stripped is done.
- "Само бележка" changes only the note (date and who stay; history: "note: …"). Empty clears the note.
- A change that empties a field is written with `PsetClient.replace` (PATCH only merges).

## Pour split by Tekla (pour break added after formwork/rebar)
Tested in 1028 (2026-11-12): Tekla keeps the original GUID for one piece (status stays, quantities shrink) and gives
every other piece a new GUID (no status). No parent link is exported, so the panel works it out:
- When a step is marked, the record also saves the step's quantity (`{step}_qty`, frozen for invoicing) and the
  object's outline and volume (`snap_bbox`, `snap_volume`), once.
- `S.splits`: a status with formwork/rebar (not poured) whose object shrank or disappeared; new objects without status
  fully inside the saved outline are pieces (pour number may differ), objects with at least 20 % of their box inside
  are "partial" (offered unticked). Pieces must share a part name with the original (`key`), so anchors or lean
  concrete inside the outline are not taken. Kept + pieces volume is checked against `snap_volume` (2 %).
- Records from before outlines were saved: same pour number and parts, connected to the kept object, and kept +
  pieces must rebuild the centre saved in `key` at marking (others are offered unticked as probable neighbours).
- Panel section "Разделени тактове": ticked pieces, volume check, Прехвърли (pieces get formwork/rebar with the
  parent's date/who, `split_from`, quantity 0 when the parent's quantity is frozen), Покажи, Не (keep as is).
- Pour break removed again ("Обединени отново"): a gone record linked by `split_from` (parent, piece or sibling) whose
  saved outline is now covered by a present linked object. "Потвърди" sums the frozen quantities into the merged
  object (original's quantity back if Tekla kept a piece's GUID, not doubled if it kept the original's), updates its
  outline, and sets `merged_into` on the gone records, which takes them out of "Статус без обект".
- Excel uses the frozen quantity of each step; Детайли has "Записано ≠ модел" where it differs from the model now.

## Excel export (for invoicing)
"Експорт Excel" next to the Pours heading downloads `pour-status_{project}_{date}.xlsx` (ExcelJS 4.4.0, loaded from
jsDelivr with SRI only when the button is pressed). Sheets:
- **По месеци / By month**: per month and pour type, how many objects reached each step and the quantity it earns
  (formwork done and stripped: formwork m² = sides + bottom; rebar done: rebar kg; poured: concrete m³), counted in
  the month of the step's date. Filter the month: the Total row uses SUBTOTAL, so it sums only visible rows.
- **По тактове / By pour**: totals per pour and what is done so far, % of volume poured, last pour date.
- **Детайли / Details**: one row per pour object with quantities, real dates, who, note, GUID, history.
Quantities come from the Tekla pour export (Pour/Такт pset). `S.invoiceData` is unit-tested; `S.toCsv` is kept but no
longer used by the panel.
