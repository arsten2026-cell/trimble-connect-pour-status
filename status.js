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
    { id: "formwork", en: "Formwork done", bg: "Кофраж готов", colour: "#F2B705" },
    { id: "rebar", en: "Rebar done", bg: "Армировка готова", colour: "#E37424" },
    { id: "poured", en: "Poured", bg: "Излят", colour: "#2E7D32" },
    { id: "stripped", en: "Formwork removed", bg: "Декофриран", colour: "#1F4FD1" },
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
      add(`${s.id}_date`, { type: "string", format: "date" }, `${i + 1} Date / Дата`);
      add(`${s.id}_by`, { type: "string" }, `${i + 1} By / От`);
      add(`${s.id}_note`, { type: "string" }, `${i + 1} Note / Бележка`);
    });
    add("pour", { type: "string" }, "Pour / Такт");
    add("key", { type: "string" }, "Match key / Ключ");
    add("log", { type: "string" }   // "long-text" format is rejected by pset-api (422, 2026-11); length capped in code, "History / История");
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
    STEPS.forEach((s, i) => { if (rec[s.id]) k = i + 1; });
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
    const was = !!r[stepId];
    r[stepId] = true;
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
    r[`${stepId}_date`] = "";
    r[`${stepId}_by`] = "";
    r[`${stepId}_note`] = "";
    r.stage = `${stageOf(r).en} / ${stageOf(r).bg}`;
    r.log = appendLog(r.log, logLine(`undone: ${step.en} by ${(info && info.by) || "?"}`, info && info.now));
    return r;
  }

  /**
   * State of a selection for one step: {done, total, dates:Set} -> "all", "none" or "mixed".
   * @param records Map guid -> props; guids of the selected pour objects
   */
  function stepState(records, guids, stepId) {
    let done = 0;
    const dates = new Set();
    for (const g of guids) {
      const r = records.get(g);
      if (r && r[stepId]) { done++; if (r[`${stepId}_date`]) dates.add(r[`${stepId}_date`]); }
    }
    const total = guids.length;
    return { done, total, dates: [...dates].sort(), state: !total || !done ? "none" : done === total ? "all" : "mixed" };
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

  return { STEPS, NOT_STARTED, DEF_ID, LIB_NAME, LIB_NAMES, definition, entityLink, today, stageIndex, stageOf, markStep, undoStep,
    stepState, summary, matchKey, orphans };
});
