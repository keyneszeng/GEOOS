import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../geo/store.mjs";
import { openAuth } from "../geo/auth.mjs";
import { robotsPolicy, sitemapLocations, openSiteScan } from "../geo/site-scan.mjs";
import { schemaTool } from "../geo/schema-tools.mjs";
import { openSiteAudit } from "../geo/site-audit.mjs";
import { openRemediation } from "../geo/site-remediation.mjs";
function fixture() {
  const s = openStore(":memory:"),
    a = openAuth(s, { bootstrapUser: "admin", bootstrapPassword: "test-password-12345" }),
    token = a.login({ username: "admin", password: "test-password-12345" }),
    u = a.authenticate({ headers: { cookie: "geo_session=" + token } }),
    w = a.createWorkspace(u.id, { name: "A", brand: "Acme" });
  return { s, a, u, w };
}
test("conservative robots, sitemap and same origin bounded scan", async () => {
  const x = fixture();
  try {
    assert.equal(robotsPolicy("User-agent: *\nDisallow: /private").allows("/private/a"), false);
    assert.throws(() => sitemapLocations("<!DOCTYPE x><urlset/>"));
    const called = [],
      scan = openSiteScan(x.s, {
        hosts: ["example.com"],
        delay: async () => {},
        fetchPage: async (url) => {
          called.push(url);
          return {
            url,
            type: url.endsWith("robots.txt")
              ? "text/plain"
              : url.endsWith(".xml")
                ? "application/xml"
                : "text/html",
            text: url.endsWith("robots.txt")
              ? "User-agent: *\nDisallow: /private"
              : url.endsWith(".xml")
                ? "<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/private</loc></url><url><loc>https://other.com/a</loc></url></urlset>"
                : "<title>Page</title><a href='/b'>B</a>",
          };
        },
      });
    const r = await scan.run(x.w.id, x.u.id, {
      url: "https://example.com/",
      maxPages: 2,
      confirm: true,
    });
    assert.equal(r.state, "success");
    assert.equal(r.report.pages.length, 2);
    assert.ok(r.report.blocked.includes("https://example.com/private"));
    assert.equal(called.length, 4);
    assert.ok(called.every((u) => u.startsWith("https://example.com/") && !u.includes("private")));
  } finally {
    x.s.db.close();
  }
});
test("structured data supported field validation and safe script encoding", () => {
  const r = schemaTool({
    action: "generate",
    confirm: true,
    type: "Organization",
    fields: { name: "</script>", url: "https://example.com/" },
  });
  assert.ok(!r.html.includes('"</script>"'));
  assert.equal(schemaTool({ action: "validate", value: r.value }).valid, true);
  assert.throws(() =>
    schemaTool({
      action: "generate",
      confirm: true,
      type: "Organization",
      fields: { name: "A", url: "javascript:alert(1)" },
    }),
  );
});
test("remediation is tied to actual report and newer successful audit", async () => {
  const x = fixture();
  try {
    let text = "<h1>A</h1>";
    const a = openSiteAudit(x.s, {
      hosts: ["example.com"],
      fetchPage: async (url) => ({ url, type: "text/html", text }),
    });
    openSiteScan(x.s);
    const tasks = openRemediation(x.s),
      url = "https://example.com/";
    const r = await a.run(x.w.id, x.u.id, { url, confirm: true });
    const t = tasks.create(x.w.id, x.u.id, { kind: "audit", sourceId: r.id, finding: "title" });
    tasks.change(x.w.id, x.u.id, { action: "implement", id: t.id, note: "fixed" });
    assert.throws(() =>
      tasks.change(x.w.id, x.u.id, { action: "verify", id: t.id, note: "checked", auditId: r.id }),
    );
    await new Promise((r) => setTimeout(r, 5));
    text = "<title>Fixed</title>";
    const after = await a.run(x.w.id, x.u.id, { url, confirm: true });
    assert.equal(
      tasks.change(x.w.id, x.u.id, {
        action: "verify",
        id: t.id,
        note: "checked",
        auditId: after.id,
      }).state,
      "verified",
    );
  } finally {
    x.s.db.close();
  }
});

