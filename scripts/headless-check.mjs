// 无头 Edge + CDP：在真实页面上下文里验证前端逻辑（含纯函数断言与历史全文修复）。
// 运行：npm run test:ui（需本机装有 Edge 或 Chrome）
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "output");
const URL = "http://127.0.0.1:3456/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
const browser = BROWSERS.find((p) => fs.existsSync(p));
if (!browser) {
  console.log("NO_BROWSER_FOUND");
  process.exit(2);
}

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: "3456", HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });

const port = 9500 + Math.floor(Math.random() * 300);
const profile = path.join(os.tmpdir(), `aigc-cdp-${port}`);
const child = spawn(browser, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--window-size=1440,900",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

async function killAll(code) {
  try { child.kill(); } catch { /* 忽略 */ }
  try { server.kill(); } catch { /* 忽略 */ }
  await sleep(300);
  process.exit(code);
}

let ready = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(URL + "api/health");
    if (r.ok) { ready = true; break; }
  } catch { /* 等 */ }
  await sleep(250);
}
if (!ready) {
  console.error("本地服务未就绪:\n" + serverLog);
  await killAll(1);
}

let ws;
const exceptions = [];
const consoleErrors = [];
try {
  let wsUrl = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !wsUrl) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* 等 */ }
    if (!wsUrl) await sleep(300);
  }
  if (!wsUrl) throw new Error("CDP 端点未就绪");

  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("WS 连接失败")); });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params?.exceptionDetails;
      exceptions.push(d?.exception?.description ?? d?.text ?? "unknown");
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" "));
    }
  };
  const send = (method, params = {}) => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) return { error: r.exceptionDetails.exception?.description || "eval error" };
    return { value: r?.result?.value };
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: URL });

  let loaded = false;
  for (let i = 0; i < 40; i++) {
    const r = await evalJs('document.body ? document.body.innerText.length : 0');
    if ((r.value || 0) > 50) { loaded = true; break; }
    await sleep(400);
  }
  record("页面加载完成", loaded, "页面文本为空");
  await sleep(1200);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "ui-check.png"), Buffer.from(shot.data, "base64"));

  const probes = [
    ["标题正确", "document.title",
      (v) => v.includes("AIGC降重")],
    ["代理健康检查显示 v2.1", 'document.getElementById("proxyStatus").textContent',
      (v) => /2\.1\.\d+/.test(v)],
    ["默认强度为普通（普通按钮已高亮）", '(document.querySelector("#intensityGroup .active")||{}).dataset?.intensity',
      (v) => v === "normal"],
    ["默认策略为降AI·结构", '(document.querySelector("#strategyGroup .active")||{}).dataset?.strategy',
      (v) => v === "sentence-shuffle"],
    ["关键 DOM 齐全", '["rememberKeys","uploadZone","inputText","rewriteBtn","proxyStatus","headerInfo","progressWrap","viewTabs","compareArea","detectPanelBody"].filter(id=>!document.getElementById(id)).join(",")',
      (v) => v === ""],
    ["核心函数均已定义", '["startRewrite","singleRewrite","batchRewrite","doRewrite","splitIntoChunks","estimateMaxTokens","buildMessages","checkProxyHealth","migrateLegacyKeys","testConnection"].filter(f=>typeof window[f]!=="function").join(",")',
      (v) => v === ""],
    ["模型测试入口存在且未触发真实请求", '(() => { const el = document.getElementById("testResult"); const btn = document.querySelector(\'[onclick="testConnection()"]\'); return JSON.stringify({ hasSlot: !!el, hasBtn: !!btn, idle: getComputedStyle(el).display !== "none" }); })()',
      (v) => { const o = JSON.parse(v); return o.hasSlot && o.hasBtn && o.idle; }],
    ["已删除的 renderHeader 不再引用", 'typeof window.renderHeader',
      (v) => v === "undefined"],
    ["重复 startRewrite 已消除", 'document.documentElement.innerHTML.split("async function startRewrite()").length - 1',
      (v) => v === 1],
    ["提示敏感度文案存在", 'document.getElementById("detectPanelBody").textContent',
      (v) => v.includes("模型自评") || v.includes("权威")],
    ["首次提示条默认可见且含隐私与学术提示", '(() => { const el = document.getElementById("firstRunNotice"); return JSON.stringify({ exists: !!el, visible: el ? getComputedStyle(el).display !== "none" : false, hasText: el ? /第三方大模型/.test(el.textContent) && /学术诚信/.test(el.textContent) : false }); })()',
      (v) => { const o = JSON.parse(v); return o.exists && o.visible && o.hasText; }],
    ["提示条可关闭并记住", '(() => { dismissFirstRunNotice(); const hidden = getComputedStyle(document.getElementById("firstRunNotice")).display === "none"; return hidden && localStorage.getItem("aigc_notice_v21") === "1"; })()',
      (v) => v === true],
    ["公告支持多条（远端 JSON 结构）", '(() => { renderAnnounce({ items: [{ time: "t1", text: "第一条" }, { time: "t2", text: "第二条" }] }); const el = document.getElementById("announceBody"); return el.textContent.includes("第一条") && el.textContent.includes("第二条") && el.innerHTML.split("border-top").length - 1 === 1; })()',
      (v) => v === true],
    ["公告兼容旧的单条结构", '(() => { renderAnnounce({ time: "t", text: "唯一一条" }); return document.getElementById("announceBody").textContent.includes("唯一一条"); })()',
      (v) => v === true],
    ["分段：每段不超过 500 字且内容不丢", `(() => {
      const para = "本系统采用前后端分离架构，前端使用Vue 3与Element Plus；后端基于Spring Boot 2.6.13，数据库为MySQL 8.0，表exam_grade存储成绩；这一设计在答辩时被反复追问。".repeat(40);
      const chunks = splitIntoChunks(para, 500);
      return JSON.stringify({
        count: chunks.length,
        maxLen: Math.max(...chunks.map(c => c.length)),
        sameLen: chunks.join("").replace(/\\s/g, "").length === para.replace(/\\s/g, "").length
      });
    })()`,
      (v) => { const o = JSON.parse(v); return o.count >= 5 && o.maxLen <= 500 && o.sameLen; }],
    ["分段：无句读长文也能硬切", `(() => {
      const chunks = splitIntoChunks("甲".repeat(1800), 500);
      return JSON.stringify({ count: chunks.length, maxLen: Math.max(...chunks.map(c => c.length)) });
    })()`,
      (v) => { const o = JSON.parse(v); return o.count === 4 && o.maxLen === 500; }],
    ["max_tokens 随强度生效且封顶", '[estimateMaxTokens("x".repeat(2000),"heavy"), estimateMaxTokens("x".repeat(2000),"normal"), estimateMaxTokens("x".repeat(20000),"heavy")]',
      (v) => JSON.stringify(v) === JSON.stringify([3600, 2800, 8192])],
    ["buildMessages 带上下文时标注待改写段", `JSON.stringify(buildMessages(STRATEGIES["sentence-shuffle"], "待改写正文", "上文片段").map(m => [m.role, m.content.includes("【待改写文本】"), m.content.includes("不要输出上文"), m.content.includes("上文片段")]))`,
      (v) => JSON.stringify(JSON.parse(v)) === JSON.stringify([["system", true, true, false], ["user", true, false, true]])],
    ["历史记录保存原文全文并可完整回填", `(() => {
      originalText = "原".repeat(1234) + "文";
      rewrittenText = "改".repeat(567) + "写";
      currentStrategy = "sentence-shuffle";
      currentIntensity = "heavy";
      localStorage.removeItem("aigc_history");
      saveHistory();
      const rec = getHistory()[0];
      viewHistory(0);
      return JSON.stringify({
        storedLen: rec.original.length,
        v: rec.v,
        inputLen: document.getElementById("inputText").value.length,
        outputLen: document.getElementById("outputArea").textContent.length
      });
    })()`,
      (v) => { const o = JSON.parse(v); return o.storedLen === 1235 && o.inputLen === 1235 && o.outputLen === 568 && o.v === 2; }],
    ["历史超过 50 条自动截断", `(() => {
      localStorage.removeItem("aigc_history");
      originalText = "甲";
      rewrittenText = "乙";
      for (let i = 0; i < 55; i++) saveHistory();
      return getHistory().length;
    })()`,
      (v) => v === 50],
    ["超长句对比不再卡死", `(() => {
      const t = performance.now();
      const r = diffWords("甲".repeat(2000), "乙".repeat(2000));
      return Math.round(performance.now() - t) < 300 && r[0].length > 0;
    })()`,
      (v) => v === true],
    ["Key 存储：rememberKeys=false 走 sessionStorage", `(() => {
      const s = loadSettings();
      s.rememberKeys = false;
      saveSettings(s);
      saveKeys([{ id: "t1", name: "临时", key: "sk-abcdefghijklmn" }], false);
      const inSession = !!sessionStorage.getItem("aigc_keys");
      const inLocal = !!localStorage.getItem("aigc_keys");
      const loaded = loadKeys().length;
      saveKeys([], false);
      s.rememberKeys = true;
      saveSettings(s);
      return JSON.stringify({ inSession, inLocal, loaded });
    })()`,
      (v) => { const o = JSON.parse(v); return o.inSession && !o.inLocal && o.loaded === 1; }],
  ];

  for (const [name, expr, check] of probes) {
    const r = await evalJs(expr);
    if (r.error) record(name, false, String(r.error).slice(0, 200));
    else {
      let ok = false;
      let detail = "";
      try { ok = check(r.value); } catch (e) { detail = "检查器异常: " + e.message; }
      record(name, ok, detail || `实际值=${JSON.stringify(r.value).slice(0, 220)}`);
    }
  }

  record("无未捕获运行时异常", exceptions.length === 0, exceptions.slice(0, 3).map((e) => String(e).slice(0, 200)).join(" | "));
  record("无 console.error", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  const failed = results.filter((x) => !x.ok);
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  console.log("截图: output/ui-check.png");
  if (failed.length) {
    console.log("失败项：");
    for (const f of failed) console.log("  - " + f.name);
  }
  await killAll(failed.length ? 1 : 0);
} catch (err) {
  console.error("验证过程异常: " + err.message);
  await killAll(1);
}
