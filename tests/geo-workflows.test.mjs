import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../geo/store.mjs";
import { openKnowledge } from "../geo/knowledge.mjs";
import { openActions } from "../geo/actions.mjs";
import { openAgent } from "../geo/agent.mjs";
import { openAuth } from "../geo/auth.mjs";
import { openWorkflows } from "../geo/workflows.mjs";
function fixture() {
  const s = openStore(":memory:"),
    auth = openAuth(s, { bootstrapUser: "admin", bootstrapPassword: "test-password-12345" });
  const token = auth.login({ username: "admin", password: "test-password-12345" }),
    u = auth.authenticate({ headers: { cookie: "geo_session=" + token } }),
    w = auth.createWorkspace(u.id, { name: "A", brand: "Acme", competitors: ["Beta"] }),
    p = s.addPrompt(w.id, { question: "Which tool?" }),
    k = openKnowledge(s),
    a = openActions(s, k);
  let id;
  for (let i = 0; i < 10; i++) {
    const j = s.reserve(w.id, p.id, "deepseek", 100);
    s.finish(j.id, w, {
      answer: "Beta",
      model: "test",
      citations: [],
      sources: [],
      usage: null,
      raw: {},
    });
    id = j.id;
  }
  const e = k.addEvidence(w.id, {
    title: "Spec",
    url: "https://example.com/",
    excerpt: "Acme CSV",
    visibility: "public",
  });
  const f = k.propose(w.id, {
    subject: "Acme",
    predicate: "Export",
    value: "CSV",
    evidenceId: e.id,
  });
  k.review(w.id, { id: f.id, decision: "approved", note: "checked" });
  let calls = 0;
  const ag = openAgent(s, k, a, {
    providers: () => ["deepseek"],
    request: async () => ({
      model: "judge",
      answer: JSON.stringify(
        ++calls === 1
          ? { category: "not-mentioned", quote: "", reason: "No brand", conflicts: [] }
          : { sections: [{ heading: "Export", text: "Acme supports CSV.", factIds: [f.id] }] },
      ),
    }),
  });
  const wf = openWorkflows(s, k, a, ag, auth, { providers: () => ["deepseek"] });
  return { s, auth, u, w, k, a, ag, wf, f, id, calls: () => calls };
}
const create = (x, extra = {}) =>
  x.wf.create(x.w.id, x.u.id, {
    sampleId: x.id,
    provider: "deepseek",
    factIds: [x.f.id],
    confirm: true,
    ...extra,
  });
test("bounded workflow runs assessment, scoped opportunity and candidate, never adopts or approves", async () => {
  const x = fixture();
  try {
    const r = create(x);
    assert.throws(() => create(x));
    assert.equal((await x.wf.tick()).stage, "discover");
    assert.equal((await x.wf.tick()).stage, "compose");
    const done = await x.wf.tick();
    assert.equal(done.state, "completed");
    assert.equal(x.calls(), 2);
    assert.ok(done.assessment_id && done.action_id && done.composition_id);
    assert.equal(x.a.list(x.w.id)[0].state, "open");
    assert.equal(
      x.ag.recent(x.w.id).every((r) => r.adoptions.length === 0),
      true,
    );
    assert.equal(await x.wf.tick(), null);
    assert.equal(x.wf.events(x.w.id, r.id).length, 7);
  } finally {
    x.s.db.close();
  }
});
test("pause/resume/cancel and no consent means no API request", async () => {
  const x = fixture();
  try {
    assert.throws(() => create(x, { confirm: false }));
    const r = create(x);
    x.wf.control(x.w.id, x.u.id, { id: r.id, action: "pause" });
    assert.equal(await x.wf.tick(), null);
    x.wf.control(x.w.id, x.u.id, { id: r.id, action: "resume" });
    await x.wf.tick();
    x.wf.control(x.w.id, x.u.id, { id: r.id, action: "cancel" });
    assert.equal(await x.wf.tick(), null);
    assert.equal(x.calls(), 1);
  } finally {
    x.s.db.close();
  }
});
test("actor role revocation stops before next step; workspace isolation", async () => {
  const x = fixture();
  try {
    const editor = x.auth.provision(x.u, { username: "editor", password: "test-password-12345" });
    x.auth.setMember(x.w.id, x.u.id, { username: "editor", role: "editor" });
    const r = x.wf.create(x.w.id, editor.id, {
      sampleId: x.id,
      provider: "deepseek",
      factIds: [x.f.id],
      confirm: true,
    });
    const b = x.auth.createWorkspace(x.u.id, { name: "B", brand: "Other" });
    assert.throws(() => x.wf.events(b.id, r.id));
    x.auth.removeMember(x.w.id, x.u.id, { username: "editor" });
    assert.equal((await x.wf.tick()).state, "failed");
    assert.equal(x.calls(), 0);
  } finally {
    x.s.db.close();
  }
});
test("restart marks in-flight workflow interrupted, no replay; stale facts halt", async () => {
  const x = fixture();
  try {
    const r = create(x);
    x.s.db.prepare("UPDATE geo_workflows SET state='running' WHERE id=?").run(r.id);
    const wf = openWorkflows(x.s, x.k, x.a, x.ag, x.auth, { providers: () => ["deepseek"] });
    assert.equal(wf.recent(x.w.id)[0].state, "interrupted");
    assert.equal(await wf.tick(), null);
    const next = create(x);
    x.s.db.prepare("UPDATE geo_fact_versions SET status='superseded' WHERE id=?").run(x.f.id);
    assert.equal((await x.wf.tick()).state, "failed");
    assert.equal(x.calls(), 0);
    assert.ok(next.id);
  } finally {
    x.s.db.close();
  }
});
