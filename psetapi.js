// Minimal client for Trimble Connect's Property Set service (pset-api) and Organizer (org-api), following what
// Connect web itself does (its webcomponents bundle, 2026-11):
//  - project libraries are listed as links "frn:lib:{libId}" on Organizer node
//    forests/project:{projectId}:data / trees/ProjectContext / nodes/PSetLibs
//  - definitions: GET/POST/PATCH libs/{lib}/defs[/{def}]
//  - values ("psets") on a model object: link frn:entity:{IFC GUID}; PATCH psets/{link}/{lib}/{def} {props}
//  - many at once: POST batch-get {psets:[{link, libId, defId}]}
(function (root) {
  "use strict";
  const REGIONS = {
    europe: "eu-west-1", eu: "eu-west-1", uk: "eu-west-2", northamerica: "us-east-1", us: "us-east-1",
    asia: "ap-southeast-1", australia: "ap-southeast-2",
  };
  const hostFor = (svc, region) => (region === "master" ? `https://${svc}-api.connect.trimble.com/v1/` : `https://${svc}-api.${region}.connect.trimble.com/v1/`);

  class ApiError extends Error {
    constructor(status, message, body) { super(message); this.status = status; this.body = body; }
  }

  class PsetClient {
    /** @param opts {region: "eu-west-1" | project location, getToken: async (refresh) => token} */
    constructor(opts) {
      const r = String(opts.region || "eu-west-1").toLowerCase().replace(/[\s_-]/g, "");
      this.region = /^[a-z]{2}(west|east|southeast)\d$/.test(r) ? opts.region : REGIONS[r] || "eu-west-1";
      this.getToken = opts.getToken;
    }
    async request(svc, path, method = "GET", body) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await this.getToken(attempt > 0);
        const res = await fetch(hostFor(svc, this.region) + path, {
          method,
          headers: Object.assign({ Authorization: "Bearer " + token }, body !== undefined ? { "Content-Type": "application/json" } : {}),
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (res.status === 401 && attempt === 0) continue;   // token expired: ask Connect for a fresh one
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (!res.ok) throw new ApiError(res.status, `${svc}-api ${method} ${path.split("?")[0]}: ${res.status} ${(data && (data.message || data.errorcode || data.code)) || ""}`.trim(), data);
        return data;
      }
    }

    /** Library ids registered for the project (what Connect's "Property Set Libraries" page lists). */
    async projectLibraryIds(projectId) {
      try {
        const node = await this.request("org", `forests/${encodeURIComponent(`project:${projectId}:data`)}/trees/ProjectContext/nodes/PSetLibs`);
        return ((node && node.links) || []).map((l) => {
          const m = /^frn:lib:(.+)$/.exec(l);
          return m ? decodeURIComponent(m[1]) : null;
        }).filter(Boolean);
      } catch (e) {
        if (e.status === 404) return [];
        throw e;
      }
    }
    getLibrary(libId) { return this.request("pset", `libs/${encodeURIComponent(libId)}`); }

    /** Find the project library with this name. Returns {lib, others} (others: names seen, for messages). */
    async findLibrary(projectId, name) {
      const ids = await this.projectLibraryIds(projectId);
      const others = [];
      for (const id of ids) {
        try {
          const lib = await this.getLibrary(id);
          if (lib && String(lib.name || "").trim().toLowerCase() === name.toLowerCase()) return { lib, others };
          if (lib) others.push(lib.name);
        } catch (e) { if (e.status !== 403 && e.status !== 404) throw e; }
      }
      return { lib: null, others };
    }

    /** Make sure the status definition exists in the library and has all fields (creates or extends it). */
    async ensureDefinition(libId, def) {
      let cur = null;
      try { cur = await this.request("pset", `libs/${encodeURIComponent(libId)}/defs/${encodeURIComponent(def.id)}`); }
      catch (e) { if (e.status !== 404) throw e; }
      if (!cur) return { def: await this.request("pset", `libs/${encodeURIComponent(libId)}/defs`, "POST", def), created: true };
      const have = Object.keys((cur.schema && cur.schema.props) || {});
      const missing = Object.keys(def.schema.props).filter((p) => !have.includes(p));
      if (!missing.length) return { def: cur, created: false };
      const props = Object.assign({}, cur.schema.props, def.schema.props);
      const upd = await this.request("pset", `libs/${encodeURIComponent(libId)}/defs/${encodeURIComponent(def.id)}`, "PATCH",
        { name: def.name, description: def.description, schema: { props }, i18n: def.i18n, v: cur.v });
      return { def: upd, created: false, extended: missing };
    }

    /** Read the status of many objects. Returns Map link -> props. */
    async readMany(libId, defId, links) {
      const out = new Map();
      for (let i = 0; i < links.length; i += 100) {
        const chunk = links.slice(i, i + 100);
        const res = await this.request("pset", "batch-get", "POST", { psets: chunk.map((link) => ({ link, libId, defId })) });
        const got = (res && res.responses && res.responses.psets) || [];
        for (const p of got) if (p && p.link && !p.deleted) out.set(p.link, p.props || {});
      }
      return out;
    }

    /** Write (create or update) the status of one object. */
    write(libId, defId, link, props) {
      return this.request("pset", `psets/${encodeURIComponent(link)}/${encodeURIComponent(libId)}/${encodeURIComponent(defId)}`, "PATCH", { props });
    }
  }

  const lib = { PsetClient, ApiError, hostFor };
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.PsetApi = lib;
})(typeof self !== "undefined" ? self : this);
