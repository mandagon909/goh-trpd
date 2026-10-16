/* «Царь Горы» — подключение сайта к Supabase.
   Даёт сайту тот же набор функций (db, user, assets), что был в версии на claude.ai. */
(function () {
  const CFG = window.GOH_CONFIG || {};
  const ready = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && !/ВСТАВЬ|PASTE/i.test(CFG.SUPABASE_URL + CFG.SUPABASE_ANON_KEY));
  window.GOH_READY = ready;
  if (!ready || !window.supabase) { window.claude = { use: async () => null }; return; }

  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  window.GOH_SB = sb;
  window.BLOB_BASE = CFG.SUPABASE_URL.replace(/\/$/, "") + "/storage/v1/object/public/art/";

  /* ---------- сессия ---------- */
  const init = (async () => {
    const { data } = await sb.auth.getSession();
    const session = data.session || null;
    const uid = session ? session.user.id : null;
    let isAdmin = false;
    if (uid) { try { const r = await sb.rpc("is_admin"); isAdmin = !!r.data; } catch (e) {} }
    return { session, uid, isAdmin, email: session ? session.user.email : null };
  })();
  window.GOH_SESSION = init;

  sb.auth.onAuthStateChange((ev) => {
    if (ev === "PASSWORD_RECOVERY") { window.GOH_RECOVERY = true; if (window.renderAuth) window.renderAuth("recover"); }
    if (ev === "SIGNED_OUT") location.reload();
  });

  /* ---------- база документов ---------- */
  const colOf = (p) => p.split("/").slice(0, -1).join("/");
  const idOf = (p) => p.split("/").pop();
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const errOf = (e) => {
    const code = e && (e.code || "");
    if (code === "42501" || /row-level security|only reviewers/i.test((e && e.message) || "")) return { code: "invalid_argument", message: "Нет прав" };
    if (code === "23514") return { code: "quota_exceeded", message: "Слишком большой документ" };
    return { code: "unavailable", message: (e && e.message) || "Ошибка сети" };
  };
  const meta = { fromCache: false, hasPendingWrites: false };
  const mkSnap = (path, data) => ({ id: idOf(path), exists: data !== undefined, data: () => clone(data), metadata: meta });

  async function fetchDoc(path) {
    const { data, error } = await sb.from("docs").select("data").eq("path", path).maybeSingle();
    if (error) throw errOf(error);
    return data ? data.data : undefined;
  }
  async function fetchCol(col) {
    const { data, error } = await sb.from("docs").select("path,data").eq("col", col).limit(1000);
    if (error) throw errOf(error);
    return data || [];
  }
  async function writeDoc(path, body) {
    const { error } = await sb.from("docs").upsert({ path, col: colOf(path), doc_id: idOf(path), data: body }, { onConflict: "path" });
    if (error) throw errOf(error);
    bump(path);
  }
  function deepMerge(a, b) {
    const o = Object.assign({}, a || {});
    for (const k of Object.keys(b || {})) {
      const v = b[k];
      o[k] = v && typeof v === "object" && !Array.isArray(v) && o[k] && typeof o[k] === "object" && !Array.isArray(o[k]) ? deepMerge(o[k], v) : v;
    }
    return o;
  }

  /* подписки: живые обновления через Realtime + страховочный опрос */
  const listeners = new Set();
  function bump(path) {
    const col = colOf(path);
    listeners.forEach((l) => { if (l.path === path || l.col === col) schedule(l); });
  }
  function schedule(l) { clearTimeout(l.t); l.t = setTimeout(() => run(l), 120); }
  async function run(l) {
    if (l.dead) return;
    try { await l.fetch(); } catch (e) { if (l.err && !l.errSent) { l.errSent = true; l.err(e); } }
  }
  try {
    sb.channel("docs-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, (p) => {
        const path = (p.new && p.new.path) || (p.old && p.old.path);
        if (path) bump(path);
      })
      .subscribe();
  } catch (e) {}
  setInterval(() => listeners.forEach(run), 25000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) listeners.forEach(run); });

  function docRef(path) {
    return {
      id: idOf(path), path,
      get: async () => mkSnap(path, await fetchDoc(path)),
      set: async (d) => writeDoc(path, clone(d)),
      update: async (d) => {
        const cur = await fetchDoc(path);
        if (cur === undefined) throw { code: "invalid_argument", message: "Документ не найден" };
        await writeDoc(path, deepMerge(cur, clone(d)));
      },
      delete: async () => {
        const { error } = await sb.from("docs").delete().eq("path", path);
        if (error) throw errOf(error);
        bump(path);
      },
      onSnapshot: (next, err) => {
        const l = { path, err, fetch: async () => next(mkSnap(path, await fetchDoc(path))) };
        listeners.add(l); run(l);
        return () => { l.dead = true; listeners.delete(l); };
      },
      collection: (sub) => colRef(path + "/" + sub),
    };
  }
  function query(col, order, lim, filters) {
    const exec = async () => {
      let rows = (await fetchCol(col)).map((r) => ({ path: r.path, data: r.data }));
      (filters || []).forEach(([f, op, v]) => {
        rows = rows.filter((r) => {
          const x = r.data[f];
          return op === "==" ? x === v : op === "!=" ? x !== v : op === "<" ? x < v : op === "<=" ? x <= v : op === ">" ? x > v : op === ">=" ? x >= v
            : op === "in" ? v.includes(x) : op === "not-in" ? !v.includes(x) : op === "array-contains" ? Array.isArray(x) && x.includes(v) : true;
        });
      });
      if (order) rows.sort((a, b) => { const x = a.data[order[0]], y = b.data[order[0]]; return (x > y ? 1 : x < y ? -1 : 0) * (order[1] === "desc" ? -1 : 1); });
      else rows.sort((a, b) => (idOf(a.path) > idOf(b.path) ? 1 : -1));
      if (lim) rows = rows.slice(0, lim);
      const docs = rows.map((r) => mkSnap(r.path, r.data));
      return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta };
    };
    return {
      where: (f, op, v) => query(col, order, lim, (filters || []).concat([[f, op, v]])),
      orderBy: (f, dir) => query(col, [f, dir || "asc"], lim, filters),
      limit: (n) => query(col, order, n, filters),
      get: exec,
      onSnapshot: (next, err) => {
        const l = { col, err, fetch: async () => next(await exec()) };
        listeners.add(l); run(l);
        return () => { l.dead = true; listeners.delete(l); };
      },
    };
  }
  function colRef(col) {
    return Object.assign(query(col), {
      path: col,
      doc: (id) => docRef(col + "/" + (id || rid(20))),
      add: async (d) => { const r = docRef(col + "/" + Date.now().toString(36) + rid(6)); await r.set(d); return r; },
    });
  }
  function rid(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (b) => (b % 36).toString(36)).join(""); }
  const db = { doc: docRef, collection: colRef };

  /* ---------- пользователь ---------- */
  const user = {
    isOwner: async () => (await init).isAdmin,
    canEdit: async () => (await init).isAdmin,
    can: async () => !!(await init).uid,
    id: async () => (await init).uid,
    me: async () => { const s = await init; return { id: s.uid, name: "", avatarUrl: "", color: "#E2001A", email: s.email, isOwner: s.isAdmin, canEdit: s.isAdmin }; },
    name: async () => "",
    profiles: async (ids) => {
      ids = Array.isArray(ids) ? ids : [ids];
      const o = {};
      ids.forEach((id) => (o[id] = { id, name: "", avatarUrl: "", color: "#888", email: null, isMe: false, guest: false }));
      try {
        const { data } = await sb.from("docs").select("doc_id,data").eq("col", "players").in("doc_id", ids.slice(0, 200));
        (data || []).forEach((r) => { if (o[r.doc_id]) o[r.doc_id].name = (r.data && r.data.discord) || ""; });
      } catch (e) {}
      return o;
    },
    search: async () => [],
  };

  /* ---------- арты (хранилище) ---------- */
  const hex = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join(""); };
  const assets = {
    upload: async (blob, opts) => {
      const id = hex(16), type = (opts && opts.type) || blob.type;
      const { error } = await sb.storage.from("art").upload(id, blob, { contentType: type, upsert: false, cacheControl: "31536000" });
      if (error) {
        const m = (error.message || "") + " " + (error.statusCode || "");
        throw { code: /size|413|large/i.test(m) ? "too_large" : /mime|type|415/i.test(m) ? "unsupported_type" : /quota/i.test(m) ? "quota_or_state" : "upstream_error", message: error.message };
      }
      return { id, url: window.BLOB_BASE + id, sizeBytes: blob.size, contentType: type };
    },
    delete: async (id) => { const { error } = await sb.storage.from("art").remove([String(id).replace(/^.*\//, "")]); if (error) throw { code: "upstream_error" }; return { deleted: true }; },
    list: async () => ({ assets: [], usage: {} }),
  };

  window.claude = {
    use: async (name) => {
      const s = await init;
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "assets") return s.uid ? assets : null;
      return null;
    },
  };
})();
