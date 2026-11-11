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
    fromViewer: ["Вземи от модела", "Use viewer selection"], follow: ["Следи избора в модела", "Follow model selection"], csv: ["Експорт CSV", "Export CSV"], clear: ["Изчисти", "Clear"],
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

  // ---------- CSV export ----------
  /** One row per pour object (sorted by pour number, then type), with every step's date/who/note and the history. */
  function exportCsv() {
    if (!state.ready) return;
    const rows = state.objects.map((o) => ({
      pour: o.group ? o.group.label : (o.props && o.props[C.P.number]) || "",
      type: (o.props && o.props[C.P.type]) || "",
      volume: (o.props && o.props[C.P.volume]) || "",
      parts: (o.props && o.props[C.P.parts]) || "",
      guid: o.guid,
    })).sort((a, b) => C.naturalCompare(a.pour, b.pour) || C.naturalCompare(String(a.type), String(b.type)) || C.naturalCompare(String(a.parts), String(b.parts)));
    const csv = S.toCsv(rows, state.records, lang);
    const name = `pour-status_${String((state.project && state.project.name) || "project").replace(/[\\/:*?"<>|]+/g, "_").trim()}_${S.today()}.csv`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setStatus(`${lang === "bg" ? "Изтеглен" : "Downloaded"} ${name} (${rows.length} ${lang === "bg" ? "обекта" : "objects"})`);
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
  $("btnCsv").onclick = () => guarded(exportCsv);
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
