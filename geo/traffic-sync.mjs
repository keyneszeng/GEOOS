import { randomUUID } from "node:crypto";
const now = () => new Date().toISOString();
function count(v) {
  if (v === undefined || v === null) return null;
  if (!/^\d+$/.test(String(v)) || !Number.isSafeInteger(Number(v)) || Number(v) > 1e12)
    throw Error("Invalid metric");
  return Number(v);
}
function videoId(url) {
  const u = new URL(url);
  let id;
  if (u.hostname === "youtu.be") id = u.pathname.slice(1);
  else if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(u.hostname))
    id =
      u.pathname === "/watch"
        ? u.searchParams.get("v")
        : u.pathname.match(/^\/(?:shorts|live)\/([^/]+)$/)?.[1];
  if (!/^[A-Za-z0-9_-]{11}$/.test(id || "")) throw Error("Unsupported YouTube URL");
  return id;
}
function igKey(url) {
  const u = new URL(url);
  if (
    !["instagram.com", "www.instagram.com"].includes(u.hostname) ||
    !/^\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/?$/.test(u.pathname)
  )
    throw Error("Unsupported Instagram URL");
  return u.pathname.replace(/\/$/, "");
}
export async function fetchTraffic(p, config, request = fetch) {
  const options = { redirect: "error", signal: AbortSignal.timeout(15000) };
  let metrics, source;
  if (p.platform === "youtube") {
    if (!config.youtubeKey) throw Error("YouTube not configured");
    const id = videoId(p.public_url),
      u = new URL("https://www.googleapis.com/youtube/v3/videos");
    u.searchParams.set("part", "statistics");
    u.searchParams.set("id", id);
    const r = await request(u, { ...options, headers: { "x-goog-api-key": config.youtubeKey } });
    if (!r.ok) throw Error("Provider request failed");
    const data = await r.json(),
      item = data.items?.find((x) => x.id === id);
    if (!item?.statistics) throw Error("Video unavailable");
    metrics = {
      views: count(item.statistics.viewCount),
      likes: count(item.statistics.likeCount),
      comments: count(item.statistics.commentCount),
    };
    source = "YouTube Data API public cumulative statistics";
  } else if (p.platform === "instagram") {
    const c = config.instagram?.[p.workspace_id];
    if (!c?.token || !/^v\d+\.\d+$/.test(c.version) || !/^\d{5,30}$/.test(p.external_id || ""))
      throw Error("Instagram workspace authorization and media ID required");
    const u = new URL("https://graph.instagram.com/" + c.version + "/" + p.external_id);
    u.searchParams.set("fields", "id,permalink,like_count,comments_count");
    const r = await request(u, { ...options, headers: { Authorization: "Bearer " + c.token } });
    if (!r.ok) throw Error("Provider request failed");
    const item = await r.json();
    if (String(item.id) !== p.external_id || igKey(item.permalink) !== igKey(p.public_url))
      throw Error("Media link mismatch");
    metrics = { likes: count(item.like_count), comments: count(item.comments_count) };
    source = "Instagram authorized media API cumulative counts";
  } else throw Error("Platform not connected");
  if (Object.values(metrics).every((v) => v === null)) throw Error("No available metrics");
  return { metrics, source };
}
export function openTraffic(
  store,
  distribution,
  auth,
  { config = {}, request = fetch, limit = 20 } = {},
) {
  const { db } = store;
  db.exec(
    "CREATE TABLE IF NOT EXISTS geo_traffic_plans(publication_id TEXT PRIMARY KEY REFERENCES geo_publications(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),actor_id TEXT NOT NULL REFERENCES geo_users(id),external_id TEXT,enabled INTEGER NOT NULL,expires_at TEXT NOT NULL,next_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS geo_traffic_runs(id TEXT PRIMARY KEY,publication_id TEXT NOT NULL REFERENCES geo_publications(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),state TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL);",
  );
  db.prepare(
    "UPDATE geo_traffic_runs SET state='interrupted',error='No automatic replay' WHERE state='running'",
  ).run();
  const role = (w, u) => ["owner", "editor"].includes(auth.role(w, u));
  function plan(w, actor, input) {
    if (!role(w, actor)) throw Error("Operator required");
    const p = db
      .prepare(
        "SELECT p.*,c.platform FROM geo_publications p JOIN geo_channels c ON c.id=p.channel_id WHERE p.workspace_id=? AND p.id=? AND p.state='published'",
      )
      .get(w, input.id);
    if (!p) throw Error("Published content required");
    if (input.action === "stop") {
      db.prepare(
        "UPDATE geo_traffic_plans SET enabled=0 WHERE workspace_id=? AND publication_id=?",
      ).run(w, p.id);
      return { id: p.id, enabled: false };
    }
    if (input.action !== "enable" || input.confirm !== true || ![7, 30].includes(input.days))
      throw Error("Confirm authorized 7/30 day synchronization");
    if (p.platform === "youtube") {
      videoId(p.public_url);
      if (!config.youtubeKey) throw Error("YouTube not configured");
    } else if (p.platform === "instagram") {
      igKey(p.public_url);
      if (!config.instagram?.[w]?.token || !/^\d{5,30}$/.test(input.externalId || ""))
        throw Error("Instagram authorization and media ID required");
    } else throw Error("Unsupported platform");
    db.prepare(
      "INSERT INTO geo_traffic_plans VALUES(?,?,?,?,1,?,?) ON CONFLICT(publication_id) DO UPDATE SET actor_id=excluded.actor_id,external_id=excluded.external_id,enabled=1,expires_at=excluded.expires_at,next_at=excluded.next_at",
    ).run(
      p.id,
      w,
      actor,
      p.platform === "instagram" ? input.externalId : null,
      new Date(Date.now() + input.days * 86400000).toISOString(),
      now(),
    );
    return { id: p.id, enabled: true };
  }
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const t = now();
      db.prepare("UPDATE geo_traffic_plans SET enabled=0 WHERE expires_at<=?").run(t);
      if (
        db
          .prepare("SELECT count(*) n FROM geo_traffic_runs WHERE created_at>=?")
          .get(t.slice(0, 10)).n >= limit
      )
        return;
      const p = db
        .prepare(
          "SELECT s.*,p.public_url,c.platform FROM geo_traffic_plans s JOIN geo_publications p ON p.id=s.publication_id AND p.workspace_id=s.workspace_id JOIN geo_channels c ON c.id=p.channel_id WHERE s.enabled=1 AND s.next_at<=? AND p.state='published' AND NOT EXISTS(SELECT 1 FROM geo_traffic_runs r WHERE r.publication_id=s.publication_id AND r.created_at>=?) ORDER BY s.next_at,s.publication_id LIMIT 1",
        )
        .get(t, new Date(Date.now() - 86400000).toISOString());
      if (!p) return;
      if (!role(p.workspace_id, p.actor_id)) {
        db.prepare("UPDATE geo_traffic_plans SET enabled=0 WHERE publication_id=?").run(
          p.publication_id,
        );
        return;
      }
      const id = randomUUID();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE geo_traffic_plans SET next_at=? WHERE publication_id=?").run(
          new Date(Date.now() + 86400000).toISOString(),
          p.publication_id,
        );
        db.prepare("INSERT INTO geo_traffic_runs VALUES(?,?,?,'running',NULL,?)").run(
          id,
          p.publication_id,
          p.workspace_id,
          t,
        );
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      try {
        const r = await fetchTraffic(p, config, request);
        const current = db
          .prepare(
            "SELECT enabled,expires_at,actor_id,external_id FROM geo_traffic_plans WHERE publication_id=?",
          )
          .get(p.publication_id);
        if (
          !current?.enabled ||
          current.expires_at <= now() ||
          current.actor_id !== p.actor_id ||
          current.external_id !== p.external_id ||
          !role(p.workspace_id, p.actor_id)
        )
          throw Error("Authorization revoked");
        distribution.metric(p.workspace_id, p.actor_id, {
          id: p.publication_id,
          observedAt: now(),
          ...r,
        });
        db.prepare("UPDATE geo_traffic_runs SET state='success' WHERE id=?").run(id);
      } catch {
        db.prepare(
          "UPDATE geo_traffic_runs SET state='failed',error='Provider synchronization failed or authorization revoked' WHERE id=?",
        ).run(id);
      }
    } finally {
      busy = false;
    }
  }
  return {
    plan,
    tick,
    list: (w) => ({
      plans: db.prepare("SELECT * FROM geo_traffic_plans WHERE workspace_id=? LIMIT 100").all(w),
      runs: db
        .prepare(
          "SELECT * FROM geo_traffic_runs WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100",
        )
        .all(w),
      configured: { youtube: !!config.youtubeKey, instagram: !!config.instagram?.[w]?.token },
    }),
  };
}
