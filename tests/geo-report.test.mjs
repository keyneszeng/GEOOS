import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../geo/store.mjs";
import { openKnowledge } from "../geo/knowledge.mjs";
import { openActions } from "../geo/actions.mjs";
import { openAgent } from "../geo/agent.mjs";
import { openReviews } from "../geo/reviews.mjs";
import {
  openImporter,
  publicIPv4,
  allowedUrl,
  fetchPublicPage,
  textSnapshot,
} from "../geo/import.mjs";
function fixture() {
  const s = openStore(":memory:"),
    w = s.createWorkspace({ name: "A", brand: "Acme", competitors: ["Beta"] }),
    b = s.createWorkspace({ name: "B", brand: "Other" }),
    p = s.addPrompt(w.id, { question: "Which tool?" }),
    k = openKnowledge(s),
    a = openActions(s, k);
  return { s, w, b, p, k, a };
}
function seed(s, w, p, answer = "Beta") {
  const j = s.reserve(w.id, p.id, "deepseek", 100);
  s.finish(j.id, w, { answer, model: "test", citations: [], sources: [], usage: null, raw: {} });
  return j.id;
}
test("allowlist rejects private hosts, alternate ports, query and DNS rebinding inputs", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.1.1",
    "::1",
    "198.18.0.1",
  ])
    assert.equal(publicIPv4(ip), false);
  assert.equal(publicIPv4("8.8.8.8"), true);
  for (const u of [
    "http://example.com/",
    "https://example.com:444/",
    "https://evil.com/",
    "https://example.com/?q=x",
    "https://user@example.com/",
  ])
    assert.throws(() => allowedUrl(u, ["example.com"]));
  await assert.rejects(
    fetchPublicPage("https://example.com/", ["example.com"], {
      resolve: async () => ["8.8.8.8", "127.0.0.1"],
      request: () => {
        throw Error("Must not connect");
      },
    }),
    /Non-public/,
  );
});
test("text extraction and authorized import quota with mock page", async () => {
  const { s, w, b, k } = fixture();
  try {
    const importer = openImporter(s, k, {
      hosts: ["example.com"],
      limit: 1,
      fetchPage: async (url) => ({
        url,
        type: "text/html",
        text: "<head>hidden</head><p>Acme &amp; CSV</p><script>bad()</script>",
      }),
    });
    await assert.rejects(importer.run(w.id, { url: "https://example.com/", confirm: false }));
    const r = await importer.run(w.id, { url: "https://example.com/", confirm: true });
    assert.equal(r.state, "success");
    assert.equal(k.listEvidence(w.id)[0].excerpt, "Acme & CSV");
    assert.equal(k.listEvidence(b.id).length, 0);
    await assert.rejects(importer.run(w.id, { url: "https://example.com/", confirm: true }));
    assert.equal(textSnapshot({ type: "text/plain", text: "a".repeat(4000) }).truncated, true);
  } finally {
    s.db.close();
  }
});
test("manual review denominator, unique sample, and tenant checks", async () => {
  const { s, w, b, p, k, a } = fixture();
  try {
    const id = seed(s, w, p, "Acme is recommended.");
    seed(s, w, p);
    const ag = openAgent(s, k, a, {
      providers: () => ["deepseek"],
      request: async () => ({
        model: "judge",
        answer: JSON.stringify({
          category: "recommended",
          quote: "Acme is recommended.",
          reason: "Explicit",
          conflicts: [],
        }),
      }),
    });
    const r = await ag.run(w.id, {
      confirm: true,
      provider: "deepseek",
      kind: "assess",
      targetId: id,
    });
    const rev = openReviews(s, k);
    assert.throws(() =>
      rev.review(b.id, { runId: r.id, category: "recommended", note: "checked" }),
    );
    rev.review(w.id, { runId: r.id, category: "recommended", note: "checked" });
    rev.review(w.id, { runId: r.id, category: "mixed", note: "corrected" });
    const g = rev.stats(w.id)[0];
    assert.equal(g.valid, 2);
    assert.equal(g.reviewed, 1);
    assert.equal(g.coverage, 0.5);
    assert.equal(g.reviewedRecommendationRate, 0);
    assert.equal(rev.stats(b.id).length, 0);
  } finally {
    s.db.close();
  }
});
test("comparison anchors on implementation, excludes unmatched models and marks partial window", () => {
  const { s, w, b, p, k, a } = fixture();
  try {
    for (let i = 0; i < 10; i++) seed(s, w, p);
    a.discover(w.id);
    const action = a.list(w.id)[0];
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
    a.draft(w.id, { id: action.id, factIds: [f.id], outline: "Draft" });
    a.transition(w.id, { id: action.id, state: "approved", note: "ok" });
    a.transition(w.id, { id: action.id, state: "implemented", note: "done" });
    const t = Date.now() - 3600000;
    s.db
      .prepare(
        "UPDATE geo_action_events SET created_at=? WHERE action_id=? AND state='implemented'",
      )
      .run(new Date(t).toISOString(), action.id);
    s.db.prepare("UPDATE samples SET created_at=?").run(new Date(t - 3600000).toISOString());
    const id = seed(s, w, p, "Acme");
    s.db
      .prepare("UPDATE samples SET created_at=? WHERE id=?")
      .run(new Date(t + 1000).toISOString(), id);
    const other = seed(s, w, p, "Acme");
    s.db.prepare("UPDATE samples SET model='other' WHERE id=?").run(other);
    openAgent(s, k, a);
    const rev = openReviews(s, k);
    const x = rev.compare(w.id, action.id, 7);
    assert.equal(x.before.valid, 10);
    assert.equal(x.after.valid, 1);
    assert.equal(x.delta, 1);
    assert.equal(x.complete, false);
    assert.throws(() => rev.compare(b.id, action.id, 7));
  } finally {
    s.db.close();
  }
});
