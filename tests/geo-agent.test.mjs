import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../geo/store.mjs";
import { openKnowledge } from "../geo/knowledge.mjs";
import { openActions } from "../geo/actions.mjs";
import { openAgent, validateAgent } from "../geo/agent.mjs";
function fixture(request, limit = 5) {
  const s = openStore(":memory:"),
    w = s.createWorkspace({ name: "A", brand: "Acme", competitors: ["Beta"] }),
    other = s.createWorkspace({ name: "B", brand: "Other" }),
    p = s.addPrompt(w.id, { question: "Which tool?" }),
    k = openKnowledge(s),
    a = openActions(s, k),
    agent = openAgent(s, k, a, { request, limit, providers: () => ["deepseek"] });
  const e = k.addEvidence(w.id, {
    title: "Spec",
    url: "https://example.com/spec",
    excerpt: "Acme supports CSV export.",
    visibility: "public",
  });
  return { s, w, other, p, k, a, agent, e };
}
const response = (obj) => ({ model: "test", answer: JSON.stringify(obj) });
const candidate = {
  subject: "Acme",
  predicate: "Export",
  value: "CSV",
  quote: "Acme supports CSV export.",
};
const input = (kind, targetId, extra = {}) => ({
  confirm: true,
  kind,
  targetId,
  provider: "deepseek",
  ...extra,
});
function fact(k, w, e) {
  return k.review(w.id, {
    id: k.propose(w.id, { subject: "Acme", predicate: "Export", value: "CSV", evidenceId: e.id })
      .id,
    decision: "approved",
    note: "Checked",
  });
}
function seed(s, w, p) {
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
  }
}
test("extract requires verbatim evidence and adoption creates only draft with lineage", async () => {
  const { s, w, other, k, agent, e } = fixture(async () => response({ facts: [candidate] }));
  try {
    const r = await agent.run(w.id, input("extract", e.id));
    assert.equal(r.state, "success");
    assert.equal(k.listFacts(w.id).length, 0);
    assert.throws(() => agent.adopt(other.id, { id: r.id, item: 0 }));
    const f = agent.adopt(w.id, { id: r.id, item: 0 });
    assert.equal(f.status, "draft");
    assert.equal(agent.recent(w.id)[0].adoptions[0].target_id, f.id);
    assert.throws(() => agent.adopt(w.id, { id: r.id, item: 0 }));
    assert.equal(k.publicFacts(w.id).length, 0);
  } finally {
    s.db.close();
  }
});
test("internal evidence, unconfirmed calls, forged quotes and quota", async () => {
  let calls = 0;
  const { s, w, k, agent, e } = fixture(async () => {
    calls++;
    return response({ facts: [{ ...candidate, quote: "invented" }] });
  }, 1);
  try {
    const hidden = k.addEvidence(w.id, {
      title: "Private",
      excerpt: "SECRET",
      visibility: "internal",
    });
    await assert.rejects(agent.run(w.id, input("extract", hidden.id)));
    await assert.rejects(agent.run(w.id, input("extract", e.id, { confirm: false })));
    assert.equal(calls, 0);
    const r = await agent.run(w.id, input("extract", e.id));
    assert.equal(r.state, "failed");
    await assert.rejects(agent.run(w.id, input("extract", e.id)));
    assert.equal(calls, 1);
  } finally {
    s.db.close();
  }
});
test("semantic assessment requires grounded brand quote and known fact ID", () => {
  const ctx = {
    brand: "Acme",
    aliases: [],
    answer: "Acme is recommended. It has no CSV export.",
    facts: [{ id: "f1" }],
  };
  const v = validateAgent(
    "assess",
    JSON.stringify({
      category: "recommended",
      quote: "Acme is recommended.",
      reason: "explicit",
      conflicts: [{ factId: "f1", quote: "It has no CSV export.", reason: "Possible mismatch" }],
    }),
    ctx,
  );
  assert.equal(v.conflicts[0].factId, "f1");
  assert.throws(() => validateAgent("assess", JSON.stringify({ ...v, quote: "fabricated" }), ctx));
  assert.throws(() =>
    validateAgent("assess", JSON.stringify({ ...v, category: "not-mentioned" }), ctx),
  );
  assert.throws(() =>
    validateAgent(
      "assess",
      JSON.stringify({ ...v, conflicts: [{ ...v.conflicts[0], factId: "unknown" }] }),
      ctx,
    ),
  );
});
test("composition sends selected public facts only, adoption needs current approval", async () => {
  let captured = "",
    fid;
  const { s, w, p, k, a, agent, e } = fixture(async (_, prompt) => {
    captured = prompt;
    return response({
      sections: [{ heading: "Export", text: "Acme supports CSV.", factIds: [fid] }],
    });
  });
  try {
    const f = fact(k, w, e);
    fid = f.id;
    const internal = k.addEvidence(w.id, {
      title: "Secret",
      excerpt: "PRIVATE_XYZ",
      visibility: "internal",
    });
    const hidden = k.review(w.id, {
      id: k.propose(w.id, {
        subject: "Acme",
        predicate: "Secret",
        value: "PRIVATE_XYZ",
        evidenceId: internal.id,
      }).id,
      decision: "approved",
      note: "Checked",
    });
    seed(s, w, p);
    a.discover(w.id);
    const t = a.list(w.id)[0];
    await assert.rejects(agent.run(w.id, input("compose", t.id, { factIds: [hidden.id] })));
    const r = await agent.run(w.id, input("compose", t.id, { factIds: [fid] }));
    assert.equal(r.state, "success");
    assert.ok(!captured.includes("PRIVATE_XYZ"));
    const newer = k.propose(w.id, {
      subject: "Acme",
      predicate: "Export",
      value: "CSV and JSON",
      evidenceId: e.id,
    });
    k.review(w.id, { id: newer.id, decision: "approved", note: "Checked" });
    assert.throws(() => agent.adopt(w.id, { id: r.id }));
    assert.equal(a.list(w.id)[0].state, "open");
  } finally {
    s.db.close();
  }
});
test("valid AI outline enters existing approval workflow with atomic adoption", async () => {
  let fid;
  const { s, w, p, k, a, agent, e } = fixture(async () =>
    response({ sections: [{ heading: "Export", text: "Acme supports CSV.", factIds: [fid] }] }),
  );
  try {
    fid = fact(k, w, e).id;
    seed(s, w, p);
    a.discover(w.id);
    const t = a.list(w.id)[0],
      r = await agent.run(w.id, input("compose", t.id, { factIds: [fid] }));
    assert.equal(r.state, "success");
    const draft = agent.adopt(w.id, { id: r.id });
    assert.equal(draft.state, "draft");
    assert.match(draft.draft, /AI 生成/);
    assert.equal(agent.recent(w.id)[0].adoptions[0].target_id, t.id);
    assert.equal(
      a.transition(w.id, { id: t.id, state: "approved", note: "Human reviewed" }).state,
      "approved",
    );
  } finally {
    s.db.close();
  }
});
