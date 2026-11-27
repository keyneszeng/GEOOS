import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../geo/store.mjs";
import { openKnowledge } from "../geo/knowledge.mjs";
import { openActions } from "../geo/actions.mjs";
function fixture() {
  const s = openStore(":memory:"),
    w = s.createWorkspace({ name: "A", brand: "Acme", competitors: ["Beta"] }),
    other = s.createWorkspace({ name: "B", brand: "Other" }),
    p = s.addPrompt(w.id, { question: "Which tool is best?" }),
    k = openKnowledge(s),
    a = openActions(s, k);
  return { s, w, other, p, k, a };
}
function fact(k, w, visibility = "public", value = "V1") {
  const e = k.addEvidence(w.id, {
    title: "Spec",
    url: visibility === "public" ? "https://example.com/spec" : "",
    excerpt: "Evidence " + value,
    visibility,
  });
  const f = k.propose(w.id, { subject: "Acme", predicate: "Capability", value, evidenceId: e.id });
  return { e, f };
}
function approve(k, w, f) {
  return k.review(w.id, { id: f.id, decision: "approved", note: "Checked manually" });
}
function seed(s, w, p) {
  for (let i = 0; i < 10; i++) {
    const j = s.reserve(w.id, p.id, "deepseek", 100);
    s.finish(j.id, w, {
      answer: "Beta",
      model: "test",
      citations: ["https://example.org/a"],
      sources: [],
      usage: null,
      raw: {},
    });
  }
}
test("evidence validation, dedupe, workspace isolation and internal exclusion", () => {
  const { s, w, other, k } = fixture();
  try {
    assert.throws(() =>
      k.addEvidence(w.id, {
        title: "Bad",
        excerpt: "X",
        url: "javascript:alert(1)",
        visibility: "public",
      }),
    );
    const { e, f } = fact(k, w, "internal");
    assert.equal(
      k.addEvidence(w.id, {
        title: "Spec",
        url: "",
        excerpt: "Evidence V1",
        visibility: "internal",
      }).id,
      e.id,
    );
    assert.throws(() =>
      k.propose(other.id, { subject: "Acme", predicate: "Cap", value: "X", evidenceId: e.id }),
    );
    assert.throws(() => approve(k, other, f));
    approve(k, w, f);
    assert.deepEqual(k.publicFacts(w.id), []);
    assert.deepEqual(k.listFacts(other.id), []);
  } finally {
    s.db.close();
  }
});
test("version history, only current approved fact exported, old draft cannot supersede newer approval", () => {
  const { s, w, k } = fixture();
  try {
    const one = fact(k, w).f;
    approve(k, w, one);
    const two = fact(k, w, "public", "V2").f,
      three = fact(k, w, "public", "V3").f;
    approve(k, w, three);
    assert.throws(() => approve(k, w, two));
    assert.equal(k.publicFacts(w.id)[0].value, "V3");
    assert.equal(k.listFacts(w.id).find((f) => f.id === one.id).status, "superseded");
    assert.equal(k.publicFacts(w.id).length, 1);
  } finally {
    s.db.close();
  }
});
test("opportunity derives from actual stored samples, deduplicates and retains source IDs", () => {
  const { s, w, other, p, a } = fixture();
  try {
    assert.equal(a.discover(w.id).created, 0);
    seed(s, w, p);
    assert.equal(a.discover(w.id).created, 1);
    assert.equal(a.discover(w.id).created, 0);
    const t = a.list(w.id)[0];
    assert.equal(JSON.parse(t.sample_ids).length, 5);
    assert.equal(a.list(other.id).length, 0);
    assert.throws(() => a.events(other.id, t.id));
  } finally {
    s.db.close();
  }
});
test("draft requires current public facts; approval invalidated by superseded fact", () => {
  const { s, w, p, k, a } = fixture();
  try {
    seed(s, w, p);
    a.discover(w.id);
    const t = a.list(w.id)[0];
    const internal = fact(k, w, "internal").f;
    approve(k, w, internal);
    assert.throws(() => a.draft(w.id, { id: t.id, factIds: [internal.id], outline: "Draft" }));
    const f = fact(k, w, "public", "V2").f;
    approve(k, w, f);
    const draft = a.draft(w.id, { id: t.id, factIds: [f.id], outline: "Draft" });
    assert.match(draft.draft, /https:\/\/example.com\/spec/);
    approve(k, w, fact(k, w, "public", "V3").f);
    assert.throws(() => a.transition(w.id, { id: t.id, state: "approved", note: "OK" }));
  } finally {
    s.db.close();
  }
});
test("review workflow and post-implementation evidence requirement", () => {
  const { s, w, p, k, a } = fixture();
  try {
    seed(s, w, p);
    a.discover(w.id);
    const t = a.list(w.id)[0],
      f = fact(k, w).f;
    approve(k, w, f);
    assert.throws(() => a.transition(w.id, { id: t.id, state: "implemented", note: "No" }));
    a.draft(w.id, { id: t.id, factIds: [f.id], outline: "Draft" });
    a.transition(w.id, { id: t.id, state: "approved", note: "OK" });
    a.transition(w.id, { id: t.id, state: "implemented", note: "Manually updated website" });
    assert.throws(() =>
      a.transition(w.id, {
        id: t.id,
        state: "verified",
        note: "Observed",
        sampleId: JSON.parse(t.sample_ids)[0],
      }),
    );
    const j = s.reserve(w.id, p.id, "deepseek", 100);
    s.finish(j.id, w, {
      answer: "Acme",
      model: "test",
      citations: [],
      sources: [],
      usage: null,
      raw: {},
    });
    s.db
      .prepare("UPDATE samples SET created_at=? WHERE id=?")
      .run(new Date(Date.now() + 1000).toISOString(), j.id);
    assert.equal(
      a.transition(w.id, {
        id: t.id,
        state: "verified",
        note: "Reviewed; no causal conclusion",
        sampleId: j.id,
      }).state,
      "verified",
    );
    assert.equal(a.events(w.id, t.id).length, 5);
  } finally {
    s.db.close();
  }
});