import { openKnowledge } from "../geo/knowledge.mjs";
import { openDocuments, parseDocument } from "../geo/documents.mjs";
import { fetchTraffic } from "../geo/traffic-sync.mjs";
import { spawnSync } from "node:child_process";
test("DOCX actual parser and internal evidence, dedupe, malformed archive rejected", async () => {
  const x = fixture();
  try {
    const z = spawnSync("python3", [
      "-c",
      "import io,zipfile,sys; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); z.writestr('word/document.xml','<document><p><t>Internal fact</t></p></document>'); z.close(); sys.stdout.buffer.write(b.getvalue())",
    ]);
    assert.equal(z.status, 0);
    const k = openKnowledge(x.s),
      d = openDocuments(x.s, k);
    const input = { filename: "doc.docx", base64: z.stdout.toString("base64"), confirm: true };
    const r = await d.run(x.w.id, x.u.id, input);
    assert.equal(k.listEvidence(x.w.id)[0].visibility, "internal");
    assert.equal((await d.run(x.w.id, x.u.id, input)).id, r.id);
    await assert.rejects(parseDocument("xlsx", Buffer.from("bad")));
  } finally {
    x.s.db.close();
  }
});
test("real API contract adapters preserve unknown and reject Instagram mismatched media", async () => {
  const y = await fetchTraffic(
    { platform: "youtube", public_url: "https://youtu.be/abcdefghijk" },
    { youtubeKey: "test" },
    async (u, o) => {
      assert.equal(u.hostname, "www.googleapis.com");
      assert.equal(o.headers["x-goog-api-key"], "test");
      return new Response(
        JSON.stringify({ items: [{ id: "abcdefghijk", statistics: { viewCount: "7" } }] }),
      );
    },
  );
  assert.equal(y.metrics.views, 7);
  assert.equal(y.metrics.likes, null);
  await assert.rejects(
    fetchTraffic(
      {
        platform: "instagram",
        workspace_id: "w",
        external_id: "123456",
        public_url: "https://www.instagram.com/p/a/",
      },
      { instagram: { w: { token: "test", version: "v25.0" } } },
      async () =>
        new Response(
          JSON.stringify({
            id: "123456",
            permalink: "https://www.instagram.com/p/b/",
            like_count: 4,
          }),
        ),
    ),
  );
});

import { openBilling } from "../geo/billing.mjs";
import { openActions } from "../geo/actions.mjs";
import { openAgent } from "../geo/agent.mjs";
import { createMcp } from "../geo/mcp.mjs";
test("billing plans, invoice and settlement with monthly quota", () => {
  const x = fixture();
  try {
    const k = openKnowledge(x.s),
      a = openActions(x.s, k);
    openAgent(x.s, k, a);
    const b = openBilling(x.s);
    x.s.billingCheck = b.check;
    const p = x.s.addPrompt(x.w.id, { question: "Which tool?" });
    assert.throws(() => b.change({ platform_admin: 0 }, x.w.id, { action: "set" }));
    b.change(x.u, x.w.id, {
      action: "set",
      name: "Contract",
      priceMinor: 1200,
      currency: "CNY",
      sampleLimit: 1,
      agentLimit: 0,
    });
    x.s.reserve(x.w.id, p.id, "deepseek", 100);
    assert.throws(() => x.s.reserve(x.w.id, p.id, "deepseek", 100), /monthly/);
    assert.throws(() => b.check(x.w.id, "agent"), /monthly/);
    const period = b.read(x.w.id).usage.period;
    b.change(x.u, x.w.id, { action: "invoice", period });
    assert.throws(() => b.change(x.u, x.w.id, { action: "invoice", period }));
    const invoice = b.read(x.w.id).invoices[0];
    assert.throws(() =>
      b.change(x.u, x.w.id, { action: "settle", id: invoice.id, reference: "receipt" }),
    );
    assert.equal(
      b.change(x.u, x.w.id, {
        action: "settle",
        id: invoice.id,
        reference: "receipt",
        confirm: true,
      }).invoices[0].state,
      "settled",
    );
  } finally {
    x.s.db.close();
  }
});
test("MCP read-only contract and path validation", async () => {
  const calls = [],
    handler = createMcp({
      env: { GEO_MCP_USER: "viewer", GEO_MCP_PASSWORD: "test-password" },
      request: async (url, opt) => {
        calls.push(url);
        if (url.endsWith("/login"))
          return new Response("{}", { headers: { "set-cookie": "geo_session=mock; HttpOnly" } });
        return new Response(
          JSON.stringify({ workspaces: [{ id: "a", name: "A", brand: "Acme", role: "viewer" }] }),
        );
      },
    });
  const rpc = (method, params) => handler({ jsonrpc: "2.0", id: 1, method, params });
  assert.ok((await rpc("initialize", {})).result.protocolVersion);
  assert.equal((await rpc("tools/list")).result.tools.length, 8);
  assert.equal((await rpc("tools/call", { name: "geo_workspaces" })).result.isError, undefined);
  assert.equal(calls.length, 2);
  assert.ok(
    (await rpc("tools/call", { name: "geo_metrics", arguments: { workspaceId: "../../" } })).result
      .isError,
  );
  assert.equal(calls.length, 2);
  assert.ok((await rpc("tools/call", { name: "publish" })).error);
});

