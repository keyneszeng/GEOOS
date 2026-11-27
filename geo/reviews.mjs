import { wilson } from "./analysis.mjs";
const now = () => new Date().toISOString();
const categories = ["recommended", "discouraged", "neutral", "mixed", "not-mentioned", "uncertain"];
function clean(v) {
  if (typeof v !== "string" || !v.trim() || v.length > 2000) throw Error("Review note required");
  return v.trim();
}
export function openReviews(store, knowledge) {
  const { db } = store;
  db.exec(
    "CREATE TABLE IF NOT EXISTS geo_sample_reviews(sample_id TEXT PRIMARY KEY REFERENCES samples(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),run_id TEXT NOT NULL REFERENCES geo_agent_runs(id),category TEXT NOT NULL,conflicts TEXT NOT NULL,note TEXT NOT NULL,reviewed_at TEXT NOT NULL);",
  );
  function review(w, input) {
    const r = db
      .prepare(
        "SELECT * FROM geo_agent_runs WHERE workspace_id=? AND id=? AND kind='assess' AND state='success'",
      )
      .get(w, input.runId);
    if (!r) throw Error("Successful assessment required");
    const s = db
      .prepare("SELECT id FROM samples WHERE workspace_id=? AND id=? AND status='success'")
      .get(w, r.target_id);
    if (!s) throw Error("Sample not found");
    if (!categories.includes(input.category)) throw Error("Invalid review category");
    const result = JSON.parse(r.result),
      indices = input.conflictIndices ?? [];
    if (
      !Array.isArray(indices) ||
      indices.length > 8 ||
      indices.some((i) => !Number.isInteger(i) || !result.conflicts[i])
    )
      throw Error("Invalid conflict selection");
    const approved = new Set(knowledge.publicFacts(w).map((f) => f.id));
    const conflicts = [...new Set(indices)].map((i) => result.conflicts[i]);
    if (conflicts.some((c) => !approved.has(c.factId)))
      throw Error("Conflicting fact version no longer current; reassess");
    const note = clean(input.note);
    db.prepare(
      "INSERT INTO geo_sample_reviews VALUES(?,?,?,?,?,?,?) ON CONFLICT(sample_id) DO UPDATE SET run_id=excluded.run_id,category=excluded.category,conflicts=excluded.conflicts,note=excluded.note,reviewed_at=excluded.reviewed_at",
    ).run(s.id, w, r.id, input.category, JSON.stringify(conflicts), note, now());
    return db
      .prepare("SELECT * FROM geo_sample_reviews WHERE sample_id=? AND workspace_id=?")
      .get(s.id, w);
  }
  const recent = (w) =>
    db
      .prepare(
        "SELECT * FROM geo_sample_reviews WHERE workspace_id=? ORDER BY reviewed_at DESC LIMIT 100",
      )
      .all(w);
  function stats(w) {
    const current = new Set(knowledge.publicFacts(w).map((f) => f.id));
    const rows = db
      .prepare(
        "SELECT s.provider,s.model,r.category,r.conflicts FROM samples s LEFT JOIN geo_sample_reviews r ON r.sample_id=s.id AND r.workspace_id=s.workspace_id WHERE s.workspace_id=? AND s.status='success' AND s.created_at>=?",
      )
      .all(w, new Date(Date.now() - 30 * 86400000).toISOString());
    const groups = new Map();
    for (const x of rows) {
      const key = JSON.stringify([x.provider, x.model]),
        g = groups.get(key) || {
          provider: x.provider,
          model: x.model,
          valid: 0,
          reviewed: 0,
          recommended: 0,
          uncertain: 0,
          confirmedConflictSamples: 0,
          staleConflictSamples: 0,
        };
      g.valid++;
      if (x.category) {
        g.reviewed++;
        g.recommended += Number(x.category === "recommended");
        g.uncertain += Number(x.category === "uncertain");
        const conflicts = JSON.parse(x.conflicts || "[]");
        g.confirmedConflictSamples += Number(conflicts.some((c) => current.has(c.factId)));
        g.staleConflictSamples += Number(conflicts.some((c) => !current.has(c.factId)));
      }
      groups.set(key, g);
    }
    return [...groups.values()].map((g) => ({
      ...g,
      coverage: g.reviewed / g.valid,
      reviewedRecommendationRate: g.reviewed ? g.recommended / g.reviewed : null,
    }));
  }
  function compare(w, id, days = 7, at = Date.now()) {
    if (![7, 14, 30].includes(days)) throw Error("Window must be 7, 14 or 30 days");
    const a = db.prepare("SELECT * FROM geo_actions WHERE workspace_id=? AND id=?").get(w, id);
    if (!a || !["implemented", "verified"].includes(a.state))
      throw Error("Implemented action required");
    const event = db
      .prepare(
        "SELECT created_at FROM geo_action_events WHERE action_id=? AND state='implemented' ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get(id);
    if (!event) throw Error("Implementation record missing");
    const t = Date.parse(event.created_at),
      span = days * 86400000,
      iso = (x) => new Date(x).toISOString();
    function window(from, to) {
      const rows = db
        .prepare(
          "SELECT mentioned,citations FROM samples WHERE workspace_id=? AND prompt_id=? AND provider=? AND model=? AND status='success' AND created_at>=? AND created_at<?",
        )
        .all(w, a.prompt_id, a.provider, a.model, iso(from), iso(to));
      const n = rows.length,
        m = rows.filter((x) => x.mentioned === 1).length;
      return {
        from: iso(from),
        to: iso(to),
        valid: n,
        mentioned: m,
        mentionRate: n ? m / n : null,
        interval95: wilson(m, n),
      };
    }
    const before = window(t - span, t),
      after = window(t, Math.max(t, Math.min(at, t + span)));
    return {
      actionId: id,
      implementedAt: event.created_at,
      days,
      before,
      after,
      complete: at >= t + span,
      delta: before.valid && after.valid ? after.mentionRate - before.mentionRate : null,
      interpretation:
        "Descriptive comparison; no causal attribution. Model configuration, sample selection and time may confound results.",
    };
  }
  return { review, recent, stats, compare };
}
