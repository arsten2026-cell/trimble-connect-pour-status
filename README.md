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
