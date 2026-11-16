// Arsten pset links of model objects ("$" links, F4, owner 16.11.2026).
// Trimble's FRN notation wants every link segment URL-encoded, and Connect's own property panel and Tekla's
// "Synchronize property sets" look an IFC GUID up encoded: "$" -> "%24" (about 30% of pour objects have a "$").
// Records written with a raw "$" are stored and returned by pset-api, but never shown there. So every write goes to
// entLink(guid); the raw form (legacyLink) is still read, and "Премести" moves it. Same rules as Стомана
// (viewer-assembly-status v16-v22, readBoth / moveLegacy):
//   move  - only the raw record exists: shown as it is; moved = copied to the encoded link, raw deleted;
//   stale - the raw one is an old copy already contained in the encoded record (same, or its last history line is in
//           the encoded history): the encoded record is shown; the raw one is only deleted;
//   merge - both exist and the raw one has history the encoded one lacks (an old cached client wrote it after the move):
//           its fields win, the histories are joined; moved = changed fields + missing history lines patched in.
// Pure, no network. Browser: window.ArstenLinks; Node: require.
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.ArstenLinks = lib;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PREFIX = "frn:entity:";
  /** Link of a model object as Connect and Tekla look it up (URL-encoded GUID). */
  const entLink = (guid) => PREFIX + encodeURIComponent(guid);
  /** Raw link written before the fix (GUID as it is). */
  const legacyLink = (guid) => PREFIX + guid;
  /** True when encoding changes the link (the GUID has "$" or another reserved character). */
  const hasLegacy = (guid) => entLink(guid) !== legacyLink(guid);
  /** GUID of a link in either form ("%24" and "$" both give "$"). */
  function guidOfLink(link) {
    const g = String(link || "").replace(/^frn:entity:/, "");
    try { return decodeURIComponent(g); } catch { return g; }
  }
  /** True when the link is in the old raw form (not what entLink would write for its GUID). */
  const isLegacyLink = (link) => String(link || "") !== entLink(guidOfLink(link));

  const lastLine = (log) => String(log || "").split("\n").filter(Boolean).pop() || "";
  const linesOf = (log) => String(log || "").split("\n").filter(Boolean);
  /** History lines of the raw record that the encoded one lacks (whole lines; shared lines are never added twice). */
  function missingLines(encLog, rawLog) {
    const have = new Set(linesOf(encLog));
    return linesOf(rawLog).filter((l) => !have.has(l));
  }
  /** Join a history and extra lines, keeping the newest within max characters, cut at a whole line (as appendLog). */
  function joinLog(log, extra, max) {
    const s = [log, ...extra].filter(Boolean).join("\n");
    if (!max || s.length <= max) return s;
    const cut = s.slice(s.length - max);
    return s[s.length - max - 1] === "\n" ? cut : cut.replace(/^[^\n]*\n/, "");
  }
  /** The raw record is an old copy already contained in the encoded one. */
  function isStale(raw, enc) {
    const rl = lastLine(raw.log);
    return JSON.stringify(raw) === JSON.stringify(enc) || (rl !== "" && String(enc.log || "").includes(rl));
  }
  /** "move" | "stale" | "merge" for a raw record next to the encoded one (props or null); null when there is no raw one. */
  function classify(encodedRec, rawRec) {
    if (!rawRec) return null;
    if (!encodedRec) return "move";
    return isStale(rawRec, encodedRec) ? "stale" : "merge";
  }
  /** The record to show for a GUID: encoded wins, except "move" (raw only) and "merge" (raw fields win, histories joined). */
  function combine(encodedRec, rawRec) {
    const kind = classify(encodedRec, rawRec);
    if (!kind || kind === "stale") return encodedRec || null;
    if (kind === "move") return rawRec;
    return Object.assign({}, encodedRec, rawRec, { log: joinLog(encodedRec.log, missingLines(encodedRec.log, rawRec.log)) });
  }

  /**
   * Records of one definition from the two reads: enc = entries [link, props] read under entLink, raw = entries read
   * under legacyLink (Maps or arrays; links in any form are decoded to the GUID).
   * @returns {records: Map guid -> props, legacy: [{guid, kind}]} - legacy lists every raw record still to move/delete.
   */
  function resolve(enc, raw) {
    const cur = new Map(), old = new Map();
    for (const [l, p] of enc || []) if (p) cur.set(guidOfLink(l), p);
    for (const [l, p] of raw || []) if (p) old.set(guidOfLink(l), p);
    const records = new Map(cur), legacy = [];
    for (const [g, p] of old) {
      if (!hasLegacy(g)) { if (!cur.has(g)) records.set(g, p); continue; }   // same link both ways: nothing to move
      const kind = classify(cur.get(g) || null, p);
      legacy.push({ guid: g, kind });
      records.set(g, combine(cur.get(g) || null, p));
    }
    return { records, legacy };
  }
  /**
   * resolve() for a panel that reads its model objects directly (readMany of both forms) and also lists the whole
   * definition (listAll, any link form, for objects no longer in the model). Listed entries of GUIDs that were read
   * directly are ignored, so a list that returns links in another form can never invent a second record.
   * @param o {enc, raw, listed, known: Set of GUIDs read directly}
   */
  function collect(o) {
    const known = o.known || new Set(), enc = [...(o.enc || [])], raw = [...(o.raw || [])];
    for (const [l, p] of o.listed || []) {
      if (known.has(guidOfLink(l))) continue;
      (isLegacyLink(l) ? raw : enc).push([l, p]);
    }
    return resolve(enc, raw);
  }

  /**
   * What "Премести" writes to the encoded link, from both records read fresh: raw only -> the raw record; "merge" ->
   * the raw fields that differ plus the history lines the encoded one lacks (capped at logMax); "stale" -> nothing
   * (fields the encoded record lacks were cleared on purpose). null = nothing to write, only delete the raw one.
   */
  function movePatch(kind, encodedRec, rawRec, logMax) {
    if (!rawRec) return null;
    if (!encodedRec) return rawRec;
    if (kind !== "merge") return null;
    const patch = {};
    for (const [k, v] of Object.entries(rawRec)) if (k !== "log" && JSON.stringify(v) !== JSON.stringify(encodedRec[k])) patch[k] = v;
    const extra = missingLines(encodedRec.log, rawRec.log);
    if (extra.length) patch.log = joinLog(encodedRec.log, extra, logMax || 4000);
    return Object.keys(patch).length ? patch : null;
  }

  /**
   * GUIDs with a raw form ("$") that a list returned but that were not read directly (objects no longer in the model).
   * The list may return a link in either form, so these must be read under BOTH links (readMany) before they are
   * classified; collect() then gets them as enc/raw reads and in `known` (M3).
   */
  function listedToRead(listed, known) {
    const out = new Set();
    for (const [l] of listed || []) { const g = guidOfLink(l); if (hasLegacy(g) && !(known && known.has(g))) out.add(g); }
    return [...out];
  }

  /**
   * Write one record under its encoded link and take care of its raw-"$" copy (same rule in every panel, M1/M2).
   *  ops: {write(link, props), replace(link, props), remove(link)} - async; write = PATCH (merge), replace = delete + re-create.
   *  o:   {replace: bool, kind: "move"|"stale"|"merge"|null (from resolve().legacy), shown: the record shown for the GUID}
   *  - A partial write (not replace) on "move" / "merge" starts from the shown (merged) record, so raw fields and history
   *    are never lost when the raw copy is dropped.
   *  - replace with a raw copy: the full record is first PATCHed to the encoded link (from then on the raw copy is
   *    "stale"), then the raw copy is deleted, and only then is the encoded one replaced. A failed step throws before the
   *    next one, so an old raw copy is never left alone to be shown as current.
   *  - write with a raw copy: write, then delete the raw copy; a failed delete is only reported (dropped: false), the raw
   *    copy is then "stale" on the next load.
   * Returns {body, dropped}: body = what the encoded record now holds (as sent); dropped = the raw copy is gone.
   */
  async function putRecord(ops, guid, props, o) {
    o = o || {};
    const kind = o.kind || null, enc = entLink(guid);
    const raw = kind && hasLegacy(guid) ? legacyLink(guid) : null;
    const body = !o.replace && (kind === "move" || kind === "merge") ? Object.assign({}, o.shown || {}, props) : props;
    if (!raw) { await (o.replace ? ops.replace : ops.write)(enc, body); return { body, dropped: false }; }
    if (o.replace) {
      await ops.write(enc, body);
      await ops.remove(raw);
      await ops.replace(enc, body);
      return { body, dropped: true };
    }
    await ops.write(enc, body);
    try { await ops.remove(raw); return { body, dropped: true }; }
    catch (e) { if (typeof console !== "undefined") console.warn("raw link not deleted", guid, e); return { body, dropped: false }; }
  }

  return { PREFIX, entLink, legacyLink, hasLegacy, guidOfLink, isLegacyLink, isStale, classify, combine, resolve, collect, movePatch, missingLines, joinLog, listedToRead, putRecord };
});
