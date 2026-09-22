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
  process.env.CHROME_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const browser = BROWSERS.find((p) => fs.existsSync(p));
if (!browser) {
  console.log("NO_BROWSER_FOUND（可用 CHROME_PATH 指定浏览器路径）");
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
  ...(process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
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
    ["代理健康检查显示 v3.1", 'document.getElementById("proxyStatus").textContent',
      (v) => /3\.1\.\d+/.test(v)],
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
    ["已移除全部预设模型选项", `(() => {
      const sel = document.getElementById("modelSelect");
      const vals = [...sel.options].map(o => o.value).join(",");
      return JSON.stringify({ count: sel.options.length, hasPreset: /deepseek|glm|qwen|mimo/i.test(vals) });
    })()`,
      (v) => { const o = JSON.parse(v); return o.count >= 1 && !o.hasPreset; }],
    ["无自定义模型时下拉为空并提示", `(() => {
      const sel = document.getElementById("modelSelect");
      return JSON.stringify({ value: sel.value, label: sel.options[sel.selectedIndex].textContent });
    })()`,
      (v) => { const o = JSON.parse(v); return o.value === "" && o.label.includes("还没有"); }],
    ["老配置里的预设模型 id 被迁移掉", `(() => {
      saveSettings(Object.assign(loadSettings(), { model: "deepseek-v4-pro", customModels: [] }));
      const had = migratePresetModel(loadSettings());
      return JSON.stringify({ had, model: loadSettings().model });
    })()`,
      (v) => { const o = JSON.parse(v); return o.had === true && o.model === null; }],
    ["添加自定义模型后自动选中且下拉只剩它", `(() => {
      document.getElementById("cmName").value = "测试模型";
      document.getElementById("cmUrl").value = "https://x.example.com/v1/chat/completions";
      document.getElementById("cmId").value = "test-model-id";
      addCustomModel();
      const sel = document.getElementById("modelSelect");
      const s = loadSettings();
      return JSON.stringify({
        count: s.customModels.length, model: s.model, selValue: sel.value,
        optCount: sel.options.length, optText: sel.options[0] ? sel.options[0].textContent : ""
      });
    })()`,
      (v) => { const o = JSON.parse(v); return o.count === 1 && o.selValue === o.model && o.optCount === 1 && o.optText === "测试模型"; }],
    ["删除最后一个模型后回落到空", `(() => {
      const s = loadSettings();
      delCustomModel(s.customModels[0].id);
      const after = loadSettings();
      return JSON.stringify({ model: after.model, count: after.customModels.length });
    })()`,
      (v) => { const o = JSON.parse(v); return o.model === null && o.count === 0; }],
    ["鉴权方式可选并会保存", `(() => {
      document.getElementById("cmName").value = "api-key 服务";
      document.getElementById("cmUrl").value = "https://api.example.com/v1/chat/completions";
      document.getElementById("cmId").value = "m-1";
      document.getElementById("cmAuth").value = "apikey";
      addCustomModel();
      const m = (loadSettings().customModels || []).find(x => x.name === "api-key 服务");
      return JSON.stringify({ auth: m ? m.auth : null, authInputReset: document.getElementById("cmAuth").value });
    })()`,
      (v) => { const o = JSON.parse(v); return o.auth === "apikey" && o.authInputReset === "bearer"; }],
    ["地址非 http(s) 开头会被拦下", `(() => {
      const before = loadSettings().customModels.length;
      document.getElementById("cmName").value = "bad";
      document.getElementById("cmUrl").value = "not-a-url";
      document.getElementById("cmId").value = "x";
      addCustomModel();
      return loadSettings().customModels.length === before;
    })()`,
      (v) => v === true],
    ["extractContent 支持 content 为数组", `extractContent({ choices: [{ message: { content: [{ text: "甲" }, { text: "乙" }] } }] }).text`,
      (v) => v === "甲乙"],
    ["extractContent 能识别「只回思考内容」", `(() => {
      const r = extractContent({ choices: [{ message: { content: "", reasoning_content: "我在想" } }] });
      return JSON.stringify({ empty: r.text === "", reasoning: r.reasoning === "我在想" });
    })()`,
      (v) => { const o = JSON.parse(v); return o.empty && o.reasoning; }],
    ["中文按字切成 token（对比视图才细）", `(() => {
      const t = tokenize("本系统采用");
      return JSON.stringify({ count: t.length, first: t[0] });
    })()`,
      (v) => { const o = JSON.parse(v); return o.count === 5 && o.first === "本"; }],
    ["英文与数字仍按词成块", `JSON.stringify(tokenize("Spring Boot 2.6.13 很快"))`,
      (v) => { const o = JSON.parse(v); return o.includes("Spring") && o.includes("2.6.13"); }],
    ["下划线与短横线连的标识符保持完整", `JSON.stringify(tokenize("exam_grade gpt-4 命中"))`,
      (v) => { const o = JSON.parse(v); return o.includes("exam_grade") && o.includes("gpt-4"); }],
    ["技术细节提取含版本号、表名、百分比", `JSON.stringify(extractTechnicalTokens("使用 Spring Boot 2.6.13，表 exam_grade 命中率 92%").sort())`,
      (v) => { const o = JSON.parse(v); return o.includes("Spring") && o.includes("2.6.13") && o.includes("exam_grade"); }],
    ["质量自检会点名丢失的技术信息", `(() => {
      reportQuality("使用 Spring Boot 2.6.13 与表 exam_grade", "本系统采用后端框架，数据库中有成绩表");
      const el = document.getElementById("qualityHint");
      return JSON.stringify({ shown: el.classList.contains("show"), v: el.textContent.includes("2.6.13"), t: el.textContent.includes("exam_grade") });
    })()`,
      (v) => { const o = JSON.parse(v); return o.shown && o.v && o.t; }],
    ["相似度：完全相同 100%，完全不同 0%", `JSON.stringify([textSimilarity("完全一样的一段文字", "完全一样的一段文字"), textSimilarity("甲乙丙丁戊己", "壬癸子丑寅卯")])`,
      (v) => { const [a, b] = JSON.parse(v); return a === 100 && b === 0; }],
    ["相似度：小幅改动落在合理区间", `(() => {
      const s = textSimilarity("本系统采用前后端分离架构，后端基于 Spring Boot 2.6.13。", "本系统采用前后端分离架构，后端基于 Spring Boot 2.6.13 实现。");
      return s;
    })()`,
      (v) => typeof v === "number" && v >= 70 && v < 100],
    ["Word 导出 / 再降一次 / 停止入口都在", `JSON.stringify([typeof downloadWord, typeof polishAgain, typeof stopRewrite, typeof reportQuality])`,
      (v) => v === JSON.stringify(["function", "function", "function", "function"])],
    ["停止按钮默认隐藏、改写时才出现", `getComputedStyle(document.getElementById("stopBtn")).display`,
      (v) => v === "none"],
    ["草稿：写入后能恢复", `(() => {
      setInputText("这是一段待改写的草稿文本");
      saveDraft();
      document.getElementById("inputText").value = "";
      const ok = restoreDraft();
      return JSON.stringify({ ok, value: document.getElementById("inputText").value });
    })()`,
      (v) => { const o = JSON.parse(v); return o.ok === true && o.value.includes("草稿文本"); }],
    ["草稿：关掉开关后立即清除", `(() => {
      const box = document.getElementById("saveDraft");
      box.checked = false;
      box.dispatchEvent(new Event("change"));
      saveDraft();
      return JSON.stringify({ draft: localStorage.getItem("aigc_draft"), setting: loadSettings().saveDraft });
    })()`,
      (v) => { const o = JSON.parse(v); return o.draft === null && o.setting === false; }],
    ["无障碍：图标按钮有 aria-label，toast 有 live 区", `(() => {
      const btns = [...document.querySelectorAll(".btn-settings")];
      const labeled = btns.filter(b => b.getAttribute("aria-label")).length;
      const toast = document.getElementById("toast");
      return JSON.stringify({ total: btns.length, labeled, live: toast.getAttribute("aria-live") });
    })()`,
      (v) => { const o = JSON.parse(v); return o.total === o.labeled && o.total === 4 && o.live === "polite"; }],
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
