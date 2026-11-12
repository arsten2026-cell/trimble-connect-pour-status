// Pour status: Trimble Connect 3D-viewer extension for site progress on Tekla pour objects. Each pour object gets a
// status record (4 steps with date, by, note, history) stored in Trimble Connect's Property Set service on the link
// frn:entity:{IFC GUID}, in the project library "CIP/Монолитно", so it also shows in Connect's property panel
// and survives new IFC versions as long as Tekla keeps the pour object GUIDs.
(() => {
  "use strict";
  const C = window.PourLogic, S = window.PourStatus, A = window.PsetApi;
  const $ = (id) => document.getElementById(id);
  const PROXY = "IfcBuildingElementProxy";
  const BATCH = 200;
  const T = {
    title: ["Pour status · Статус тактове", "Pour status · Статус тактове"],
    selection: ["Избрано", "Selection"], steps: ["Етапи", "Steps"], view: ["Изглед", "View"], pours: ["Тактове", "Pours"],
    fromViewer: ["Вземи от модела", "Use viewer selection"], follow: ["Следи избора в модела", "Follow model selection"], csv: ["Експорт Excel", "Export Excel"], clear: ["Изчисти", "Clear"],
    colour: ["Оцвети по статус", "Colour by status"], orphans: ["Статус без обект", "Status without object"],
    nothing: ["Нищо не е избрано. Изберете тактове в модела (с отметка „Следи избора в модела“ панелът ги взема сам) или изберете такт от таблицата.",
      "Nothing selected. Select pour objects in the model (with \"Follow model selection\" ticked the panel picks them up by itself) or pick a pour in the table."],
    markDone: ["Готово", "Mark done"], undo: ["Отмени", "Undo"], note: ["Бележка (по избор)", "Note (optional)"],
    done: ["готови", "done"], select: ["Избери", "Select"], pour: ["Такт", "Pour"],
  };
  let lang = (() => { try { return localStorage.getItem("arsten.pourStatus.lang") || "bg"; } catch { return "bg"; } })();
  const t = (k) => (T[k] ? T[k][lang === "bg" ? 0 : 1] : k);
  const stepName = (s) => (lang === "bg" ? s.bg : s.en);

  const state = {
    api: null, client: null, project: null, user: "",
    lib: null, defId: S.DEF_ID, ready: false,
    follow: (() => { try { return localStorage.getItem("arsten.pourStatus.follow") !== "0"; } catch { return true; } })(),   // follow model selection (default on)
    pours: [], loose: [], objects: [],      // pour groups; all pour objects [{modelId,id,guid,key,props,bbox,group}]
    byKey: new Map(),                        // "modelId:id" -> pour object
    records: new Map(),                      // guid -> status props
    sel: [],                                 // selected pour objects
    coloured: false,
  };
  const objKey = (o) => o.modelId + ":" + o.id;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function setStatus(text, bad) { $("status").textContent = text; $("status").className = "status" + (bad ? " bad" : ""); }
  const errText = (e) => (e && (e.message || e.toString())) || String(e);
  async function guarded(fn) { try { await fn(); } catch (e) { setStatus("Error: " + errText(e), true); console.error(e); } }
  async function pool(items, n, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const k = next++; await fn(items[k], k); } }));
  }

  // ---------- access token (extension permission) ----------
  let tokenWaiters = [], token = null;
  function onToken(tk) { token = tk; const w = tokenWaiters; tokenWaiters = []; w.forEach((f) => f(tk)); }
  async function getToken(refresh) {
    if (token && !refresh) return token;
    const p = new Promise((resolve, reject) => { tokenWaiters.push(resolve); setTimeout(() => reject(new Error("No access token from Trimble Connect")), 60000); });
    const r = await state.api.extension.requestPermission("accesstoken");
    if (r === "denied") throw new Error("Access to Trimble Connect data was denied for this extension.");
    if (r && r !== "pending" && r !== "granted") { token = r; return r; }
    return p;
  }

  // ---------- reading pour objects (same rules as Pour tags) ----------
  async function loadPours() {
    const api = state.api;
    setStatus("Reading pours…");
    let modelObjs = await api.viewer.getObjects({ parameter: { class: PROXY } });
    if (!(modelObjs || []).some((m) => (m.objects || []).length)) modelObjs = await api.viewer.getObjects();
    const items = [];
    for (const m of modelObjs || []) {
      const ids = (m.objects || []).map((o) => o.id);
      for (let i = 0; i < ids.length; i += BATCH) {
        const props = (await api.viewer.getObjectProperties(m.modelId, ids.slice(i, i + BATCH))) || [];
        const found = [];
        for (const p of props) { const ps = C.readPourPset(p); if (ps) found.push({ modelId: m.modelId, id: p.id, props: ps }); }
        if (!found.length) continue;
        try {
          const boxes = (await api.viewer.getObjectBoundingBoxes(m.modelId, found.map((f) => f.id))) || [];
          const byId = new Map(boxes.map((b) => [b.id, b.boundingBox]));
          found.forEach((f) => { f.bbox = byId.get(f.id) || null; });
        } catch {}
        const guids = (await api.viewer.convertToObjectIds(m.modelId, found.map((f) => f.id))) || [];
        found.forEach((f, k) => { f.guid = guids[k] || null; });
        items.push(...found.filter((f) => f.guid));
      }
    }
    const { pours, unnumbered } = C.groupPours(items);
    pours.forEach((g, i) => { g.colour = C.colourFor(i); });
    state.pours = pours; state.loose = unnumbered;
    state.objects = items;
    state.byKey = new Map(items.map((o) => [objKey(o), o]));
    for (const g of [...pours, ...unnumbered]) for (const o of g.objects) {
      o.group = g;
      o.key = S.matchKey(g.numbered ? g.key : g.label, o.props[C.P.parts], o.bbox);
    }
    return items.length;
  }

  // ---------- library / definition / records ----------
  async function setup() {
    $("setupBox").hidden = true;
    const found = await state.client.findLibrary(state.project.id, S.LIB_NAMES);
    if (!found.lib) {
      showSetup(`<b>${lang === "bg" ? "Нужна е еднократна настройка от администратор на проекта." : "One-time setup by a project admin is needed."}</b>
        <ol><li>${lang === "bg" ? "Отворете" : "Open"} <b>Property Set Libraries</b> ${lang === "bg" ? "в менюто на проекта" : "in the project menu"}.</li>
        <li><b>New library</b> → ${lang === "bg" ? "име" : "name"} <b>${S.LIB_NAME}</b> → Save.</li>
        <li>${lang === "bg" ? "Върнете се тук и натиснете" : "Come back and click"} <b>${lang === "bg" ? "Провери отново" : "Check again"}</b>.</li></ol>
        ${found.others.length ? `<div class="sub">${lang === "bg" ? "Библиотеки в проекта" : "Libraries in this project"}: ${esc(found.others.join(", "))}</div>` : ""}
        <button id="btnRecheck" class="small">${lang === "bg" ? "Провери отново" : "Check again"}</button>`);
      return false;
    }
    state.lib = found.lib;
    try {
      const r = await state.client.ensureDefinition(found.lib.id, S.definition());
      if (r.created) setStatus("Status fields created in the library " + found.lib.name);
    } catch (e) {
      if (e.status === 403) {
        showSetup(lang === "bg"
          ? `Библиотеката <b>${S.LIB_NAME}</b> съществува, но полетата за статус още не са създадени. Администратор на проекта трябва да отвори този панел веднъж. <button id="btnRecheck" class="small">Провери отново</button>`
          : `The library <b>${S.LIB_NAME}</b> exists but its status fields are not created yet. A project admin has to open this panel once. <button id="btnRecheck" class="small">Check again</button>`);
        return false;
      }
      throw e;
    }
    return true;
  }
  function showSetup(html) {
    $("setupBox").innerHTML = html; $("setupBox").hidden = false; $("mainBox").hidden = true;
    const b = $("btnRecheck"); if (b) b.onclick = () => guarded(start2);
  }
  async function loadRecords() {
    const links = state.objects.map((o) => S.entityLink(o.guid));
    const got = await state.client.readMany(state.lib.id, state.defId, links);
    state.records = new Map();
    for (const [link, props] of got) state.records.set(link.replace(/^frn:entity:/, ""), props);
  }

  // ---------- selection ----------
  /** Take the viewer's selection into the panel. quiet: called by "follow model selection" (empty selection just clears). */
  async function selectionFromViewer(quiet) {
    const sel = (await state.api.viewer.getSelection()) || [];
    const picked = [];
    let n = 0;
    for (const m of sel) for (const id of m.objectRuntimeIds || []) { n++; const o = state.byKey.get(m.modelId + ":" + id); if (o) picked.push(o); }
    if (!n) {
      if (quiet === true) { state.sel = []; setStatus(""); return render(); }
      return setStatus(t("nothing"), true);
    }
    if (!picked.length) return setStatus(`${n} ${lang === "bg" ? "избрани обекта, но нито един не е такт." : "objects selected, none of them is a pour object."}`, true);
    state.sel = picked;
    setStatus("");
    render();
  }
  async function selectPour(g) {
    state.sel = g.objects.slice();
    const byModel = new Map();
    for (const o of g.objects) { if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(o.id); }
    const sel = { modelObjectIds: [...byModel].map(([modelId, objectRuntimeIds]) => ({ modelId, objectRuntimeIds })) };
    await state.api.viewer.setSelection(sel, "set");
    await state.api.viewer.setCamera(sel, { animationTime: 500 });
    render();
  }

  // ---------- writing steps ----------
  async function applyStep(stepId, undo) {
    const step = S.STEPS.find((s) => s.id === stepId);
    const date = $("date_" + stepId).value || S.today();
    const note = $("note_" + stepId).value.trim();
    const objs = state.sel.slice();
    if (!objs.length) return;
    const targets = undo ? objs.filter((o) => (state.records.get(o.guid) || {})[stepId]) : objs;
    if (!targets.length) return setStatus(lang === "bg" ? "Няма какво да се отмени." : "Nothing to undo.");
    let done = 0, failed = 0, firstErr = "";
    setStatus(`${stepName(step)}: 0/${targets.length}…`);
    await pool(targets, 6, async (o) => {
      const cur = state.records.get(o.guid) || null;
      const next = undo
        ? S.undoStep(cur, stepId, { by: state.user })
        : S.markStep(cur, stepId, { date, by: state.user, note, pour: o.group && o.group.numbered ? o.group.key : (o.group && o.group.label) || "", key: o.key });
      try {
        await (undo ? state.client.replace : state.client.write).call(state.client, state.lib.id, state.defId, S.entityLink(o.guid), next);
        state.records.set(o.guid, next);
        done++;
      } catch (e) {
        failed++;
        if (e.status === 403) throw new Error(lang === "bg" ? "Нямате права да записвате в библиотеката " + S.LIB_NAME + "." : "You have no permission to write to the library " + S.LIB_NAME + ".");
        console.error(e);
        if (!firstErr) firstErr = e.message || String(e);
      }
      setStatus(`${stepName(step)}: ${done}/${targets.length}…`);
    });
    $("note_" + stepId).value = "";
    setStatus(`${stepName(step)} ${undo ? (lang === "bg" ? "отменено" : "undone") : (lang === "bg" ? "записано" : "saved")}: ${done}` + (failed ? ` · ${failed} ${lang === "bg" ? "грешки" : "failed"} (${firstErr})` : ""), failed > 0);
    render();
    if (state.coloured) await applyColours();
  }

  // ---------- colours ----------
  const STAGES = [S.NOT_STARTED, ...S.STEPS];
  const NOT_STARTED_OPACITY = 0.15;
  async function applyColours() {
    const api = state.api;
    const sel = (objs) => {
      const byModel = new Map();
      for (const o of objs) { if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(o.id); }
      return { modelObjectIds: [...byModel].map(([modelId, objectRuntimeIds]) => ({ modelId, objectRuntimeIds })) };
    };
    if (!state.objects.length) return;
    if (!state.coloured) return api.viewer.setObjectState(sel(state.objects), { color: "reset", opacity: 1 });
    const buckets = STAGES.map(() => []);
    for (const o of state.objects) buckets[S.stageIndex(state.records.get(o.guid))].push(o);
    // Not started: see-through grey, so what is underneath stays visible. Started: solid stage colour.
    // Opacity is 0..1 in Connect (verified in Pour tags).
    for (let k = 0; k < STAGES.length; k++) {
      if (buckets[k].length) await api.viewer.setObjectState(sel(buckets[k]), { color: STAGES[k].colour, opacity: k === 0 ? NOT_STARTED_OPACITY : 1 });
    }
  }

  // ---------- Excel export (for invoicing) ----------
  // ExcelJS is loaded only when the button is pressed (about 1 MB).
  const EXCELJS = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  const EXCELJS_SRI = "sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz";
  let excelLoad = null;
  function loadExcelJs() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    return excelLoad || (excelLoad = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = EXCELJS; s.integrity = EXCELJS_SRI; s.crossOrigin = "anonymous";
      s.onload = () => resolve(window.ExcelJS);
      s.onerror = () => { excelLoad = null; reject(new Error("Could not load the Excel library (" + EXCELJS + ")")); };
      document.head.appendChild(s);
    }));
  }
  const toNum = (v) => { const n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).replace(",", ".")); return isFinite(n) ? n : null; };
  const toDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
  const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

  /**
   * Workbook with three sheets: by month (each step counted in the month of its date, per pour type, with the
   * quantity it earns: formwork/stripping m², rebar kg, concrete m³), by pour, and one row per pour object.
   * Real numbers and dates, filters, and totals that follow the filter (SUBTOTAL), so a month can be filtered and
   * its totals read off for the invoice.
   */
  async function exportExcel() {
    if (!state.ready) return;
    const bg = lang === "bg", L = (b, e) => (bg ? b : e);
    setStatus(L("Подготвям Excel…", "Preparing Excel…"));
    const ExcelJS = await loadExcelJs();
    const objs = state.objects.map((o) => {
      const p = o.props || {};
      const fw = (toNum(p[C.P.fwSides]) || 0) + (toNum(p[C.P.fwBottom]) || 0);
      return {
        pour: o.group ? o.group.label : p[C.P.number] || "", type: String(p[C.P.type] || ""), parts: String(p[C.P.parts] || ""), guid: o.guid,
        volume: round(toNum(p[C.P.volume]), 3), rebar: round(toNum(p[C.P.rebar]), 1), formwork: fw ? round(fw, 2) : null,
      };
    }).sort((a, b) => C.naturalCompare(a.pour, b.pour) || C.naturalCompare(a.type, b.type) || C.naturalCompare(a.parts, b.parts));
    const data = S.invoiceData(objs, state.records);

    const UNIT = { formwork: "m²", rebar: "kg", poured: "m³", stripped: "m²" };
    const FMT = { m3: "#,##0.00", m2: "#,##0.00", kg: "#,##0", n: "0", date: bg ? "dd.mm.yyyy" : "yyyy-mm-dd", pct: "0%" };
    const fmtOf = (u) => (u === "kg" ? FMT.kg : FMT.m2);
    const INK = "FF1F1F1F", LINE = "FFD9D5CC", ACC = "FFE37424", SOFT = "FFF7F5F0", MUTED = "FF6B6B6B";
    const font = { name: "Ubuntu", size: 10 };
    const project = (state.project && state.project.name) || "";
    const wb = new ExcelJS.Workbook();
    wb.creator = "Arsten Pour status"; wb.created = new Date();
    wb.calcProperties.fullCalcOnLoad = true;

    function addSheet(name, note, cols, rows, freezeCols) {
      const ws = wb.addWorksheet(name, { views: [{ state: "frozen", xSplit: freezeCols || 0, ySplit: 3 }] });
      ws.getCell(1, 1).value = `${project} · ${L("Статус тактове", "Pour status")} · ${name} · ${S.today()}`;
      ws.getCell(1, 1).font = Object.assign({}, font, { size: 12, bold: true });
      ws.getCell(2, 1).value = note;
      ws.getCell(2, 1).font = Object.assign({}, font, { size: 9, italic: true, color: { argb: MUTED } });
      const hr = ws.getRow(3);
      hr.height = 32;
      cols.forEach((c, i) => {
        const cell = hr.getCell(i + 1);
        cell.value = c.h;
        cell.font = Object.assign({}, font, { bold: true, color: { argb: "FFFFFFFF" } });
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
        cell.alignment = { vertical: "middle", wrapText: true, horizontal: c.fmt && c.fmt !== FMT.date ? "right" : "left" };
        ws.getColumn(i + 1).width = c.w || 12;
      });
      rows.forEach((r, k) => {
        const row = ws.getRow(4 + k);
        r.forEach((v, i) => {
          const cell = row.getCell(i + 1);
          cell.value = v == null || v === "" ? null : v;
          cell.font = font;
          if (cols[i].fmt) cell.numFmt = cols[i].fmt;
          cell.border = { bottom: { style: "hair", color: { argb: LINE } } };
        });
      });
      const last = 3 + rows.length;
      if (rows.length) ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: last, column: cols.length } };
      if (cols.some((c) => c.sum)) {
        const tr = ws.getRow(last + 1);
        cols.forEach((c, i) => {
          const cell = tr.getCell(i + 1);
          if (i === 0) cell.value = L("Общо (видимите редове)", "Total (visible rows)");
          if (c.sum && rows.length) {
            const col = ws.getColumn(i + 1).letter;
            cell.value = { formula: `SUBTOTAL(109,${col}4:${col}${last})`, result: round(rows.reduce((s, r) => s + (typeof r[i] === "number" ? r[i] : 0), 0), 3) };
            cell.numFmt = c.fmt;
          }
          cell.font = Object.assign({}, font, { bold: true });
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SOFT } };
          cell.border = { top: { style: "medium", color: { argb: ACC } } };
        });
      }
      return ws;
    }

    const qtyNote = L("Количества от модела (Tekla): кофраж = страни + дъно (m²), армировка (kg), бетон (m³). ",
      "Quantities from the model (Tekla): formwork = sides + bottom (m²), rebar (kg), concrete (m³). ");
    const stepCols = () => S.STEPS.flatMap((st) => [
      { h: `${stepName(st)}, ${L("бр.", "pcs")}`, w: 10, fmt: FMT.n, sum: true },
      { h: `${stepName(st)}, ${UNIT[st.id]}`, w: 13, fmt: fmtOf(UNIT[st.id]), sum: true }]);
    const stepVals = (s) => S.STEPS.flatMap((st) => [s[st.id].n || null, s[st.id].n ? round(s[st.id].qty, 2) : null]);

    // 1) By month: what each step earned in the month of its date.
    addSheet(L("По месеци", "By month"),
      qtyNote + L("Всеки етап се отчита в месеца на датата си. Филтрирайте „Месец“ – редът „Общо“ сумира само видимите редове.",
        "Each step counts in the month of its date. Filter \"Month\": the Total row sums only the visible rows."),
      [{ h: L("Месец", "Month"), w: 11 }, { h: L("Тип", "Type"), w: 30 }, ...stepCols()],
      data.months.map((m) => [m.month || L("без дата", "no date"), m.type, ...stepVals(m)]), 2);
    // 2) By pour: progress and the quantities done so far.
    addSheet(L("По тактове", "By pour"), qtyNote,
      [{ h: L("Такт", "Pour"), w: 12 }, { h: L("Тип", "Type"), w: 30 }, { h: L("Обекти", "Objects"), w: 8, fmt: FMT.n, sum: true },
        { h: L("Бетон общо, m³", "Concrete total, m³"), w: 12, fmt: FMT.m3, sum: true }, { h: L("Армировка общо, kg", "Rebar total, kg"), w: 12, fmt: FMT.kg, sum: true },
        { h: L("Кофраж общо, m²", "Formwork total, m²"), w: 12, fmt: FMT.m2, sum: true }, ...stepCols(),
        { h: L("Излят, % обем", "Poured, % volume"), w: 10, fmt: FMT.pct }, { h: L("Последно излят", "Last poured"), w: 12, fmt: FMT.date }],
      data.pours.map((p) => [p.pour, p.types.join(", "), p.total, round(p.qty.volume, 3), round(p.qty.rebar, 1), round(p.qty.formwork, 2), ...stepVals(p.steps),
        p.qty.volume ? p.steps.poured.qty / p.qty.volume : null, toDate(p.lastPoured)]), 1);
    // 3) One row per pour object.
    {
      const cols = [{ h: L("Такт", "Pour"), w: 12 }, { h: L("Тип", "Type"), w: 28 }, { h: L("Елементи", "Parts"), w: 36 },
        { h: L("Бетон, m³", "Concrete, m³"), w: 10, fmt: FMT.m3, sum: true }, { h: L("Армировка, kg", "Rebar, kg"), w: 11, fmt: FMT.kg, sum: true },
        { h: L("Кофраж, m²", "Formwork, m²"), w: 10, fmt: FMT.m2, sum: true }, { h: L("Етап", "Stage"), w: 16 }];
      for (const st of S.STEPS) cols.push({ h: `${stepName(st)} – ${L("дата", "date")}`, w: 12, fmt: FMT.date }, { h: L("От", "By"), w: 16 }, { h: L("Бележка", "Note"), w: 20 });
      cols.push({ h: "IFC GUID", w: 24 }, { h: L("История", "History"), w: 60 });
      const rows = objs.map((o) => {
        const rec = state.records.get(o.guid) || {};
        const r = [o.pour, o.type, o.parts, o.volume, o.rebar, o.formwork, stepName(S.stageOf(rec))];
        for (const st of S.STEPS) r.push(rec[st.id] ? toDate(rec[`${st.id}_date`]) : null, rec[st.id] ? rec[`${st.id}_by`] : null, rec[st.id] ? rec[`${st.id}_note`] : null);
        r.push(o.guid, rec.log ? String(rec.log).replace(/\r?\n/g, " | ") : null);
        return r;
      });
      addSheet(L("Детайли", "Details"), qtyNote + L("Един ред на обект от такт.", "One row per pour object."), cols, rows, 1);
    }

    const buf = await wb.xlsx.writeBuffer();
    const name = `pour-status_${String(project || "project").replace(/[\\/:*?"<>|]+/g, "_").trim()}_${S.today()}.xlsx`;
    const url = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setStatus(`${L("Изтеглен", "Downloaded")} ${name} (${objs.length} ${L("обекта", "objects")})`);
  }

  // ---------- rendering ----------
  function render() {
    $("title").textContent = t("title");
    $("hSel").textContent = t("selection"); $("hSteps").textContent = t("steps"); $("hView").textContent = t("view");
    $("btnCsv").textContent = t("csv");
    $("hSummary").textContent = t("pours"); $("hOrphans").textContent = t("orphans");
    $("btnFromViewer").textContent = t("fromViewer"); $("btnSelClear").textContent = t("clear");
    $("lblFollow").textContent = t("follow"); $("chkFollow").checked = state.follow; $("btnFromViewer").hidden = state.follow;
    $("lblColour").textContent = t("colour");
    if (!state.ready) return;
    // selection
    const sel = state.sel;
    if (!sel.length) $("selText").innerHTML = `<span class="sub">${esc(t("nothing"))}</span>`;
    else {
      const byPour = new Map();
      for (const o of sel) { const k = o.group ? o.group.label : "?"; byPour.set(k, (byPour.get(k) || 0) + 1); }
      $("selText").innerHTML = `<b>${sel.length}</b> ${lang === "bg" ? "обекта" : "pour objects"} · ` +
        esc([...byPour].sort((a, b) => C.naturalCompare(a[0], b[0])).map(([k, n]) => (n > 1 ? `${k} (${n})` : k)).join(", "));
    }
    // steps
    const guids = sel.map((o) => o.guid);
    $("steps").innerHTML = S.STEPS.map((s, i) => {
      const st = S.stepState(state.records, guids, s.id);
      const label = !sel.length ? "" : st.state === "all" ? `✓ ${st.done}/${st.total}` : st.state === "mixed" ? `${st.done}/${st.total} ${t("done")}` : `0/${st.total}`;
      return `<div class="step" style="--c:${s.colour}">
        <div class="hd"><span class="nm">${i + 1}. ${esc(stepName(s))}</span><span class="st ${st.state}">${label}</span></div>
        ${st.dates.length ? `<div class="dates">${esc(st.dates.join(", "))}</div>` : ""}
        <div class="row"><input type="date" id="date_${s.id}" value="${S.today()}"><input type="text" id="note_${s.id}" placeholder="${esc(t("note"))}"></div>
        <div class="row"><button class="small" data-act="mark" data-step="${s.id}" ${sel.length ? "" : "disabled"}>${esc(t("markDone"))}</button><button
          class="small secondary" data-act="undo" data-step="${s.id}" ${st.done ? "" : "disabled"}>${esc(t("undo"))}</button></div></div>`;
    }).join("");
    // legend
    $("legend").innerHTML = STAGES.map((s, k) => `<span><span class="sw" style="background:${s.colour}${k === 0 ? `;opacity:${NOT_STARTED_OPACITY + 0.25}` : ""}"></span>${esc(stepName(s))}${k === 0 ? ` <span class="sub">(${lang === "bg" ? "прозрачно" : "see-through"})</span>` : ""}</span>`).join("");
    // summary
    const short = lang === "bg" ? ["Кофр.", "Арм.", "Излят", "Декофр."] : ["Form.", "Rebar", "Poured", "Stripped"];
    $("sumHead").innerHTML = `<tr><th>${esc(t("pour"))}</th>${short.map((h) => `<th class="n">${h}</th>`).join("")}<th></th></tr>`;
    const sum = S.summary(state.pours, state.records, (o) => o.guid);
    $("sumRows").innerHTML = sum.length ? sum.map((r, i) => `<tr><td><span class="name">${esc(r.label)}</span> <span class="sub">${r.total}</span></td>${S.STEPS.map((s) => {
        const n = r.steps[s.id];
        return `<td class="n ${n === 0 ? "zero" : n === r.total ? "full" : "part"}">${n}/${r.total}</td>`;
      }).join("")}<td><button class="small secondary" data-act="pickPour" data-i="${i}">${esc(t("select"))}</button></td></tr>`).join("")
      : `<tr><td colspan="6" class="empty">No pours.</td></tr>`;
    // orphans
    const present = new Set(state.objects.map((o) => o.guid));
    const orph = S.orphans(state.records, present, state.objects.map((o) => ({ guid: o.guid, key: o.key, pour: o.group && (o.group.numbered ? o.group.key : o.group.label), obj: o })));
    $("orphanBox").hidden = !orph.length;
    if (orph.length) {
      $("orphanText").textContent = lang === "bg"
        ? `${orph.length} записа със статус сочат към обекти, които вече ги няма в модела (вероятно Tekla е пресъздала такта). Свържете ги ръчно към новия обект.`
        : `${orph.length} status records point to objects that are no longer in the model (Tekla probably rebuilt the pour). Re-attach them to the new object.`;
      $("orphanRows").innerHTML = orph.map((x, i) => `<tr><td><span class="name">${esc(x.record.pour || "?")}</span>
          <div class="sub">${esc(x.record.stage || "")} · ${esc(x.guid)}</div></td>
        <td>${x.candidates.length ? `<button class="small" data-act="reattach" data-i="${i}" title="${esc(x.candidates.map((c) => c.guid).join(", "))}">${lang === "bg" ? "Прехвърли" : "Re-attach"} → ${x.candidates.length} ${x.exact ? "" : "?"}</button>` : `<span class="sub">${lang === "bg" ? "няма съвпадение" : "no match"}</span>`}</td></tr>`).join("");
      state.orphans = orph;
    }
  }

  // Re-attach an orphaned status: copy it to the candidate object(s) (the old record stays, for history).
  async function reattach(x) {
    const ok = window.confirm(lang === "bg"
      ? `Да се копира статусът (${x.record.stage}) към ${x.candidates.length} обект(а) от ${x.record.pour}?`
      : `Copy the status (${x.record.stage}) to ${x.candidates.length} object(s) of ${x.record.pour}?`);
    if (!ok) return;
    for (const c of x.candidates) {
      const props = Object.assign({}, x.record, { key: c.key });
      props.log = (props.log ? props.log + "\n" : "") + `${S.today()} re-attached from ${x.guid} by ${state.user}`;
      await state.client.write(state.lib.id, state.defId, S.entityLink(c.guid), props);
      state.records.set(c.guid, props);
    }
    render();
  }

  // ---------- wiring ----------
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    guarded(async () => {
      if (act === "mark") await applyStep(b.dataset.step, false);
      else if (act === "undo") await applyStep(b.dataset.step, true);
      else if (act === "pickPour") await selectPour(state.pours[+b.dataset.i]);
      else if (act === "reattach") await reattach(state.orphans[+b.dataset.i]);
    });
  });
  $("btnFromViewer").onclick = () => guarded(selectionFromViewer);
  $("btnCsv").onclick = () => guarded(exportExcel);
  $("chkFollow").onchange = (e) => {
    state.follow = e.target.checked;
    try { localStorage.setItem("arsten.pourStatus.follow", state.follow ? "1" : "0"); } catch {}
    render();
    if (state.follow && state.ready) guarded(() => selectionFromViewer(true));
  };
  // "Follow model selection": re-read the selection shortly after it changes in the viewer (debounced: one
  // click can fire several events).
  let followTimer = null;
  function onViewerSelection() {
    if (!state.follow || !state.ready || !state.api) return;
    clearTimeout(followTimer);
    followTimer = setTimeout(() => guarded(() => selectionFromViewer(true)), 200);
  }
  $("btnSelClear").onclick = () => { state.sel = []; render(); };
  $("chkColour").onchange = (e) => guarded(async () => { state.coloured = e.target.checked; await applyColours(); });
  $("selLang").value = lang;
  $("selLang").onchange = (e) => { lang = e.target.value; try { localStorage.setItem("arsten.pourStatus.lang", lang); } catch {} render(); if (!state.ready && state.client) guarded(start2); };

  async function start2() {
    const n = state.objects.length || (await loadPours());
    if (!n) return setStatus("No pour objects found. Load a Tekla IFC exported with Arsten_PourExport (property set Pour/Такт).", true);
    if (!(await setup())) { setStatus(""); return; }
    await loadRecords();
    state.ready = true;
    $("mainBox").hidden = false;
    setStatus(`${state.pours.length} ${lang === "bg" ? "такта" : "pours"}, ${n} ${lang === "bg" ? "обекта" : "pour objects"} · ${state.records.size} ${lang === "bg" ? "със статус" : "with status"}`);
    render();
  }
  async function start(api, client) {
    state.api = api;
    state.project = (await api.project.getProject()) || {};
    try { const u = await api.user.getUser(); state.user = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || ""; } catch {}
    state.client = client || new A.PsetClient({ region: state.project.location || "europe", getToken });
    render();
    await guarded(start2);
  }
  window.PourStatusApp = { start, state, onEvent: (e, d) => onEvent(e, d) };

  function onEvent(event, data) {
    if (event === "extension.accessToken") onToken(data);
    if (event === "viewer.onSelectionChanged") onViewerSelection();
    if (event === "viewer.onModelStateChanged" && state.api) { state.objects = []; state.sel = []; guarded(start2); }
  }
  if (window.parent === window) {
    if (/[?&]demo\b/.test(location.search)) { const s = document.createElement("script"); s.src = "demo.js?t=" + Date.now(); document.body.appendChild(s); }
    else setStatus("Not inside Trimble Connect. Add this extension to a project and open it from the 3D viewer side panel.", true);
    return;
  }
  TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000)
    .then((api) => start(api))
    .catch((e) => setStatus("Could not connect to Trimble Connect: " + errText(e), true));
})();
