import { randomUUID } from "node:crypto";
import { actionVersion } from "./channel-copy.mjs";
const platforms = [
  "website",
  "wechat",
  "channels",
  "xiaohongshu",
  "douyin",
  "bilibili",
  "youtube",
  "x",
  "instagram",
  "threads",
  "other",
];
const day = 86400000;
const iso = (t) => new Date(t).toISOString();
function clean(v, max) {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw Error("Invalid text");
  return v.trim();
}
function date(v) {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v) ||
    !Number.isFinite(Date.parse(v))
  )
    throw Error("Timestamp with explicit timezone required");
  return iso(Date.parse(v));
}
function url(v) {
  if (typeof v !== "string" || v.length > 2000) throw Error("Invalid public URL");
  const u = new URL(v);
  if (u.protocol !== "https:" || u.username || u.password || u.hash)
    throw Error("HTTPS URL without credentials or fragment required");
  return u.href;
}
const fields = [
  "views",
  "likes",
  "comments",
  "shares",
  "favorites",
  "visits",
  "registrations",
  "orders",
  "revenueMinor",
  "refundMinor",
  "costMinor",
];
function numeric(v) {
  if (v === null || v === undefined || v === "") return null;
  if (!Number.isSafeInteger(v) || v < 0 || v > 1e12)
    throw Error("Metrics must be nonnegative integers, or null");
  return v;
}
export function openDistribution(store, knowledge, { clock = Date.now } = {}) {
  const { db } = store,
    now = () => iso(clock());
  db.exec(
    "CREATE TABLE IF NOT EXISTS geo_channels(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),platform TEXT NOT NULL,account TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(workspace_id,platform,account));",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS geo_publications(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),action_id TEXT NOT NULL REFERENCES geo_actions(id),channel_id TEXT NOT NULL REFERENCES geo_channels(id),title TEXT NOT NULL,body TEXT NOT NULL,approved_outline TEXT NOT NULL,fact_ids TEXT NOT NULL,scheduled_at TEXT NOT NULL,state TEXT NOT NULL,public_url TEXT,published_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(workspace_id,action_id,channel_id),UNIQUE(workspace_id,channel_id,public_url));",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS geo_publication_events(id TEXT PRIMARY KEY,publication_id TEXT NOT NULL REFERENCES geo_publications(id),actor_id TEXT NOT NULL REFERENCES geo_users(id),state TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL);",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS geo_publication_metrics(id TEXT PRIMARY KEY,publication_id TEXT NOT NULL REFERENCES geo_publications(id),actor_id TEXT NOT NULL REFERENCES geo_users(id),observed_at TEXT NOT NULL,age_day INTEGER NOT NULL,source TEXT NOT NULL,currency TEXT,metrics TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(publication_id,observed_at));",
  );
  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      db.exec("COMMIT");
      return v;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  const get = (w, id) =>
    db.prepare("SELECT * FROM geo_publications WHERE workspace_id=? AND id=?").get(w, id);
  const action = (w, id) =>
    db.prepare("SELECT * FROM geo_actions WHERE workspace_id=? AND id=?").get(w, id);
  const event = (id, actor, state, note) =>
    db
      .prepare("INSERT INTO geo_publication_events VALUES(?,?,?,?,?,?)")
      .run(randomUUID(), id, actor, state, note, now());
  function channel(w, input) {
    if (!platforms.includes(input.platform)) throw Error("Unsupported channel");
    const account = clean(input.account, 120);
    const id = randomUUID();
    db.prepare("INSERT INTO geo_channels VALUES(?,?,?,?,?)").run(
      id,
      w,
      input.platform,
      account,
      now(),
    );
    return db.prepare("SELECT * FROM geo_channels WHERE id=?").get(id);
  }
  function currentFacts(w, ids) {
    const active = new Set(knowledge.publicFacts(w).map((f) => f.id));
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => !active.has(id)))
      throw Error("Source facts no longer approved and public");
  }
  function approved(w, id) {
    const a = action(w, id);
    if (!a || !["approved", "implemented", "verified"].includes(a.state) || !a.draft)
      throw Error("Approved GEO action required");
    currentFacts(w, JSON.parse(a.fact_ids || "[]"));
    return a;
  }
  function create(
    w,
    actor,
    input,
    onCreated = () => {},
    note = "Channel copy created; not approved for publication",
  ) {
    return tx(() => {
      const a = approved(w, input.actionId);
      if (input.expectedVersion !== undefined && input.expectedVersion !== actionVersion(a))
        throw Error("Approved action changed; regenerate channel candidate");
      if (
        !db
          .prepare("SELECT id FROM geo_channels WHERE workspace_id=? AND id=?")
          .get(w, input.channelId)
      )
        throw Error("Channel not found");
      const id = randomUUID(),
        t = now();
      db.prepare(
        "INSERT INTO geo_publications(id,workspace_id,action_id,channel_id,title,body,approved_outline,fact_ids,scheduled_at,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'draft',?,?)",
      ).run(
        id,
        w,
        a.id,
        input.channelId,
        clean(input.title, 200),
        clean(input.body, 6000),
        a.draft,
        a.fact_ids,
        date(input.scheduledAt),
        t,
        t,
      );
      event(id, actor, "draft", note);
      onCreated(id);
      return get(w, id);
    });
  }
  function recheck(w, p) {
    const a = approved(w, p.action_id);
    if (a.draft !== p.approved_outline || a.fact_ids !== p.fact_ids)
      throw Error("Source action changed; cannot approve or publish this version");
    currentFacts(w, JSON.parse(p.fact_ids));
  }
  function change(w, actor, input) {
    return tx(() => {
      const p = get(w, input.id);
      if (!p) throw Error("Publication not found");
      const note = clean(input.note, 1000);
      let state = input.action;
      if (state === "revise") {
        if (!["draft", "rejected"].includes(p.state))
          throw Error("Only draft/rejected content can be revised");
        const a = approved(w, p.action_id);
        db.prepare(
          "UPDATE geo_publications SET title=?,body=?,approved_outline=?,fact_ids=?,scheduled_at=?,state='draft',updated_at=? WHERE id=?",
        ).run(
          clean(input.title, 200),
          clean(input.body, 6000),
          a.draft,
          a.fact_ids,
          date(input.scheduledAt),
          now(),
          p.id,
        );
        state = "draft";
      } else if (state === "approve" || state === "reject") {
        if (p.state !== "draft") throw Error("Draft required");
        if (state === "approve") recheck(w, p);
        state = state === "approve" ? "approved" : "rejected";
        db.prepare("UPDATE geo_publications SET state=?,updated_at=? WHERE id=?").run(
          state,
          now(),
          p.id,
        );
      } else if (state === "publish") {
        if (p.state !== "approved" || input.confirm !== true)
          throw Error("Approved copy and explicit actual publication confirmation required");
        recheck(w, p);
        const at = date(input.publishedAt);
        if (Date.parse(at) > clock()) throw Error("Publication cannot be in the future");
        state = "published";
        db.prepare(
          "UPDATE geo_publications SET state='published',public_url=?,published_at=?,updated_at=? WHERE id=?",
        ).run(url(input.url), at, now(), p.id);
      } else if (state === "cancel") {
        if (!["draft", "rejected", "approved"].includes(p.state))
          throw Error("Cannot cancel published content");
        state = "cancelled";
        db.prepare("UPDATE geo_publications SET state=?,updated_at=? WHERE id=?").run(
          state,
          now(),
          p.id,
        );
      } else throw Error("Unsupported publication operation");
      event(p.id, actor, state, note);
      return get(w, p.id);
    });
  }
  function metric(w, actor, input) {
    const p = get(w, input.id);
    if (p?.state !== "published") throw Error("Published content required");
    const at = date(input.observedAt),
      age = Math.floor((Date.parse(at) - Date.parse(p.published_at)) / day);
    if (age < 0 || Date.parse(at) > clock())
      throw Error("Observation must be between publication and now");
    const values = Object.fromEntries(fields.map((k) => [k, numeric(input.metrics?.[k])]));
    if (fields.every((k) => values[k] === null))
      throw Error("Provide at least one measured metric");
    const money = ["revenueMinor", "refundMinor", "costMinor"].some((k) => values[k] !== null);
    const currency = money ? clean(input.currency, 3) : null;
    if (money && !/^[A-Z]{3}$/.test(currency)) throw Error("Three-letter currency required");
    const id = randomUUID();
    db.prepare("INSERT INTO geo_publication_metrics VALUES(?,?,?,?,?,?,?,?,?)").run(
      id,
      p.id,
      actor,
      at,
      age,
      clean(input.source, 300),
      currency,
      JSON.stringify(values),
      now(),
    );
    return { id, age_day: age };
  }
  function history(w, id) {
    if (!get(w, id)) throw Error("Publication not found");
    return {
      events: db
        .prepare(
          "SELECT e.*,u.username FROM geo_publication_events e JOIN geo_users u ON u.id=e.actor_id WHERE e.publication_id=? ORDER BY e.created_at,e.rowid",
        )
        .all(id),
      metrics: db
        .prepare(
          "SELECT * FROM geo_publication_metrics WHERE publication_id=? ORDER BY observed_at DESC LIMIT 200",
        )
        .all(id)
        .map((x) => ({ ...x, metrics: JSON.parse(x.metrics) })),
    };
  }
  function review(w, age) {
    if (![1, 3, 7].includes(age)) throw Error("Age must be 1, 3 or 7 elapsed days");
    return db
      .prepare(
        "SELECT p.id,p.title,p.action_id,p.channel_id,p.published_at,c.platform,c.account,m.observed_at,m.currency,m.metrics,m.source FROM geo_publications p JOIN geo_channels c ON c.id=p.channel_id LEFT JOIN geo_publication_metrics m ON m.id=(SELECT id FROM geo_publication_metrics WHERE publication_id=p.id AND age_day=? ORDER BY observed_at DESC LIMIT 1) WHERE p.workspace_id=? AND p.state='published' ORDER BY p.published_at DESC LIMIT 100",
      )
      .all(age, w)
      .map((r) => {
        const m = r.metrics ? JSON.parse(r.metrics) : null;
        const ratio = (a, b) => (a !== null && b !== null && b > 0 ? a / b : null);
        return {
          ...r,
          metrics: m,
          age_day: age,
          engagementRate:
            m && ["likes", "comments", "shares", "favorites"].every((k) => m[k] !== null)
              ? ratio(m.likes + m.comments + m.shares + m.favorites, m.views)
              : null,
          registrationPerVisit: m ? ratio(m.registrations, m.visits) : null,
          netRevenueMinor:
            m && m.revenueMinor !== null && m.refundMinor !== null
              ? m.revenueMinor - m.refundMinor
              : null,
        };
      });
  }
  function list(w) {
    return {
      platforms,
      channels: db
        .prepare(
          "SELECT * FROM geo_channels WHERE workspace_id=? ORDER BY platform,account LIMIT 200",
        )
        .all(w),
      publications: db
        .prepare(
          "SELECT p.*,c.platform,c.account FROM geo_publications p JOIN geo_channels c ON c.id=p.channel_id WHERE p.workspace_id=? ORDER BY p.scheduled_at DESC LIMIT 200",
        )
        .all(w),
    };
  }
  return { channel, create, change, metric, history, review, list };
}
