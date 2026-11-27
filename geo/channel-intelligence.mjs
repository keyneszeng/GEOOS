const day = 86400000;
const iso = (t) => new Date(t).toISOString();
function parsed(value) {
  if (typeof value !== "string" || value.length > 2000) throw Error("Invalid URL");
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password) throw Error("Public HTTPS URL required");
  return u;
}
export function citationKey(value) {
  try {
    const u = parsed(value);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    return u.href;
  } catch {
    return null;
  }
}
export function taggedLink(destination, publication) {
  const u = parsed(destination);
  if (u.hash) throw Error("Destination fragment not supported");
  for (const k of [...u.searchParams.keys()])
    if (/^utm_/i.test(k)) throw Error("Remove existing UTM parameters before generating");
  // Opaque IDs rather than customer, account or draft text in the URL.
  u.searchParams.set("utm_source", publication.platform);
  u.searchParams.set("utm_medium", "organic_content");
  u.searchParams.set("utm_campaign", "geo_" + publication.action_id);
  u.searchParams.set("utm_content", publication.id);
  if (u.href.length > 2400) throw Error("Tracking URL too long");
  return u.href;
}
function windowFor(month) {
  if (
    typeof month !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
    month < "2000-01" ||
    month > "2100-12"
  )
    throw Error("Month must be YYYY-MM (2000–2100)");
  const from = Date.parse(month + "-01T00:00:00Z"),
    d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return [iso(from), iso(d.getTime())];
}
function arr(v) {
  try {
    const a = JSON.parse(v || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
export function openChannelIntelligence(store, { clock = Date.now } = {}) {
  const { db } = store;
  db.exec(
    "CREATE TABLE IF NOT EXISTS geo_tracking_links(publication_id TEXT PRIMARY KEY REFERENCES geo_publications(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),actor_id TEXT NOT NULL REFERENCES geo_users(id),destination TEXT NOT NULL,tracking_url TEXT NOT NULL,created_at TEXT NOT NULL);",
  );
  const get = (w, id) =>
    db
      .prepare(
        "SELECT p.*,c.platform,c.account FROM geo_publications p JOIN geo_channels c ON c.id=p.channel_id AND c.workspace_id=p.workspace_id WHERE p.workspace_id=? AND p.id=?",
      )
      .get(w, id);
  function createLink(w, actor, input) {
    const p = get(w, input.id);
    if (!p || !["draft", "approved", "rejected", "published"].includes(p.state))
      throw Error("Active publication required");
    if (input.confirm !== true)
      throw Error(
        "Confirm destination is an authorized public landing page with no sensitive query parameters",
      );
    const destination = parsed(input.destination).href,
      tracking = taggedLink(destination, p);
    const existing = db
      .prepare("SELECT * FROM geo_tracking_links WHERE publication_id=? AND workspace_id=?")
      .get(p.id, w);
    if (existing) {
      if (existing.destination !== destination)
        throw Error("Tracking link already recorded; destination cannot be silently replaced");
      return existing;
    }
    db.prepare("INSERT INTO geo_tracking_links VALUES(?,?,?,?,?,?)").run(
      p.id,
      w,
      actor,
      destination,
      tracking,
      iso(clock()),
    );
    return db.prepare("SELECT * FROM geo_tracking_links WHERE publication_id=?").get(p.id);
  }
  const links = (w) =>
    db
      .prepare(
        "SELECT * FROM geo_tracking_links WHERE workspace_id=? ORDER BY created_at DESC LIMIT 200",
      )
      .all(w);
  function calendar(w, month) {
    const [from, to] = windowFor(month),
      rows = db
        .prepare(
          "SELECT p.id,p.title,p.state,p.scheduled_at,p.published_at,c.platform,c.account FROM geo_publications p JOIN geo_channels c ON c.id=p.channel_id AND c.workspace_id=p.workspace_id WHERE p.workspace_id=? AND ((p.scheduled_at>=? AND p.scheduled_at<?) OR (p.published_at>=? AND p.published_at<?)) ORDER BY p.scheduled_at,p.id LIMIT 1001",
        )
        .all(w, from, to, from, to);
    const events = [];
    for (const p of rows.slice(0, 1000)) {
      for (const [kind, at] of [
        ["scheduled", p.scheduled_at],
        ["published", p.published_at],
      ])
        if (at && at >= from && at < to)
          events.push({
            id: p.id,
            title: p.title,
            state: p.state,
            platform: p.platform,
            account: p.account,
            kind,
            at,
            day: at.slice(0, 10),
          });
    }
    events.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    return { month, timezone: "UTC", events, truncated: rows.length > 1000 };
  }
  function citations(w, id, days = 30) {
    if (![7, 14, 30].includes(days)) throw Error("Window must be 7, 14 or 30 days");
    const p = get(w, id);
    if (!p || p.state !== "published") throw Error("Published content required");
    const key = citationKey(p.public_url);
    if (!key) throw Error("Publication URL unavailable");
    const to = iso(clock()),
      from = iso(Math.max(Date.parse(p.published_at), clock() - days * day));
    // Count all successful samples in this workspace, not only the originating question.
    const rows = db
      .prepare(
        "SELECT id,prompt_id,question,provider,model,created_at,citations,sources FROM samples WHERE workspace_id=? AND status='success' AND created_at>=? AND created_at<=? ORDER BY created_at DESC,rowid DESC",
      )
      .all(w, from, to);
    const groups = new Map(),
      evidence = [];
    for (const r of rows) {
      const k = JSON.stringify([r.provider, r.model]),
        g = groups.get(k) || {
          provider: r.provider,
          model: r.model,
          valid: 0,
          cited: 0,
          retrieved: 0,
        };
      g.valid++;
      const c = arr(r.citations).filter((u) => citationKey(u) === key),
        s = arr(r.sources).filter((u) => citationKey(u) === key);
      g.cited += Number(c.length > 0);
      g.retrieved += Number(s.length > 0);
      groups.set(k, g);
      if ((c.length || s.length) && evidence.length < 100)
        evidence.push({
          id: r.id,
          question: r.question,
          prompt_id: r.prompt_id,
          provider: r.provider,
          model: r.model,
          created_at: r.created_at,
          citations: c,
          sources: s,
        });
    }
    return {
      publicationId: id,
      url: p.public_url,
      from,
      to,
      days,
      valid: rows.length,
      groups: [...groups.values()].map((g) => ({ ...g, citationRate: g.cited / g.valid })),
      evidence,
      interpretation:
        "Exact HTTPS URL match after removing UTM and fragment; retrieval is not citation, and matching does not establish causation. No URL fetching or redirect resolution.",
    };
  }
  return { createLink, links, calendar, citations };
}