import { openQueue } from "../geo/queue.mjs";
test("monthly quota exhausted workspace does not block other queued jobs", () => {
  const x = fixture();
  try {
    const k = openKnowledge(x.s),
      a = openActions(x.s, k);
    openAgent(x.s, k, a);
    const b = openBilling(x.s);
    x.s.billingCheck = b.check;
    const q = openQueue(x.s),
      w2 = x.a.createWorkspace(x.u.id, { name: "B", brand: "Beta" }),
      p = x.s.addPrompt(x.w.id, { question: "Which tool?" }),
      p2 = x.s.addPrompt(w2.id, { question: "Which product?" });
    b.change(x.u, x.w.id, {
      action: "set",
      name: "Limited",
      priceMinor: 0,
      currency: "CNY",
      sampleLimit: 0,
      agentLimit: 0,
    });
    const blocked = q.enqueue(x.w.id, p.id, "deepseek");
    q.enqueue(w2.id, p2.id, "deepseek");
    assert.equal(q.claim(["deepseek"], 100).workspace_id, w2.id);
    assert.equal(q.get(blocked.id, x.w.id).state, "failed");
  } finally {
    x.s.db.close();
  }
});
test("XLSX actual parser reads cached cells", async () => {
  const z = spawnSync("python3", [
    "-c",
    "import io,zipfile,sys; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); z.writestr('xl/worksheets/sheet1.xml','<worksheet><row><c r=\"A1\" t=\"inlineStr\"><is><t>Revenue</t></is></c><c r=\"B1\"><f>1+2</f><v>3</v></c></row></worksheet>'); z.close(); sys.stdout.buffer.write(b.getvalue())",
  ]);
  assert.equal(z.status, 0);
  const p = await parseDocument("xlsx", z.stdout);
  assert.match(p.text, /A1: Revenue/);
  assert.match(p.text, /B1: 3/);
  assert.ok(!p.text.includes("1+2"));
});
test("PDF actual parser extracts text layer", async () => {
  const stream = "BT /F1 12 Tf 10 100 Td (GEO document) Tj ET\n",
    objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Length " + stream.length + " >>\nstream\n" + stream + "endstream",
    ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += i + 1 + " 0 obj\n" + objects[i] + "\nendobj\n";
  }
  const xref = pdf.length;
  pdf +=
    "xref\n0 6\n0000000000 65535 f \n" +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" +
    xref +
    "\n%%EOF\n";
  assert.match((await parseDocument("pdf", Buffer.from(pdf))).text, /GEO document/);
});
