// Pour status logic: the property-set definition stored in Trimble Connect, one status record per pour object
// (keyed by its IFC GUID), the four construction steps, history log, summaries and orphan matching.
// No network calls here: runs in the browser (window.PourStatus) and in Node tests (module.exports).
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.PourStatus = lib;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STEPS = [
    { id: "formwork", en: "Formwork done", bg: "Кофраж готов", colour: "#F2B705", na: true },
    { id: "rebar", en: "Rebar done", bg: "Армировка готова", colour: "#E37424", na: true },
    { id: "poured", en: "Poured", bg: "Излят", colour: "#2E7D32" },
    { id: "stripped", en: "Formwork removed", bg: "Декофриран", colour: "#1F4FD1", na: true },
  ];
  const NOT_STARTED = { id: "none", en: "Not started", bg: "Не е започнат", colour: "#9E9E9E" };

  // Definition "pourstatus" stored in the project library "CIP/Монолитно" (created once by a project admin in
  // Connect; the extension adds the definition). The earlier planned name is still accepted.
  const DEF_ID = "pourstatus";
  const LIB_NAME = "CIP/Монолитно";
  const LIB_NAMES = [LIB_NAME, "Arsten Pour Status"];
  const LOG_MAX = 4000;

  /** Property-set definition in the format Connect's own library editor writes (schema.props + i18n labels/order). */
  function definition() {
    const props = {}, labels = {}, order = [];
    const add = (id, schema, label) => { props[id] = schema; labels[id] = label; order.push(id); };
    add("stage", { type: "string" }, "Status / Статус");
    STEPS.forEach((s, i) => {
      const n = `${i + 1} ${s.en} / ${s.bg}`;
      add(s.id, { type: "boolean" }, n);
      // "Without": the step does not apply to this object (no formwork / no rebar). Counts as covered, earns nothing.
      if (s.na) add(`${s.id}_na`, { type: "boolean" }, `${i + 1} Without / Без`);
      add(`${s.id}_date`, { type: "string", format: "date" }, `${i + 1} Date / Дата`);
      add(`${s.id}_by`, { type: "string" }, `${i + 1} By / От`);
      add(`${s.id}_note`, { type: "string" }, `${i + 1} Note / Бележка`);
    });
    add("pour", { type: "string" }, "Pour / Такт");
    add("key", { type: "string" }, "Match key / Ключ");
    add("log", { type: "string" }, "History / История");   // "long-text" format is rejected by pset-api (422, 2026-11); length capped by LOG_MAX in code
    const orderProps = {};
    order.forEach((id, i) => { orderProps[id] = String(i); });
    return {
      id: DEF_ID,
      name: "Pour status / Статус такт",
      description: "Construction progress of a pour object (Arsten Pour status extension).",
      schema: { props },
      i18n: {
        "en-US": { name: "Pour status / Статус такт", props: labels },
        "__prop-order__": { name: "__prop-order__", props: orderProps },
      },
    };
  }

  /** Link of a model object, the format Connect's property panel uses (file-independent). */
  const entityLink = (guid) => `frn:entity:${guid}`;

  /** Today as YYYY-MM-DD in local time. */
  function today(d) {
    const x = d || new Date();
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  }

  /** Index of the furthest step done (0 = not started, 1..4). */
  function stageIndex(rec) {
    if (!rec) return 0;
    let k = 0;
    // A "without" step counts as progress once the step before it is covered (so formwork "without" = ready for rebar,
    // but the automatic stripped "without" only counts after the pour).
    STEPS.forEach((s, i) => {
      if (!rec[s.id]) return;
      if (!rec[`${s.id}_na`] || i === 0 || rec[STEPS[i - 1].id]) k = i + 1;
    });
    return k;
  }
  const stageOf = (rec) => (stageIndex(rec) ? STEPS[stageIndex(rec) - 1] : NOT_STARTED);

  function logLine(text, when) {
    const t = when || new Date();
    return `${today(t)} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")} ${text}`;
  }
  function appendLog(log, line) {
    const s = (log ? log + "\n" : "") + line;
    // keep the newest history within the field's max length
    return s.length > LOG_MAX ? s.slice(s.length - LOG_MAX).replace(/^[^\n]*\n/, "") : s;
  }

  /**
   * Mark a step done (or correct its date/note). Returns the new props to write.
   * @param rec existing props or null; info {date, by, note, pour, key}
   */
  function markStep(rec, stepId, info) {
    const step = STEPS.find((s) => s.id === stepId);
    if (!step) throw new Error("Unknown step " + stepId);
    const r = Object.assign({}, rec || {});
    const was = !!r[stepId] && !r[`${stepId}_na`];
    r[stepId] = true;
    if (r[`${stepId}_na`]) r[`${stepId}_na`] = false;
    r[`${stepId}_date`] = info.date || today();
    r[`${stepId}_by`] = info.by || "";
    r[`${stepId}_note`] = info.note || "";
    if (info.pour != null) r.pour = info.pour;
    if (info.key != null) r.key = info.key;
    r.stage = `${stageOf(r).en} / ${stageOf(r).bg}`;
    r.log = appendLog(r.log, logLine(`${was ? "corrected" : "done"}: ${step.en} ${r[`${stepId}_date`]} by ${info.by || "?"}${info.note ? " – " + info.note : ""}`, info.now));
    return r;
  }

  /** Undo a step: clears it, keeps the history. */
  function undoStep(rec, stepId, info) {
    const step = STEPS.find((s) => s.id === stepId);
    if (!step) throw new Error("Unknown step " + stepId);
    const r = Object.assign({}, rec || {});
    if (!r[stepId]) return r;
    r[stepId] = false;
    if (r[`${stepId}_na`] != null) r[`${stepId}_na`] = null;
    r[`${stepId}_date`] = null;   // "" is rejected for date fields (422); null clears
    r[`${stepId}_by`] = null;
    r[`${stepId}_note`] = null;
    r.stage = `${stageOf(r).en} / ${stageOf(r).bg}`;
    r.log = appendLog(r.log, logLine(`undone: ${step.en} by ${(info && info.by) || "?"}`, info && info.now));
    return r;
  }

  /**
   * Mark a step as "without" (does not apply: no formwork, no rebar). It counts as done for progress (the next step can go
   * ahead) but earns no quantity. Without formwork also means nothing to strip, so stripped is set to "without" too unless already done.
   */
  function markNa(rec, stepId, info) {
    const step = STEPS.find((s) => s.id === stepId);
    if (!step || !step.na) throw new Error("Step cannot be without: " + stepId);
    const one = (r, id, st) => {
      r[id] = true; r[`${id}_na`] = true;
      r[`${id}_date`] = info.date || today();
      r[`${id}_by`] = info.by || "";
      r[`${id}_note`] = info.note || "";
      r.log = appendLog(r.log, logLine(`without: ${st.en} ${r[`${id}_date`]} by ${info.by || "?"}${info.note ? " – " + info.note : ""}`, info.now));
    };
    const r = Object.assign({}, rec || {});
    one(r, stepId, step);
    if (stepId === "formwork" && !r.stripped) one(r, "stripped", STEPS.find((s) => s.id === "stripped"));
    if (info.pour != null) r.pour = info.pour;
    if (info.key != null) r.key = info.key;
    r.stage = `${stageOf(r).en} / ${stageOf(r).bg}`;
    return r;
  }
  const isNa = (rec, stepId) => !!(rec && rec[stepId] && rec[`${stepId}_na`]);

  /** Change only the note of a step that is done (date and who stay). Empty note clears it. */
  function setNote(rec, stepId, info) {
    const step = STEPS.find((s) => s.id === stepId);
    if (!step) throw new Error("Unknown step " + stepId);
    const r = Object.assign({}, rec || {});
    if (!r[stepId]) return r;
    const note = String((info && info.note) || "").trim();
    r[`${stepId}_note`] = note || null;
    r.log = appendLog(r.log, logLine(`note: ${step.en}${note ? " – " + note : " (cleared)"} by ${(info && info.by) || "?"}`, info && info.now));
    return r;
  }

  /** True when a field that had a value is now empty: PATCH only merges, so the pset has to be replaced. */
  function clearsField(cur, next) {
    if (!cur) return false;
    const empty = (v) => v == null || v === "";
    return Object.keys(cur).some((k) => !empty(cur[k]) && empty(next[k]));
  }

  /** Saved date and note of a step over the selected objects that have it done: the value if all agree, else mixed. */
  function stepValues(records, guids, stepId) {
    const dates = new Set(), notes = new Set();
    for (const g of guids) {
      const r = records.get(g);
      if (r && r[stepId]) { dates.add(r[`${stepId}_date`] || ""); notes.add(r[`${stepId}_note`] || ""); }
    }
    return { any: dates.size > 0, date: dates.size === 1 ? [...dates][0] : null, note: notes.size === 1 ? [...notes][0] : null,
      mixedDate: dates.size > 1, mixedNote: notes.size > 1 };
  }

  /**
   * State of a selection for one step: {done, total, dates:Set} -> "all", "none" or "mixed".
   * @param records Map guid -> props; guids of the selected pour objects
   */
  function stepState(records, guids, stepId) {
    let done = 0, na = 0;
    const dates = new Set();
    for (const g of guids) {
      const r = records.get(g);
      if (r && r[stepId]) { done++; if (r[`${stepId}_na`]) na++; else if (r[`${stepId}_date`]) dates.add(r[`${stepId}_date`]); }
    }
    const total = guids.length;
    return { done, na, total, dates: [...dates].sort(), state: !total || !done ? "none" : done === total ? "all" : "mixed" };
  }

  /** Per pour number: {key, label, total, steps:{formwork: n, ...}} in pour order. */
  function summary(pours, records, guidOf) {
    return pours.map((g) => {
      const steps = {};
      for (const s of STEPS) steps[s.id] = 0;
      for (const o of g.objects) {
        const r = records.get(guidOf(o));
        if (r) for (const s of STEPS) if (r[s.id]) steps[s.id]++;
      }
      return { key: g.key, label: g.label, total: g.objects.length, steps };
    });
  }

  /**
   * Fallback match key, stored with each record: pour number + parts + rounded centre of the bounding box.
   * Used only when a status's GUID is no longer in the model (e.g. Tekla rebuilt the pour objects).
   */
  function matchKey(pourNumber, parts, bbox, gridM) {
    const step = gridM || 0.5;
    let c = "";
    if (bbox) {
      const r = (v) => Math.round(v / step) * step;
      c = [(bbox.min.x + bbox.max.x) / 2, (bbox.min.y + bbox.max.y) / 2, bbox.min.z].map((v) => r(v).toFixed(1)).join(",");
    }
    return [String(pourNumber || "").trim().toUpperCase(), String(parts || "").trim(), c].join("|");
  }

  /**
   * Orphaned statuses: records whose GUID is not in the loaded model. For each, candidate pour objects with the same
   * match key (exact), else the same pour number. Never re-attached automatically.
   * @param records Map guid -> props; present Set of guids in the model; objects [{guid, key, pour}]
   */
  function orphans(records, present, objects) {
    const out = [];
    for (const [guid, r] of records) {
      if (present.has(guid) || !stageIndex(r)) continue;
      const exact = objects.filter((o) => r.key && o.key === r.key);
      const samePour = exact.length ? [] : objects.filter((o) => r.pour && o.pour === r.pour);
      out.push({ guid, record: r, candidates: exact.length ? exact : samePour, exact: exact.length > 0 });
    }
    return out;
  }

  /**
   * CSV of the status of every pour object, for Excel: ";" separated (Bulgarian/European Excel), UTF-8 with BOM so
   * Cyrillic opens correctly, one row per pour object.
   * @param rows [{pour, type, volume, parts, guid}] in the order to export
   * @param records Map guid -> props; lang "bg" | "en"
   */
  function toCsv(rows, records, lang) {
    const bg = lang !== "en";
    const yes = bg ? "Да" : "Yes", no = bg ? "Не" : "No";
    const head = [bg ? "Такт" : "Pour", bg ? "Тип" : "Type", bg ? "Обем бетон, m³" : "Concrete volume, m³", bg ? "Елементи" : "Parts",
      bg ? "Етап" : "Stage"];
    for (const st of STEPS) head.push(st[bg ? "bg" : "en"], bg ? "Дата" : "Date", bg ? "От" : "By", bg ? "Бележка" : "Note");
    head.push("IFC GUID", bg ? "История" : "History");
    const cell = (v) => {
      const t = String(v == null ? "" : v).replace(/\r?\n/g, " | ");
      return /[;"\n]/.test(t) || /^\s|\s$/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const lines = [head.map(cell).join(";")];
    for (const r of rows) {
      const rec = records.get(r.guid) || {};
      const line = [r.pour, r.type, r.volume, r.parts, stageOf(rec)[bg ? "bg" : "en"]];
      for (const st of STEPS) line.push(isNa(rec, st.id) ? (bg ? "Без" : "Without") : rec[st.id] ? yes : no, rec[st.id] ? rec[`${st.id}_date`] : "", rec[st.id] ? rec[`${st.id}_by`] : "", rec[st.id] ? rec[`${st.id}_note`] : "");
      line.push(r.guid, rec.log);
      lines.push(line.map(cell).join(";"));
    }
    return "﻿" + lines.join("\r\n") + "\r\n";
  }

  /**
   * Quantity each step "earns" for invoicing: formwork and stripping -> formwork area (sides + bottom, m²),
   * rebar -> rebar weight (kg), poured -> concrete volume (m³).
   */
  const STEP_QTY = { formwork: "formwork", rebar: "rebar", poured: "volume", stripped: "formwork" };

  /**
   * Invoicing figures. Each step is counted in the month of its date (YYYY-MM), per pour type.
   * @param objs [{pour, type, guid, volume, rebar, formwork}] (numbers); records Map guid -> props
   * @returns {months: [{month, type, formwork:{n, qty}, rebar:{...}, poured:{...}, stripped:{...}}],
   *           pours: [{pour, types, total, qty:{volume, rebar, formwork}, steps:{formwork:{n, qty}, ...}, lastPoured}]}
   */
  function invoiceData(objs, records) {
    const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
    const empty = () => { const s = {}; for (const st of STEPS) s[st.id] = { n: 0, qty: 0, na: 0 }; return s; };
    const months = new Map(), pours = new Map();
    for (const o of objs) {
      const rec = records.get(o.guid) || {};
      if (!pours.has(o.pour)) pours.set(o.pour, { pour: o.pour, types: new Set(), total: 0, qty: { volume: 0, rebar: 0, formwork: 0 }, steps: empty(), lastPoured: "" });
      const p = pours.get(o.pour);
      p.total++; if (o.type) p.types.add(o.type);
      for (const q of ["volume", "rebar", "formwork"]) p.qty[q] += num(o[q]);
      for (const st of STEPS) {
        if (!rec[st.id]) continue;
        if (rec[`${st.id}_na`]) { p.steps[st.id].na++; continue; }   // "without": nothing to invoice
        const qty = num(o[STEP_QTY[st.id]]);
        p.steps[st.id].n++; p.steps[st.id].qty += qty;
        const date = String(rec[`${st.id}_date`] || "");
        if (st.id === "poured" && date > p.lastPoured) p.lastPoured = date;
        const month = /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : "";
        const k = month + "|" + (o.type || "");
        if (!months.has(k)) months.set(k, Object.assign({ month, type: o.type || "" }, empty()));
        const m = months.get(k);
        m[st.id].n++; m[st.id].qty += qty;
      }
    }
    const cmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
    return {
      months: [...months.values()].sort((a, b) => (a.month || "9999").localeCompare(b.month || "9999") || cmp(a.type, b.type)),
      pours: [...pours.values()].map((p) => Object.assign(p, { types: [...p.types].sort(cmp) })),
    };
  }

  return { STEPS, NOT_STARTED, DEF_ID, LIB_NAME, LIB_NAMES, STEP_QTY, definition, entityLink, today, stageIndex, stageOf, markStep, undoStep,
    markNa, isNa, setNote, clearsField, stepValues, stepState, summary, matchKey, orphans, toCsv, invoiceData };
});
