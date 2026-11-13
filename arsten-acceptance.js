// Arsten acceptance (приемане) of formwork / rebar by the structural designer, from site photos.
// Decided with the user 13.11.2026:
//  - photos uploaded "За приемане – Кофраж / Армировка" open an acceptance request per pour and step;
//    more photos for the same pour+step join the open request; a rejected one reopens with new photos;
//  - the contractor sends everything not yet sent with ONE button -> ONE Connect ToDo for the group
//    "4.1-STRUCTURAL DESIGNER" (only that group may approve: ArstenAccess capability "approve");
//  - decision: approved / approved with remarks / rejected (remarks and rejection need a comment), with history;
//  - Pour status only WARNS when "Излят" is marked while the rebar of that pour is not approved.
// Records: definition "acceptance" in the pour library, link frn:entity:ARSTENACC-{projectId}-{id}. Pure, no network.
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.ArstenAcceptance = lib;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEF_ID = "acceptance";
  // "both": formwork and rebar accepted in one go (e.g. foundations, user 13.11.2026); its decision covers both steps.
  const STEPS = { formwork: { bg: "Кофраж", en: "Formwork" }, rebar: { bg: "Армировка", en: "Rebar" }, both: { bg: "Кофраж и армировка", en: "Formwork and rebar" } };
  const STATUS = {
    open: { bg: "Чака приемане", en: "Awaiting acceptance", colour: "#E37424" },
    approved: { bg: "Одобрено", en: "Approved", colour: "#2E7D32" },
    remarks: { bg: "Одобрено със забележки", en: "Approved with remarks", colour: "#7CB342" },
    rejected: { bg: "Не се приема", en: "Rejected", colour: "#C62828" },
  };
  const APPROVER_GROUP = "STRUCTURAL DESIGNER";   // matched like ArstenAccess.groupKey ("4.1-STRUCTURAL DESIGNER")
  const LOG_MAX = 6000;

  function definition() {
    const S = { type: "string" };
    const fields = [
      ["step", S, "Step / Етап"], ["pour", S, "Pour / Такт"], ["status", S, "Status / Статус"],
      ["photos", S, "Photo file ids / Снимки"], ["objects", S, "Objects (JSON) / Обекти"],
      ["requested", S, "Requested / Заявено"], ["requested_by", S, "Requested by / Заявил"],
      ["sent", S, "Sent / Изпратено"], ["todo_id", S, "ToDo"],
      ["decided", S, "Decided / Решено"], ["decided_by", S, "Decided by / Решил"], ["comment", S, "Comment / Коментар"],
      ["log", S, "History / История"]];
    const props = {}, labels = {}, order = {};
    fields.forEach(([k, s, l], i) => { props[k] = s; labels[k] = l; order[k] = String(i); });
    return { id: DEF_ID, name: "Acceptance / Приемане", description: "Arsten acceptance of formwork / rebar (structural designer).", schema: { props },
      i18n: { "en-US": { name: "Acceptance / Приемане", props: labels }, "__prop-order__": { name: "__prop-order__", props: order } } };
  }
  const prefix = (projectId) => `frn:entity:ARSTENACC-${projectId}-`;
  const link = (projectId, id) => prefix(projectId) + id;

  const pad = (n) => String(n).padStart(2, "0");
  const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const addLog = (log, line) => { const s = (log ? log + "\n" : "") + line; return s.length > LOG_MAX ? s.slice(s.length - LOG_MAX) : s; };
  const ids = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
  const parseObjects = (s) => { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };
  const isLive = (r) => r.status === "open" || r.status === "rejected";
  /** Fields left empty ("") are CLEARED on the server only when the record is written with PsetClient.replace (a PATCH
   *  drops empty values and keeps the old ones – review 13.11.2026). Writers therefore re-read the record, apply the
   *  change to that fresh copy and save it with replace().
   *  The whole record to write (all fields, without the link). Every write sends the full record: pset-api can merge a
   *  PATCH onto a stale copy when two writes come seconds apart, which lost a request's fields live on 13.11.2026. */
  const full = (r, props) => { const o = Object.assign({}, r, props); delete o.link; return o; };
  /** A usable request (old broken records without pour/step are skipped). */
  const valid = (r) => !!(r && r.pour && STEPS[r.step]);

  /**
   * New photos for acceptance. One request per pour label and step: joins a live (open/rejected) one, else a new one.
   * @param records [{link, step, pour, status, photos, objects, ...}]
   * @param p {projectId, step, objects: [{modelId, guid, label}], photoIds: [...], by, now, newId: () => string}
   * @returns {writes: [{link, props, created}]}
   */
  function attachPhotos(records, p) {
    if (!STEPS[p.step]) throw new Error("unknown step " + p.step);
    const now = p.now || new Date(), byPour = new Map();
    for (const o of p.objects) { const k = String(o.label || "").trim() || "?"; if (!byPour.has(k)) byPour.set(k, []); byPour.get(k).push(o); }
    const writes = [];
    for (const [pour, objs] of byPour) {
      const cur = records.filter((r) => valid(r) && r.step === p.step && r.pour === pour && isLive(r)).sort((a, b) => (a.requested < b.requested ? 1 : -1))[0];
      if (cur) {
        const objects = parseObjects(cur.objects);
        for (const o of objs) if (!objects.some((x) => x.guid === o.guid)) objects.push({ modelId: o.modelId, guid: o.guid, label: pour });
        const props = { photos: [...new Set([...ids(cur.photos), ...p.photoIds])].join(","), objects: JSON.stringify(objects) };
        let line = `${stamp(now)} photos +${p.photoIds.length} by ${p.by || "?"}`;
        if (cur.status === "rejected") { Object.assign(props, { status: "open", sent: "", todo_id: "", decided: "", decided_by: "", comment: "" }); line += " – reopened after rejection"; }
        props.log = addLog(cur.log, line);
        writes.push({ link: cur.link, props: full(cur, props), created: false });
      } else {
        const id = p.newId();
        writes.push({ link: link(p.projectId, id), created: true, props: {
          step: p.step, pour, status: "open", photos: p.photoIds.join(","),
          objects: JSON.stringify(objs.map((o) => ({ modelId: o.modelId, guid: o.guid, label: pour }))),
          requested: stamp(now), requested_by: p.by || "", sent: "", todo_id: "", decided: "", decided_by: "", comment: "",
          log: `${stamp(now)} requested (${p.step}, ${p.photoIds.length} photos) by ${p.by || "?"}` } });
      }
    }
    return { writes };
  }

  /** Open requests not yet sent to the designer. */
  const toSend = (records) => records.filter((r) => valid(r) && r.status === "open" && !r.sent);

  /** ONE ToDo for all of them, assigned to the approver group. */
  function todoBody(requests, p) {
    const bg = p.lang !== "en", n = requests.length;
    const lines = requests.slice().sort((a, b) => (a.pour + a.step < b.pour + b.step ? -1 : 1))
      .map((r) => `• ${r.pour} – ${STEPS[r.step][bg ? "bg" : "en"]} (${ids(r.photos).length} ${bg ? "снимки" : "photos"}, ${r.requested_by || "?"} ${r.requested || ""})`);
    return {
      title: bg ? `За приемане: ${n} ${n === 1 ? "заявка" : "заявки"} (${stamp(p.now || new Date()).slice(0, 10)})` : `For acceptance: ${n} request${n === 1 ? "" : "s"} (${stamp(p.now || new Date()).slice(0, 10)})`,
      description: (bg ? "Моля, прегледайте и приемете в панела „Приемане“ в 3D изгледа на Trimble Connect:\n" : "Please review and decide in the \"Acceptance\" panel of the Trimble Connect 3D viewer:\n") + lines.join("\n"),
      type: "Request", priority: "NORMAL", status: "NEW", projectId: p.projectId,
      assignees: p.groupId ? [{ id: p.groupId, type: "GROUP" }] : [],
    };
  }
  /** Props to write on each request once the ToDo exists. */
  const markSent = (r, todoId, by, now) => full(r, { sent: stamp(now || new Date()), todo_id: todoId || "", log: addLog(r.log, `${stamp(now || new Date())} sent to the designer by ${by || "?"}${todoId ? " (ToDo " + todoId + ")" : ""}`) });

  /** Decision by the approver. remarks / rejected need a comment. Returns the props to write. */
  function decide(r, d) {
    if (!STATUS[d.decision] || d.decision === "open") throw new Error("unknown decision " + d.decision);
    const comment = String(d.comment || "").trim();
    if ((d.decision === "remarks" || d.decision === "rejected") && !comment) throw Object.assign(new Error("comment required"), { code: "comment" });
    const now = d.now || new Date();
    return full(r, { status: d.decision, decided: stamp(now), decided_by: d.by || "", comment,
      log: addLog(r.log, `${stamp(now)} ${d.decision} by ${d.by || "?"}${comment ? " – " + comment : ""}`) });
  }

  /** Latest request of a pour and step (or null). */
  function latest(records, pour, step) {
    return records.filter((r) => valid(r) && r.pour === pour && r.step === step).sort((a, b) => (a.requested < b.requested ? 1 : -1))[0] || null;
  }
  /** Latest request that covers a step: its own requests and the combined "both" ones. */
  function latestCovering(records, pour, step) {
    return records.filter((r) => valid(r) && r.pour === pour && (r.step === step || r.step === "both")).sort((a, b) => (a.requested < b.requested ? 1 : -1))[0] || null;
  }
  /**
   * Colour state of each pour for the model view: for every step shown, the latest request covering it; the pour takes
   * the "worst" of them (rejected > open > remarks > approved). step: "all" | "formwork" | "rebar".
   * @returns [{pour, status, objects: [{modelId, guid}]}]
   */
  function pourStates(records, step) {
    const RANK = { rejected: 4, open: 3, remarks: 2, approved: 1 };
    const rs = records.filter(valid), pours = [...new Set(rs.map((r) => r.pour))], out = [];
    for (const pour of pours) {
      const steps = step === "formwork" || step === "rebar" ? [step] : ["formwork", "rebar"];
      const latestOf = steps.map((s) => latestCovering(rs, pour, s)).filter(Boolean);
      if (!latestOf.length) continue;
      const worst = latestOf.reduce((a, b) => ((RANK[b.status] || 0) > (RANK[a.status] || 0) ? b : a));
      const objs = new Map();
      for (const r of rs.filter((x) => x.pour === pour)) for (const o of parseObjects(r.objects)) objs.set(o.modelId + ":" + o.guid, { modelId: o.modelId, guid: o.guid });
      out.push({ pour, status: worst.status, objects: [...objs.values()] });
    }
    return out;
  }
  /** Pours (labels) whose rebar is not approved (no request, open or rejected) – for the warning on "Излят". */
  function rebarNotApproved(records, pours) {
    return [...new Set(pours)].filter((p) => { const r = latestCovering(records, p, "rebar"); return !r || !(r.status === "approved" || r.status === "remarks"); });
  }

  return { DEF_ID, STEPS, STATUS, APPROVER_GROUP, full, valid, definition, prefix, link, attachPhotos, toSend, todoBody, markSent, decide, latest, latestCovering, pourStates, rebarNotApproved, parseObjects, ids };
});
