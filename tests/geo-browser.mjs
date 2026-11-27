import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url),
  { chromium } = require(process.env.GEO_PLAYWRIGHT_MODULE || "playwright");
const dir = mkdtempSync(join(tmpdir(), "geo-browser-")),
  port = 3199,
  origin = "http://127.0.0.1:" + port,
  child = spawn(process.execPath, ["geo/server.mjs"], {
    env: {
      ...process.env,
      GEO_PORT: String(port),
      GEO_DB: join(dir, "db.sqlite"),
      GEO_ADMIN_USER: "admin",
      GEO_ADMIN_PASSWORD: "test-password-12345",
      DEEPSEEK_API_KEY: "",
      OPENAI_API_KEY: "",
      PERPLEXITY_API_KEY: "",
      GEMINI_API_KEY: "",
      GEO_INSTAGRAM_CONFIG: "{}",
    },
    stdio: "inherit",
  });
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin + "/healthz")).ok) break;
    } catch {}
    if (i === 99) throw Error("Server failed to start");
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  assert.equal(await page.locator("#nav a").count(), 11);
  assert.equal(await page.locator("#import,#reset,#noticeImport").count(), 0);
  await page.waitForFunction(
    () =>
      document.querySelector("#notice").hidden && !document.querySelector("#immersive").disabled,
  );
  assert.equal(await page.locator("#flat").isVisible(), true);
  await page.locator("#immersive").click();
  assert.equal(await page.locator("#immersive").getAttribute("aria-pressed"), "true");
  await page.locator("#plus").click();
  await page.locator("#viewport").press("ArrowRight");
  await page.locator("#full").click();
  assert.equal(await page.locator("#full").getAttribute("aria-pressed"), "true");
  await page.locator("#nav a").first().click();
  await page.locator('#login [name="username"]').fill("admin");
  await page.locator('#login [name="password"]').fill("test-password-12345");
  await page.locator("#login button").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.locator('#workspace [name="name"]').fill("Browser test");
  await page.locator('#workspace [name="brand"]').fill("Example");
  await page.locator("#workspace button").click();
  await page.waitForFunction(() => document.querySelector("#nextSteps")?.children.length === 8);
  assert.deepEqual(await page.locator("#nav button").allTextContents(), [
    "GEO 指挥舱",
    "01 知识底座",
    "02 AI 监测",
    "03 回答复核",
    "04 机会洞察",
    "05 官网诊断",
    "06 优化行动",
    "07 内容分发",
    "08 效果复盘",
    "自动化运营",
    "企业与权限",
  ]);
  for (const label of [
    "GEO 指挥舱",
    "01 知识底座",
    "02 AI 监测",
    "03 回答复核",
    "04 机会洞察",
    "05 官网诊断",
    "06 优化行动",
    "07 内容分发",
    "08 效果复盘",
    "自动化运营",
    "企业与权限",
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    assert.equal(
      await page.getByRole("button", { name: label, exact: true }).getAttribute("aria-pressed"),
      "true",
    );
  }
  await page.getByRole("button", { name: "02 AI 监测", exact: true }).click();
  await page.locator('#prompt [name="question"]').fill("Which product meets the need?");
  await page.locator("#prompt button").click();
  await page.waitForFunction(() =>
    [...document.querySelector("#questions").options].some((o) => o.text.includes("Which product")),
  );
  await page.getByRole("button", { name: "05 官网诊断", exact: true }).click();
  await page.locator("#schemaForm textarea").fill(
    JSON.stringify({
      action: "generate",
      type: "Organization",
      fields: { name: "Example", url: "https://example.com/" },
      confirm: true,
    }),
  );
  await page.locator("#schemaForm button").click();
  await page.waitForFunction(() =>
    document.querySelector("#schemaResult").textContent.includes("schema.org"),
  );
  assert.equal(await page.locator("#ws").isVisible(), true);
  for (const [label, kind, slot] of [
    ["01 知识底座", "extract", "extractSlot"],
    ["03 回答复核", "assess", "assessSlot"],
    ["06 优化行动", "compose", "composeSlot"],
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    assert.equal(await page.locator("#agentKind").inputValue(), kind);
    assert.equal(await page.locator("#" + slot + " #agentPanel").count(), 1);
    assert.equal(await page.locator("#agentRun").isDisabled(), true);
  }
  await page.getByRole("button", { name: "07 内容分发", exact: true }).click();
  assert.equal(await page.locator("#publicationForm button").isDisabled(), true);
  assert.equal(await page.locator("#copyGenerate").isDisabled(), true);
  await page.getByRole("button", { name: "08 效果复盘", exact: true }).click();
  assert.match(await page.locator("#metricEntryList").textContent(), /暂无实际发布/);
  await page.getByRole("button", { name: "企业与权限", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector("#billingList").textContent.includes("尚未分配"),
  );
  await page.getByRole("link", { name: "GEO/OS · 返回银河首页" }).click();
  await page.getByRole("link", { name: "05 官网诊断", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#nav [data-view=site]")?.getAttribute("aria-pressed") === "true",
  );
  assert.equal(await page.locator("#schemaForm").isVisible(), true);
  await page.locator("#logout").click();
  await page.locator("#loginPanel").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
  console.log("Browser smoke passed");
} finally {
  await browser?.close();
  if (child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
  rmSync(dir, { recursive: true, force: true });
}
