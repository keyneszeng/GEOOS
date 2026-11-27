import { randomUUID } from "node:crypto";
import { analyze } from "./analysis.mjs";
const day = 86400000,
  iso = (t) => new Date(t).toISOString();
export function openPlanner(
  store,
  knowledge,
  workflows,
  auth,
  { providers = () => [], clock = Date.now, limit = 3 } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw Error("Invalid GEO_AUTO_DAILY_LIMIT");
  const { db } = store;
  db.exec(
    "CREATE TABLE IF NOT EXISTS geo_plans(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),actor_id TEXT NOT NULL REFERENCES geo_users(id),mode TEXT NOT NULL CHECK(mode IN ('report','auto')),prompt_id TEXT REFERENCES prompts(id),provider TEXT,fact_ids TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS geo_one_active_plan ON geo_plans(workspace_id) WHERE enabled=1;",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS geo_daily_reports(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),plan_id TEXT NOT NULL REFERENCES geo_plans(id),day TEXT NOT NULL,report TEXT NOT NULL,state TEXT NOT NULL,workflow_id TEXT UNIQUE REFERENCES geo_workflows(id),note TEXT,created_at TEXT NOT NULL,UNIQUE(workspace_id,day));",
  );
  db.prepare(
    "UPDATE geo_daily_reports SET state='skipped',note='Interrupted before scheduling; not replayed' WHERE state='preparing'",
  ).run();
  const owner = (w, u) => auth.role(w, u) === "owner";
  const get = (w, id) =>
    db.prepare("SELECT * FROM geo_plans WHERE workspace_id=? AND id=?").get(w, id);
  function validateFacts(w, ids) {
    if (!Array.isArray(ids) || ids.length > 10 || ids.some((x) => typeof x !== "string"))
      throw Error("Choose at most ten public fact versions");
    const current = new Set(knowledge.publicFacts(w).map((f) => f.id));
    if (ids.some((id) => !current.has(id))) throw Error("Selected fact versions no longer current");
    return [...new Set(ids)];
  }
  function create(w, u, input) {
    if (!owner(w, u) || input.confirm !== true) throw Error("Owner confirmation required");
    if (!["report", "auto"].includes(input.mode) || ![7, 30].includes(input.days))
      throw Error("Choose report or auto and 7 or 30 days");
    const t = clock();
    let prompt = null,
      provider = null,
      facts = [];
    if (input.mode === "auto") {
      if (!providers().includes(input.provider) || input.provider === "openai-web")
        throw Error("Select configured non-web Agent provider");
      if (
        !db.prepare("SELECT id FROM prompts WHERE workspace_id=? AND id=?").get(w, input.promptId)
      )
        throw Error("Select one workspace question");
      prompt = input.promptId;
      provider = input.provider;
      facts = validateFacts(w, input.factIds ?? []);
    }
    db.prepare("UPDATE geo_plans SET enabled=0 WHERE workspace_id=? AND expires_at<=?").run(
      w,
      iso(t),
    );
    if (db.prepare("SELECT id FROM geo_plans WHERE workspace_id=? AND enabled=1").get(w))
      throw Error("Stop existing plan first");
    if (
      db.prepare("SELECT count(*) AS n FROM geo_plans WHERE enabled=1 AND expires_at>?").get(iso(t))
        .n >= 100
    )
      throw Error("Plan capacity reached");
    const id = randomUUID();
    db.prepare("INSERT INTO geo_plans VALUES(?,?,?,?,?,?,?,1,?,?)").run(
      id,
      w,
      u,
      input.mode,
      prompt,
      provider,
      JSON.stringify(facts),
      iso(t),
      iso(t + input.days * day),
    );
    return get(w, id);
  }
  function stop(w, u, id) {
    if (!owner(w, u)) throw Error("Owner required");
    const p = get(w, id);
    if (!p) throw Error("Plan not found");
    db.prepare("UPDATE geo_plans SET enabled=0 WHERE id=?").run(id);
    return get(w, id);
  }
  function authorized(r) {
    const p = db
      .prepare(
        "SELECT p.* FROM geo_daily_reports d JOIN geo_plans p ON p.id=d.plan_id WHERE d.workflow_id=? AND d.workspace_id=?",
      )
      .get(r.id, r.workspace_id);
    return (
      !p || (p.enabled === 1 && p.expires_at > iso(clock()) && owner(p.workspace_id, p.actor_id))
    );
  }
  function build(w, t) {
    const from = iso(t - 30 * day),
      to = iso(t);
    const rows = db
      .prepare(
        "SELECT id,prompt_id,question,provider,model,status,mentioned,competitor_hits,citations FROM samples WHERE workspace_id=? AND created_at>=? AND created_at<=? ORDER BY created_at DESC",
      )
      .all(w, from, to);
    const groups = analyze(rows),
      valid = rows.filter((r) => r.status === "success").length;
    const reviewed = db
      .prepare(
        "SELECT count(*) AS n FROM geo_sample_reviews r JOIN samples s ON s.id=r.sample_id WHERE r.workspace_id=? AND s.workspace_id=? AND s.status='success' AND s.created_at>=? AND s.created_at<=?",
      )
      .get(w, w, from, to).n;
    const opportunities = groups
      .filter((g) => g.opportunity)
      .sort((a, b) => b.opportunity.delta - a.opportunity.delta || b.valid - a.valid)
      .slice(0, 10)
      .map((g) => ({
        promptId: g.promptId,
        question: g.question,
        provider: g.provider,
        model: g.model,
        valid: g.valid,
        ...g.opportunity,
      }));
    const open = db
      .prepare(
        "SELECT count(*) AS n FROM geo_actions WHERE workspace_id=? AND state IN ('open','draft','rejected')",
      )
      .get(w).n;
    const tasks = [];
    if (!valid) tasks.push("先建立非品牌决策问题的有效监测样本");
    if (valid > reviewed)
      tasks.push("人工复核未审核的有效回答；不要将模型判断直接计入已审核推荐率");
    if (opportunities.length) tasks.push("核查竞品文本提及差距及原始回答证据，再确定内容任务");
    if (open) tasks.push("处理已有优化行动与审批积压");
    if (!knowledge.publicFacts(w).length) tasks.push("补充并审核企业公开事实与原始证据");
    if (rows.some((r) => r.status === "failed")) tasks.push("检查失败请求，确认费用后再手动重试");
    return {
      from,
      to,
      attempts: rows.length,
      valid,
      reviewed,
      openActions: open,
      opportunities,
      tasks,
      interpretation: "描述性策略提示；非因果结论，不代表消费端排名",
    };
  }
  function tick() {
    const t = clock(),
      d = iso(t).slice(0, 10);
    for (const p of db
      .prepare("SELECT * FROM geo_plans WHERE enabled=1 ORDER BY created_at,rowid")
      .all()) {
      if (p.expires_at <= iso(t) || !owner(p.workspace_id, p.actor_id)) {
        db.prepare("UPDATE geo_plans SET enabled=0 WHERE id=?").run(p.id);
        continue;
      }
      if (
        db
          .prepare("SELECT id FROM geo_daily_reports WHERE workspace_id=? AND day=?")
          .get(p.workspace_id, d)
      )
        continue;
      const w = p.workspace_id,
        id = randomUUID(),
        report = build(w, t);
      db.prepare(
        "INSERT INTO geo_daily_reports(id,workspace_id,plan_id,day,report,state,created_at) VALUES(?,?,?,?,?,'preparing',?)",
      ).run(id, w, p.id, d, JSON.stringify(report), iso(t));
      const finish = (state, note) =>
        db.prepare("UPDATE geo_daily_reports SET state=?,note=? WHERE id=?").run(state, note, id);
      if (p.mode === "report") {
        finish("report-only", "本地策略报告，无外部模型请求");
        continue;
      }
      try {
        if (
          db
            .prepare(
              "SELECT count(*) AS n FROM geo_daily_reports WHERE day=? AND workflow_id IS NOT NULL",
            )
            .get(d).n >= limit
        ) {
          finish("skipped", "Global daily automatic workflow limit reached");
          continue;
        }
        if (!providers().includes(p.provider)) throw Error("Agent provider no longer configured");
        const facts = validateFacts(w, JSON.parse(p.fact_ids));
        if (
          db
            .prepare(
              "SELECT id FROM geo_workflows WHERE workspace_id=? AND state IN ('queued','running','paused')",
            )
            .get(w)
        ) {
          finish("skipped", "Existing active workflow; no new request");
          continue;
        }
        // Only samples created since consent, within the last day, never previously assessed or scheduled.
        const s = db
          .prepare(
            "SELECT s.id FROM samples s WHERE s.workspace_id=? AND s.prompt_id=? AND s.status='success' AND s.created_at>=? AND s.created_at<=? AND length(s.answer)<=16000 AND NOT EXISTS(SELECT 1 FROM geo_workflows f WHERE f.sample_id=s.id) AND NOT EXISTS(SELECT 1 FROM geo_agent_runs a WHERE a.workspace_id=s.workspace_id AND a.target_id=s.id AND a.kind='assess') ORDER BY s.created_at DESC,s.rowid DESC LIMIT 1",
          )
          .get(w, p.prompt_id, iso(Math.max(t - day, Date.parse(p.created_at))), iso(t));
        if (!s) {
          finish("skipped", "No eligible new sample at daily report time");
          continue;
        }
        workflows.create(
          w,
          p.actor_id,
          { sampleId: s.id, provider: p.provider, factIds: facts, confirm: true },
          (workflowId) => {
            db.prepare(
              "UPDATE geo_daily_reports SET workflow_id=?,state='queued',note='Authorized workflow queued; human review required' WHERE id=?",
            ).run(workflowId, id);
          },
        );
      } catch (e) {
        finish("skipped", String(e.message).slice(0, 200));
      }
    }
  }
  const list = (w) => ({
    plans: db
      .prepare(
        "SELECT * FROM geo_plans WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 30",
      )
      .all(w),
    reports: db
      .prepare(
        "SELECT d.*,f.state AS workflow_state FROM geo_daily_reports d LEFT JOIN geo_workflows f ON f.id=d.workflow_id WHERE d.workspace_id=? ORDER BY d.day DESC LIMIT 30",
      )
      .all(w)
      .map((r) => ({ ...r, report: JSON.parse(r.report) })),
    limit,
  });
  return { create, stop, tick, list, authorized };
}
