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
    // Quantity each step earned when it was marked (frozen for invoicing), and the object's outline and volume at
    // marking (to recognise pieces when Tekla splits the pour later). Strings: plain numbers / "minx,miny,minz,maxx,maxy,maxz".
    STEPS.forEach((s, i) => add(`${s.id}_qty`, { type: "string" }, `${i + 1} Quantity / Количество`));
    add("snap_bbox", { type: "string" }, "Outline at marking / Габарит при отбелязване");
    add("snap_volume", { type: "string" }, "Volume at marking / Обем при отбелязване");
    add("split_from", { type: "string" }, "Split from / Разделен от");
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

  const numText = (v) => String(Math.round(v * 1000) / 1000);
  const bboxText = (b) => (b ? [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map(numText).join(",") : "");
  function bboxOf(v) {
    if (!v) return null;
    if (typeof v === "object") return v.min && v.max ? v : null;
    const n = String(v).split(",").map(Number);
    return n.length === 6 && n.every(isFinite) ? { min: { x: n[0], y: n[1], z: n[2] }, max: { x: n[3], y: n[4], z: n[5] } } : null;
  }
  /** Outline and volume of the object the first time it gets a status (info.snap = {bbox, volume}). */
  function snapshot(r, info) {
    const sn = info && info.snap;
    if (!sn || r.snap_bbox) return;
    if (sn.bbox) r.snap_bbox = bboxText(sn.bbox);
    if (sn.volume != null && isFinite(sn.volume)) r.snap_volume = numText(sn.volume);
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
    if (info.qty != null && isFinite(info.qty) && (!was || r[`${stepId}_qty`] == null)) r[`${stepId}_qty`] = numText(info.qty);   // a correction keeps the frozen quantity
    snapshot(r, info);
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
    if (r[`${stepId}_qty`] != null) r[`${stepId}_qty`] = null;
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
    snapshot(r, info);
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
        const frozen = parseFloat(rec[`${st.id}_qty`]);
        const qty = isFinite(frozen) ? frozen : num(o[STEP_QTY[st.id]]);   // frozen at marking, else the model's
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

  // ---------- pour split by Tekla (pour break added after formwork/rebar were done) ----------
  const AXES = ["x", "y", "z"];
  const maxDim = (b) => Math.max(...AXES.map((a) => b.max[a] - b.min[a]));
  // Tolerance per axis: 1% of the reference box's size along that axis (so a thin slab is not "inside" with a whole layer below).
  const tolOf = (b, a) => 0.01 * (b.max[a] - b.min[a]) + 1e-9 * maxDim(b);
  const inside = (c, p) => AXES.every((a) => c.min[a] >= p.min[a] - tolOf(p, a) && c.max[a] <= p.max[a] + tolOf(p, a));
  const overlaps = (c, p) => AXES.every((a) => Math.min(c.max[a], p.max[a]) - Math.max(c.min[a], p.min[a]) > tolOf(p, a));
  const boxVol = (b) => AXES.reduce((v, a) => v * Math.max(0, b.max[a] - b.min[a]), 1);
  const overlapShare = (c, p) => { const v = boxVol(c); return v > 0 ? AXES.reduce((t, a) => t * Math.max(0, Math.min(c.max[a], p.max[a]) - Math.max(c.min[a], p.min[a])), 1) / v : 0; };
  const touches = (c, p) => AXES.every((a) => Math.min(c.max[a], p.max[a]) - Math.max(c.min[a], p.min[a]) >= -tolOf(p, a));
  const partTokens = (s) => new Set(String(s || "").split(";").map((x) => x.replace(/\s+x\d+\s*$/, "").trim()).filter(Boolean));
  const INHERIT = ["formwork", "rebar"];   // what a piece of a split pour inherits; never poured/stripped
  const hasSteps = (r) => !!r && STEPS.some((s) => r[s.id]);

  /**
   * Pours that Tekla split after formwork/rebar were marked: for each such status, the new objects (no status) that are
   * pieces of it. With the outline saved at marking: pieces fully inside it are children, pieces only overlapping it are
   * "partial" (offered unticked); the volumes of kept + children should add up to the volume at marking. Records from
   * before outlines were saved: pieces with the same pour number that touch the kept object and share parts (less sure).
   * @param objects [{guid, pour, parts, bbox, volume, key}] all pour objects in the model
   */
  function splits(records, objects) {
    const byGuid = new Map(objects.map((o) => [o.guid, o]));
    const free = objects.filter((o) => o.bbox && !hasSteps(records.get(o.guid)));
    const out = [];
    for (const [guid, r] of records) {
      const steps = INHERIT.filter((id) => r[id]);
      if (!steps.length || r.poured) continue;
      const cur = byGuid.get(guid) || null;
      const snap = bboxOf(r.snap_bbox), snapVol = parseFloat(r.snap_volume);
      let children = [], partial = [], exact = false, sumVol = null, volOk = null;
      // A piece keeps (some of) the original's parts: a split wall is still wall. Anchors, lean concrete etc. inside the
      // outline are other pour objects, not pieces. Older exports without Parts: no filter.
      const [, oldParts, oldCentre] = String(r.key || "").split("|");
      const tokens = partTokens(oldParts);
      const sameParts = (o) => !tokens.size || [...partTokens(o.parts)].some((tk) => tokens.has(tk));
      if (snap) {
        const shrunk = cur && ((isFinite(snapVol) && cur.volume != null && cur.volume < snapVol * 0.99) || (cur.bbox && !inside(snap, cur.bbox)));
        if (cur && !shrunk) continue;
        for (const o of free) {
          if (o.guid === guid || !sameParts(o)) continue;
          if (inside(o.bbox, snap)) children.push(o);
          else if (overlaps(o.bbox, snap) && overlapShare(o.bbox, snap) >= 0.2) partial.push(o);
        }
        exact = true;
        if (isFinite(snapVol)) {
          sumVol = ((cur && cur.volume) || 0) + children.reduce((t, o) => t + (o.volume || 0), 0);
          volOk = Math.abs(sumVol - snapVol) <= Math.max(0.02 * snapVol, 0.001);
        }
      } else {
        if (!cur || !cur.bbox || !r.key) continue;
        const [, , newCentre] = String(cur.key || "").split("|");
        if (oldCentre === newCentre || !tokens.size) continue;   // geometry unchanged (a renumber alone is not a split)
        children = free.filter((o) => o.guid !== guid && o.pour === r.pour && touches(o.bbox, cur.bbox) && sameParts(o));
      }
      if (children.length || partial.length) out.push({ guid, record: r, present: !!cur, exact, steps, children, partial, sumVol, snapVol: isFinite(snapVol) ? snapVol : null, volOk });
    }
    return out;
  }

  /** Status for a piece of a split pour: the parent's formwork/rebar (date, who, note, "without"). Quantity already
   *  frozen on the parent is not counted again (0); otherwise the piece's own model quantity applies. */
  function inherit(parent, parentGuid, info) {
    const r = {};
    for (const id of INHERIT) {
      if (!parent[id]) continue;
      for (const f of ["", "_na", "_date", "_by", "_note"]) if (parent[id + f] != null && parent[id + f] !== "") r[id + f] = parent[id + f];
      if (parent[`${id}_qty`] != null) r[`${id}_qty`] = "0";
      r.log = appendLog(r.log, logLine(`inherited: ${STEPS.find((s) => s.id === id).en} ${parent[`${id}_date`] || ""} (${parent[`${id}_by`] || "?"}) from ${parentGuid} – pour break, by ${info.by || "?"}`, info.now));
    }
    r.split_from = parentGuid;
    snapshot(r, info);
    if (info.pour != null) r.pour = info.pour;
    if (info.key != null) r.key = info.key;
    r.stage = `${stageOf(r).en} / ${stageOf(r).bg}`;
    return r;
  }

  /** After a split was handled (or dismissed): the parent's outline/volume/key become the current ones, with a log line. */
  function splitDone(parent, info) {
    const r = Object.assign({}, parent);
    if (info.snap && info.snap.bbox) r.snap_bbox = bboxText(info.snap.bbox);
    if (info.snap && info.snap.volume != null && isFinite(info.snap.volume)) r.snap_volume = numText(info.snap.volume);
    if (info.key != null) r.key = info.key;
    if (info.pour != null) r.pour = info.pour;
    r.log = appendLog(r.log, logLine(info.pieces ? `split: ${info.pieces} new piece(s) got formwork/rebar, by ${info.by || "?"}` : `split checked, nothing passed on, by ${info.by || "?"}`, info.now));
    return r;
  }

  return { STEPS, NOT_STARTED, DEF_ID, LIB_NAME, LIB_NAMES, STEP_QTY, definition, entityLink, today, stageIndex, stageOf, markStep, undoStep,
    markNa, isNa, setNote, splits, inherit, splitDone, bboxText, clearsField, stepValues, stepState, summary, matchKey, orphans, toCsv, invoiceData };
});
