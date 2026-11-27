import { randomUUID, createHash } from "node:crypto";
import { allowedUrl, fetchPublicPage, textSnapshot } from "./import.mjs";
const iso = () => new Date().toISOString();
const clip = (s, n = 300) => String(s ?? "").slice(0, n);
const attr = (tag) => {
  const a = Object.create(null);
  for (const m of tag.matchAll(
    /\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g,
  )) {
    const k = m[1].toLowerCase();
    if (!Object.hasOwn(a, k)) a[k] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return a;
};
const words = (s) =>
  String(s ?? "")
    .toLowerCase()
    .split(/[\s,;]+/);
const strip = (s) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
// Heuristic inspection of bounded static HTML, not a browser or an indexing verdict.
export function inspectPage(page) {
  if (!page.type.startsWith("text/html")) throw Error("HTML required for technical audit");
  const html = page.text.replace(/<!--[\s\S]*?-->/g, " ");
  const scripts = [
    ...html.matchAll(/<script\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/script\s*>/gi),
  ];
  const markup = html.replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const tags = [...markup.matchAll(/<([a-z][a-z0-9:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)].map(
    (m) => ({ name: m[1].toLowerCase(), a: attr(m[0]) }),
  );
  const by = (n) => tags.filter((t) => t.name === n).map((t) => t.a);
  const metas = by("meta"),
    links = by("link"),
    title = strip(markup.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || "");
  const descriptions = metas.filter((x) => x.name?.toLowerCase() === "description"),
    description = descriptions[0]?.content?.trim() || "";
  const lang = by("html")[0]?.lang?.trim() || "",
    h1 = by("h1").length,
    images = by("img"),
    missingAlt = images.filter((a) => !Object.hasOwn(a, "alt")).length;
  const canonicals = links
    .filter((x) => words(x.rel).includes("canonical"))
    .map((x) => x.href || "");
  const robots = metas
    .filter((x) => ["robots", "googlebot", "bingbot"].includes(x.name?.toLowerCase()))
    .map((x) => ({ agent: x.name, content: clip(x.content) }));
  const header = clip(page.robotsHeader, 1000),
    directives = [...robots.map((x) => x.content), header];
  const blocked = directives.some((x) => /\b(?:noindex|none)\b/i.test(x)),
    snippet = directives.some((x) => /\bnosnippet\b|\bmax-snippet\s*:\s*0\b/i.test(x));
  const jsonScripts = scripts.filter(
    (m) =>
      attr("<script " + m[1] + ">")
        .type?.trim()
        .toLowerCase() === "application/ld+json",
  );
  let invalid = 0,
    valid = 0;
  const types = new Set();
  for (const m of jsonScripts) {
    try {
      const value = JSON.parse(m[2]);
      if (!value || typeof value !== "object") {
        invalid++;
        continue;
      }
      valid++;
      const nodes = [value];
      let visited = 0;
      while (nodes.length && visited++ < 5000) {
        const n = nodes.pop();
        if (!n || typeof n !== "object") continue;
        if (Array.isArray(n)) {
          nodes.push(...n.slice(0, 5000));
          continue;
        }
        for (const t of [n["@type"]].flat())
          if (typeof t === "string" && types.size < 30) types.add(clip(t, 100));
        for (const v of Object.values(n)) if (v && typeof v === "object") nodes.push(v);
      }
    } catch {
      invalid++;
    }
  }
  let chars = 0;
  try {
    const t = textSnapshot(page);
    chars = [...t.excerpt].length;
  } catch {}
  const findings = [];
  const check = (id, status, evidence, advice) => findings.push({ id, status, evidence, advice });
  check(
    "title",
    title ? "observed" : "review",
    clip(title) || "未发现非空 title",
    "确保每页有准确且独立的标题",
  );
  check(
    "description",
    description && descriptions.length === 1 ? "observed" : "review",
    clip(description) || "未发现非空 description",
    "设置准确的页面摘要并避免重复声明",
  );
  check(
    "language",
    lang ? "observed" : "review",
    clip(lang) || "未发现 html lang",
    "声明页面语言，便于辅助技术与内容解析",
  );
  check(
    "heading",
    h1 === 1 ? "observed" : "review",
    "H1 数量：" + h1,
    "核查主标题和层级结构；数量只是编辑提示",
  );
  check(
    "static-text",
    chars >= 100 ? "observed" : "review",
    "简化正文摘录字符数：" + chars + "（最多 3000）",
    "核查核心事实是否在无需执行 JS 的 HTML 中可读；短页面不一定存在问题",
  );
  check(
    "index-directive",
    blocked ? "attention" : "observed",
    JSON.stringify(robots) + "；X-Robots-Tag：" + header,
    "核查是否有意设置 noindex/none；未发现不表示一定可索引",
  );
  check(
    "snippet-directive",
    snippet ? "attention" : "observed",
    JSON.stringify(robots) + "；X-Robots-Tag：" + header,
    "核查摘要限制是否符合内容公开策略；不要擅自移除隐私限制",
  );
  let canonical = null;
  try {
    if (canonicals.length === 1 && canonicals[0]) {
      const u = new URL(canonicals[0], page.url);
      if (["https:", "http:"].includes(u.protocol) && !u.username && !u.password)
        canonical = u.href;
    }
  } catch {}
  check(
    "canonical",
    canonical && canonical === page.url ? "observed" : "review",
    canonical ? clip(canonical) : "未发现唯一有效 canonical（数量：" + canonicals.length + "）",
    "核查规范地址是否有意指向其他页面；不自动修改",
  );
  check(
    "jsonld",
    invalid ? "attention" : valid && types.size ? "observed" : "review",
    "JSON-LD 块：" +
      jsonScripts.length +
      "；可解析对象/数组：" +
      valid +
      "；无效：" +
      invalid +
      "；类型：" +
      [...types].join(", "),
    "使用与可见事实一致的结构化数据；语法可解析不代表 Schema.org 或搜索引擎合规",
  );
  check(
    "image-alt",
    missingAlt ? "review" : "observed",
    "图片：" + images.length + "；缺少 alt：" + missingAlt,
    "为信息性图片添加准确 alt，装饰图片可使用空 alt",
  );
  return {
    version: 1,
    contentHash: createHash("sha256").update(page.text).digest("hex"),
    findings,
    counts: Object.fromEntries(
      ["attention", "review", "observed"].map((s) => [
        s,
        findings.filter((f) => f.status === s).length,
      ]),
    ),
    limitations:
      "仅静态 HTML 启发式检测，未执行 JavaScript、未验证 robots.txt、站点地图、实际收录、爬虫权限、Schema.org 语义或 AI 排名。observed 仅表示检测到相应信号。",
  };
}
export function openSiteAudit(store, { hosts = [], fetchPage = fetchPublicPage, limit = 5 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw Error("Invalid site audit daily limit");
  const { db } = store;
  db.exec(
    "CREATE TABLE IF NOT EXISTS geo_site_audits(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),actor_id TEXT NOT NULL REFERENCES geo_users(id),url TEXT NOT NULL,state TEXT NOT NULL,report TEXT,error TEXT,created_at TEXT NOT NULL,finished_at TEXT);",
  );
  db.prepare(
    "UPDATE geo_site_audits SET state='interrupted',error='Interrupted; no automatic replay',finished_at=? WHERE state='running'",
  ).run(iso());
  const get = (w, id) =>
    db.prepare("SELECT * FROM geo_site_audits WHERE workspace_id=? AND id=?").get(w, id);
  const decode = (r) => ({ ...r, report: r.report ? JSON.parse(r.report) : null });
  let busy = false;
  async function run(w, actor, input) {
    if (input.confirm !== true || !store.workspace(w))
      throw Error("Explicit public website authorization required");
    const u = allowedUrl(input.url, hosts);
    if (busy) throw Error("Site audit busy");
    const id = randomUUID(),
      t = iso();
    if (
      !db
        .prepare(
          "INSERT INTO geo_site_audits(id,workspace_id,actor_id,url,state,created_at) SELECT ?,?,?,?,'running',? WHERE (SELECT count(*) FROM geo_site_audits WHERE created_at>=?)<?",
        )
        .run(id, w, actor, u.href, t, t.slice(0, 10), limit).changes
    )
      throw Error("Daily site audit limit reached");
    busy = true;
    try {
      const page = await fetchPage(u.href, hosts);
      if (page.url !== u.href) throw Error("Redirect rejected");
      const report = inspectPage(page);
      db.prepare(
        "UPDATE geo_site_audits SET state='success',report=?,finished_at=? WHERE id=?",
      ).run(JSON.stringify(report), iso(), id);
    } catch {
      db.prepare(
        "UPDATE geo_site_audits SET state='failed',error='Fetch or static HTML inspection failed',finished_at=? WHERE id=?",
      ).run(iso(), id);
    } finally {
      busy = false;
    }
    return decode(get(w, id));
  }
  const recent = (w) =>
    db
      .prepare(
        "SELECT * FROM geo_site_audits WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 30",
      )
      .all(w)
      .map(decode);
  function compare(w, id) {
    const r = get(w, id);
    if (!r || r.state !== "success") throw Error("Successful audit required");
    const previous = db
      .prepare(
        "SELECT * FROM geo_site_audits WHERE workspace_id=? AND url=? AND state='success' AND (created_at<? OR (created_at=? AND rowid<(SELECT rowid FROM geo_site_audits WHERE id=?))) ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get(w, r.url, r.created_at, r.created_at, r.id);
    if (!previous) return { previousId: null, changes: [] };
    const a = decode(previous).report,
      b = decode(r).report;
    return {
      previousId: previous.id,
      previousAt: previous.created_at,
      contentChanged: a.contentHash !== b.contentHash,
      changes: b.findings
        .map((f) => ({
          id: f.id,
          before: a.findings.find((x) => x.id === f.id)?.status ?? null,
          after: f.status,
        }))
        .filter((f) => f.before !== f.after),
    };
  }
  return { run, recent, compare, limit };
}
