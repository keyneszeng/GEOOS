import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
const now = () => new Date().toISOString(),
  max = 2 * 1024 * 1024;
export function parseDocument(ext, bytes) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "python3",
      [fileURLToPath(new URL("./parse-document.py", import.meta.url)), ext],
      {
        stdio: ["pipe", "pipe", "ignore"],
        env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C.UTF-8" },
      },
    );
    let chunks = [],
      n = 0;
    const t = setTimeout(() => {
      p.kill("SIGKILL");
      reject(Error("Parser timeout"));
    }, 15000);
    p.stdin.on("error", () => {});
    p.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.stdout.on("data", (b) => {
      n += b.length;
      if (n > 200000) {
        p.kill("SIGKILL");
        reject(Error("Output too large"));
      } else chunks.push(b);
    });
    p.on("close", (code) => {
      clearTimeout(t);
      try {
        if (code !== 0) throw Error("Document unreadable or unsupported");
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    p.stdin.end(bytes);
  });
}
export function openDocuments(store, knowledge, { parse = parseDocument } = {}) {
  const { db } = store;
  db.exec(
    "CREATE TABLE IF NOT EXISTS geo_documents(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),actor_id TEXT NOT NULL REFERENCES geo_users(id),filename TEXT NOT NULL,sha256 TEXT NOT NULL,method TEXT NOT NULL,truncated INTEGER NOT NULL,evidence_ids TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(workspace_id,sha256));",
  );
  let busy = false;
  async function run(w, actor, input) {
    if (input.confirm !== true || !store.workspace(w))
      throw Error("Confirm authorized internal document upload");
    const name = input.filename;
    if (typeof name !== "string" || name.length > 180 || /[\\/\x00-\x1f]/.test(name))
      throw Error("Invalid filename");
    const ext = name.split(".").pop().toLowerCase();
    if (
      !["pdf", "docx", "xlsx"].includes(ext) ||
      typeof input.base64 !== "string" ||
      input.base64.length > Math.ceil(max / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)
    )
      throw Error("PDF/DOCX/XLSX up to 2 MiB required");
    const bytes = Buffer.from(input.base64, "base64");
    if (!bytes.length || bytes.length > max) throw Error("File limit");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const existing = db
      .prepare("SELECT * FROM geo_documents WHERE workspace_id=? AND sha256=?")
      .get(w, hash);
    if (existing) return existing;
    if (busy) throw Error("Document parser busy");
    busy = true;
    try {
      const r = await parse(ext, bytes);
      if (typeof r.text !== "string" || !r.text.trim() || r.text.length > 24000)
        throw Error("Invalid document text");
      const points = [...r.text],
        parts = [];
      for (let i = 0; i < Math.min(points.length, 12000); i += 2500)
        parts.push(points.slice(i, i + 2500).join(""));
      const id = randomUUID();
      db.exec("BEGIN IMMEDIATE");
      try {
        const ids = parts
          .filter((p) => p.trim())
          .map(
            (p, i) =>
              knowledge.addEvidence(w, {
                title: name.slice(0, 165) + " #" + (i + 1),
                excerpt: p,
                visibility: "internal",
              }).id,
          );
        db.prepare("INSERT INTO geo_documents VALUES(?,?,?,?,?,?,?,?,?)").run(
          id,
          w,
          actor,
          name,
          hash,
          String(r.method).slice(0, 200),
          Number(!!r.truncated || points.length > 12000),
          JSON.stringify(ids),
          now(),
        );
        db.exec("COMMIT");
        return db.prepare("SELECT * FROM geo_documents WHERE id=?").get(id);
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    } finally {
      busy = false;
    }
  }
  return {
    run,
    list: (w) =>
      db
        .prepare(
          "SELECT * FROM geo_documents WHERE workspace_id=? ORDER BY created_at DESC LIMIT 50",
        )
        .all(w),
  };
}
