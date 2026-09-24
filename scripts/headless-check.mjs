// 无头 Edge + CDP：在真实页面上下文里验证前端逻辑（含纯函数断言与历史全文修复）。
// 运行：npm run test:ui（需本机装有 Edge 或 Chrome）
import { spawn } from "node:child_process";
import { recordCount } from "./_test-count.mjs";
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
// profile 目录名带上唯一后缀：端口随机数有可能撞上上次遗留的目录，
// 那样会把旧的 localStorage（模型、草稿、提示条标记）带进来，让"全新环境"类的断言随机失败
const profile = path.join(os.tmpdir(), `aigc-cdp-${port}-${Date.now().toString(36)}`);
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

  // 明确清空一次存储再重载，保证断言的是"首次访问"状态，而不是复用上一个 profile 的残留
  await evalJs('try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} "cleared"');
  await send("Page.reload", { ignoreCache: true });
  let reloaded = false;
  for (let i = 0; i < 40; i++) {
    const r = await evalJs('document.body ? document.body.innerText.length : 0');
    if ((r.value || 0) > 50) { reloaded = true; break; }
    await sleep(400);
  }
  record("页面加载完成", loaded && reloaded, `首次加载=${loaded} 清空存储后重载=${reloaded}`);
  await sleep(1200);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "ui-check.png"), Buffer.from(shot.data, "base64"));

  const probes = [
    ["标题正确", "document.title",
      (v) => v.includes("AIGC降重")],
    ["代理健康检查显示 v3.10", 'document.getElementById("proxyStatus").textContent',
      (v) => /3\.10\.\d+/.test(v)],
    ["默认强度为普通（普通按钮已高亮）", '(document.querySelector("#intensityGroup .active")||{}).dataset?.intensity',
      (v) => v === "normal"],
    ["默认策略为降AI·结构", '(document.querySelector("#strategyGroup .active")||{}).dataset?.strategy',
      (v) => v === "sentence-shuffle"],
    ["关键 DOM 齐全", '["rememberKeys","saveDraft","inputCard","pickFileBtn","uploadHint","inputText","rewriteBtn","proxyStatus","headerInfo","progressWrap","viewTabs","compareArea","detectPanelBody","resultMeta","qualityHint"].filter(id=>!document.getElementById(id)).join(",")',
      (v) => v === ""],
    ["左右两栏逐层对齐（针对「布局不对称」的回归断言）", `(() => {
      const rect = (el) => { const b = el.getBoundingClientRect(); return { t: Math.round(b.top), h: Math.round(b.height), b: Math.round(b.bottom) }; };
      const cards = [...document.querySelectorAll(".main > .card.panel")];
      if (cards.length !== 2) return JSON.stringify({ cards: cards.length });
      const leftBtn = cards[0].querySelector(".foot-actions .btn");
      const rightBtn = cards[1].querySelector(".foot-actions .btn");
      const leftNote = cards[0].querySelector(".foot-note");
      const rightNote = cards[1].querySelector(".foot-note");
      return JSON.stringify({
        cards: cards.length,
        cardTop: Math.abs(rect(cards[0]).t - rect(cards[1]).t),
        cardHeight: Math.abs(rect(cards[0]).h - rect(cards[1]).h),
        contentTop: Math.abs(rect(document.getElementById("inputText")).t - rect(document.getElementById("outputArea")).t),
        contentHeight: Math.abs(rect(document.getElementById("inputText")).h - rect(document.getElementById("outputArea")).h),
        toolsTop: Math.abs(rect(cards[0].querySelector(".panel-tools")).t - rect(cards[1].querySelector(".panel-tools")).t),
        noteTop: Math.abs(rect(leftNote).t - rect(rightNote).t),
        footBtnBottom: Math.abs(rect(leftBtn).b - rect(rightBtn).b)
      });
    })()`,
      (v) => {
        const o = JSON.parse(v);
        if (o.cards !== 2) return false;
        return ["cardTop", "cardHeight", "contentTop", "contentHeight", "toolsTop", "noteTop", "footBtnBottom"]
          .every((k) => o[k] <= 1);
      }],
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
    ["设计令牌：圆角 / 阴影 / 玻璃已生效", `(() => {
      const cs = getComputedStyle(document.documentElement);
      return JSON.stringify({
        rLg: cs.getPropertyValue("--r-lg").trim(),
        hasShadow1: cs.getPropertyValue("--shadow-1").trim().length > 0,
        glass: cs.getPropertyValue("--glass-blur").trim()
      });
    })()`,
      (v) => { const o = JSON.parse(v); return o.rLg === "16px" && o.hasShadow1 && o.glass === "30px"; }],
    ["二级界面：设置弹窗是真的玻璃（backdrop-filter + 大圆角）", `(() => {
      openSettings();
      const cs = getComputedStyle(document.querySelector(".modal"));
      const bf = cs.backdropFilter || cs.webkitBackdropFilter || "";
      const overlay = getComputedStyle(document.getElementById("modalOverlay"));
      const obf = overlay.backdropFilter || overlay.webkitBackdropFilter || "";
      return JSON.stringify({ blur: /blur/.test(bf), radius: parseFloat(cs.borderRadius), overlayBlur: /blur/.test(obf) });
    })()`,
      (v) => { const o = JSON.parse(v); return o.blur && o.radius >= 20 && o.overlayBlur; }],
    ["二级界面：侧边面板同款玻璃", `(() => {
      closeSettings({ target: document.getElementById("modalOverlay") });
      openHistory();
      const cs = getComputedStyle(document.querySelector(".history-panel"));
      const bf = cs.backdropFilter || cs.webkitBackdropFilter || "";
      return JSON.stringify({ blur: /blur/.test(bf), radius: parseFloat(cs.borderRadius) >= 20 });
    })()`,
      (v) => { const o = JSON.parse(v); return o.blur && o.radius; }],
    ["分组标题已去掉 emoji（层级交给字号与字距）", `(() => {
      const t = [...document.querySelectorAll(".section-title")].map(e => e.textContent.trim());
      return JSON.stringify({ count: t.length, hasEmoji: t.some(x => /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/u.test(x)), sample: t.slice(0, 3) });
    })()`,
      (v) => { const o = JSON.parse(v); return o.count >= 3 && !o.hasEmoji; }],
    ["进度条能真正显示（此前 style.display='' 被 CSS 覆盖）", `(() => {
      const el = document.getElementById("progressWrap");
      el.style.display = "block";
      const shown = getComputedStyle(el).display !== "none";
      el.style.display = "none";
      return shown;
    })()`,
      (v) => v === true],
    ["「关闭思考模式」可保存并在卡片上标出", `(() => {
      document.getElementById("cmName").value = "推理模型";
      document.getElementById("cmUrl").value = "https://api.example.com/v1/chat/completions";
      document.getElementById("cmId").value = "reasoner-x";
      document.getElementById("cmNoThinking").checked = true;
      addCustomModel();
      const m = (loadSettings().customModels || []).find(x => x.name === "推理模型");
      return JSON.stringify({
        saved: m ? m.noThinking : null,
        marked: document.getElementById("customModelList").textContent.includes("已关思考"),
        resetAfterAdd: document.getElementById("cmNoThinking").checked
      });
    })()`,
      (v) => { const o = JSON.parse(v); return o.saved === true && o.marked && o.resetAfterAdd === false; }],
    ["输出预算能逐级放大（推理模型吃满预算时用）", `JSON.stringify([
      estimateMaxTokens("x".repeat(500), "heavy"),
      estimateMaxTokens("x".repeat(500), "heavy", 1),
      estimateMaxTokens("x".repeat(500), "heavy", 2),
      estimateMaxTokens("x".repeat(9000), "heavy", 2)
    ])`,
      (v) => JSON.stringify(JSON.parse(v)) === JSON.stringify([1024, 1800, 3600, 16384])],
    ["extractContent 带出完成原因与用量", `(() => {
      const r = extractContent({ choices: [{ finish_reason: "length", message: { content: "甲", reasoning_content: "思考" } }], usage: { completion_tokens: 512 } });
      return JSON.stringify({ finish: r.finishReason, tokens: r.completionTokens, reasoningLen: r.reasoning.length, text: r.text });
    })()`,
      (v) => { const o = JSON.parse(v); return o.finish === "length" && o.tokens === 512 && o.reasoningLen === 2 && o.text === "甲"; }],
    ["首次改写后不再弹提示块，但相似度始终在元信息行", `(() => {
      const orig = "本系统采用前后端分离架构，后端基于 Spring Boot 2.6.13 实现。";
      const out = "该平台采用前后端分离的实现方式，服务端以 Spring Boot 2.6.13 为核心。";
      reportQuality(orig, out);            // 先消耗掉"首次"机会
      const q = reportQuality(orig, out);  // 第二次：应不再出提示块
      originalText = orig; rewrittenText = out;
      setResultMeta(describeResult(q));
      return JSON.stringify({
        level: q.level, sim: q.sim,
        hintShown: document.getElementById("qualityHint").classList.contains("show"),
        meta: document.getElementById("resultMeta").textContent
      });
    })()`,
      (v) => {
        const o = JSON.parse(v);
        return o.level === "quiet" && !o.hintShown && typeof o.sim === "number" && /相似度 \d+%/.test(o.meta);
      }],
    ["非首次时丢技术信息不弹块，但元信息行会警示", `(() => {
      qualityReportedOnce = true;   // 模拟已经提示过一次
      const q = reportQuality("使用 Spring Boot 2.6.13 与表 exam_grade", "本系统采用后端框架，数据库中有成绩表");
      originalText = "原始文本"; rewrittenText = "改写文本";
      setResultMeta(describeResult(q));
      return JSON.stringify({
        shown: document.getElementById("qualityHint").classList.contains("show"),
        missing: q.missing,
        meta: document.getElementById("resultMeta").textContent
      });
    })()`,
      (v) => {
        const o = JSON.parse(v);
        return !o.shown && o.missing >= 3 && /丢失 \d+ 处技术信息/.test(o.meta);
      }],
    ["需要注意时才是贴合内容的小块（不通栏铺色）", `(() => {
      // 这条断言要在"首次"状态下验证，所以先复位标记
      qualityReportedOnce = false;
      reportQuality("使用 Spring Boot 2.6.13 与表 exam_grade", "本系统采用后端框架，数据库中有成绩表");
      const el = document.getElementById("qualityHint");
      const box = el.querySelector(".qh-item").getBoundingClientRect();
      const main = document.querySelector(".action-bar").getBoundingClientRect();
      return JSON.stringify({
        shown: el.classList.contains("show"),
        layout: getComputedStyle(el).display,
        narrower: box.width < main.width - 40
      });
    })()`,
      (v) => { const o = JSON.parse(v); return o.shown && o.layout === "flex" && o.narrower; }],
    ["只改写选中的片段（局部改写）", `(() => {
      const ta = document.getElementById("inputText");
      ta.value = "开头保持不变。这是需要改写的中间一段。结尾也保持不变。";
      ta.setSelectionRange(7, 19);   // 选中"这是需要改写的中间一段。"
      const scope = getSelectedScope();
      if (!scope) return JSON.stringify({ scope: null });
      rewriteScope = { start: scope.start, end: scope.end };
      rewrittenText = "此段已被改写";
      applyScope();
      return JSON.stringify({
        picked: scope.text,
        after: ta.value,
        cleared: rewriteScope === null
      });
    })()`,
      (v) => {
        const o = JSON.parse(v);
        return o.picked === "这是需要改写的中间一段。" &&
          o.after === "开头保持不变。此段已被改写结尾也保持不变。" &&
          o.cleared;
      }],
    ["选区太短或全选时按整篇处理", `(() => {
      const ta = document.getElementById("inputText");
      ta.value = "一整段文本内容";
      ta.setSelectionRange(0, 2);            // 太短
      const shortScope = getSelectedScope();
      ta.setSelectionRange(0, ta.value.length); // 全选
      const allScope = getSelectedScope();
      return JSON.stringify({ short: shortScope, all: allScope });
    })()`,
      (v) => JSON.parse(v).short === null && JSON.parse(v).all === null],
    ["自定义补充要求会进 prompt，清空后不残留", `(() => {
      const cur = loadSettings();
      cur.customInstruction = "保留所有专业术语";
      saveSettings(cur);
      const withExtra = buildMessages(STRATEGIES[currentStrategy], "测试文本", "");
      const cur2 = loadSettings();
      cur2.customInstruction = "";
      saveSettings(cur2);
      const without = buildMessages(STRATEGIES[currentStrategy], "测试文本", "");
      return JSON.stringify({
        has: withExtra[1].content.includes("保留所有专业术语"),
        missing: !without[1].content.includes("补充要求")
      });
    })()`,
      (v) => { const o = JSON.parse(v); return o.has && o.missing; }],
    ["配置导出不含 API Key", `(() => {
      const payload = buildConfigPayload();
      const dump = JSON.stringify(payload);
      return JSON.stringify({
        type: payload.type,
        models: Array.isArray(payload.settings.customModels),
        // 名字里带 Key 的字段（rememberKeys）不算，关键是别导出密钥本身
        noKey: !/"keys"\s*:/.test(dump) && !/"apiKey"/.test(dump) && !/sk-/.test(dump)
      });
    })()`,
      (v) => { const o = JSON.parse(v); return o.type === "reduce-aigc-config" && o.models && o.noKey; }],
    ["配置导入去重（同一地址+模型只加一次）", `(() => {
      const before = (loadSettings().customModels || []).length;
      const file = new File([JSON.stringify({
        type: "reduce-aigc-config",
        settings: {
          customModels: [
            { name: "A", url: "https://import.example.com/v1", modelId: "m1", auth: "bearer" },
            { name: "A 重复", url: "https://import.example.com/v1", modelId: "m1", auth: "bearer" },
            { name: "B", url: "https://import.example.com/v1", modelId: "m2", auth: "apikey", noThinking: true }
          ]
        }
      })], "c.json", { type: "application/json" });
      importConfig(file);
      const after = loadSettings().customModels || [];
      return new Promise((resolve) => setTimeout(() => {
        const cur = loadSettings().customModels || [];
        const imported = cur.filter((m) => m.url === "https://import.example.com/v1");
        resolve(JSON.stringify({
          added: cur.length - before,
          dedup: imported.length,
          auth: imported.some((m) => m.auth === "apikey"),
          noThinking: imported.some((m) => m.noThinking === true)
        }));
      }, 300));
    })()`,
      (v) => { const o = JSON.parse(v); return o.added === 2 && o.dedup === 2 && o.auth && o.noThinking; }],
    ["历史搜索能过滤，且按钮索引指向真实记录", `(() => {
      localStorage.removeItem("aigc_history");
      originalText = "关于人工智能伦理的讨论"; rewrittenText = "关于AI伦理的探讨";
      saveHistory();
      originalText = "数据库索引优化实践"; rewrittenText = "数据库索引调优做法";
      saveHistory();
      renderHistoryPanel();
      const allCount = document.getElementById("historyPanelList").querySelectorAll(".history-item").length;
      document.getElementById("historySearch").value = "数据库";
      renderHistoryPanel();
      const hit = document.getElementById("historyPanelList").querySelectorAll(".history-item").length;
      const firstBtn = document.getElementById("historyPanelList").querySelector(".history-item-actions button").getAttribute("onclick");
      document.getElementById("historySearch").value = "";
      renderHistoryPanel();
      return JSON.stringify({ all: allCount, hit, firstBtn });
    })()`,
      (v) => {
        const o = JSON.parse(v);
        return o.all === 2 && o.hit === 1 && /loadHistory\(0\)/.test(o.firstBtn);
      }],
    ["历史导出可用，saveSettings 会返回写入结果", `(() => {
      const wrote = saveSettings(Object.assign(loadSettings(), { customInstruction: "" }));
      return JSON.stringify({
        wrote: wrote === true,
        exportFn: typeof exportHistory === "function" && typeof loadHistory === "function"
      });
    })()`,
      (v) => { const o = JSON.parse(v); return o.wrote && o.exportFn; }],
    ["改写失败可复制错误详情、可重试", `JSON.stringify([typeof copyErrorDetail, typeof retryLast, typeof lastErrorText !== "undefined"])`,
      (v) => v === JSON.stringify(["function", "function", true])],
    ["设置面板分节顺序固定（模型表单里不该混进别的分节）", `(() => {
      const titles = [...document.querySelectorAll(".modal-body .section-title")].map(e => e.textContent.trim());
      return JSON.stringify(titles);
    })()`,
      (v) => JSON.stringify(JSON.parse(v)) === JSON.stringify(["API Key", "当前模型", "添加 / 管理模型", "补充说明", "用量", "配置"])],
    ["补充说明是块级多行输入框（不被压成窄条）", `(() => {
      const el = document.getElementById("customInstruction");
      const box = el.getBoundingClientRect();
      const body = el.closest(".modal-body").getBoundingClientRect();
      return JSON.stringify({ ratio: box.width / body.width, h: Math.round(box.height) });
    })()`,
      (v) => { const o = JSON.parse(v); return o.ratio > 0.85 && o.h >= 60; }],
    ["流式解析：逐块拼出正文", `(async () => {
      const frames = [
        'data: {"choices":[{"delta":{"content":"第一"}}]}\\n\\n',
        'data: {"choices":[{"delta":{"content":"段文字"}}]}\\n\\n',
        'data: [DONE]\\n\\n'
      ];
      const stream = new ReadableStream({
        start(c) { const enc = new TextEncoder(); for (const f of frames) c.enqueue(enc.encode(f)); c.close(); }
      });
      const orig = window.fetch;
      window.fetch = async () => new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      try {
        const cm = { id: "s", name: "流式模型", url: "https://x.example.com/v1", modelId: "m", auth: "bearer" };
        const r = await doRewriteStream("k", cm, "短原文", "");
        return JSON.stringify({ success: r.success, text: r.text || "", err: r.error || "" });
      } finally { window.fetch = orig; }
    })()`,
      (v) => { const o = JSON.parse(v); return o.success === true && o.text === "第一段文字"; }],
    ["流式解析：只回思考内容时给出可操作报错", `(async () => {
      const frames = [
        'data: {"choices":[{"delta":{"reasoning_content":"我在想很久"}}]}\\n\\n',
        'data: [DONE]\\n\\n'
      ];
      const stream = new ReadableStream({
        start(c) { const enc = new TextEncoder(); for (const f of frames) c.enqueue(enc.encode(f)); c.close(); }
      });
      const orig = window.fetch;
      window.fetch = async () => new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      try {
        const cm = { id: "s2", name: "推理模型", url: "https://x.example.com/v1", modelId: "r1", auth: "bearer" };
        const r = await doRewriteStream("k", cm, "短原文", "");
        return JSON.stringify({ success: r.success, err: r.error || "" });
      } finally { window.fetch = orig; }
    })()`,
      (v) => { const o = JSON.parse(v); return o.success === false && /思考内容/.test(o.err) && /关闭思考模式/.test(o.err); }],
    ["流式解析：上游忽略 stream 参数时回退非流式", `(async () => {
      const orig = window.fetch;
      window.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } });
      try {
        const cm = { id: "s3", name: "普通模型", url: "https://x.example.com/v1", modelId: "m", auth: "bearer" };
        const r = await doRewriteStream("k", cm, "短原文", "");
        return JSON.stringify({ unsupported: r.unsupported === true });
      } finally { window.fetch = orig; }
    })()`,
      (v) => JSON.parse(v).unsupported === true],
    ["流式解析：上游报错时把原始错误带出来", `(async () => {
      const orig = window.fetch;
      window.fetch = async () => new Response(JSON.stringify({ error: { message: "上游额度不足" } }),
        { status: 402, headers: { "Content-Type": "application/json" } });
      try {
        const cm = { id: "s4", name: "普通模型", url: "https://x.example.com/v1", modelId: "m", auth: "bearer" };
        const r = await doRewriteStream("k", cm, "短原文", "");
        return JSON.stringify({ success: r.success, err: r.error || "" });
      } finally { window.fetch = orig; }
    })()`,
      (v) => { const o = JSON.parse(v); return o.success === false && o.err.includes("上游额度不足"); }],
    ["用量统计累计次数与字数（不猜价格）", `(() => {
      localStorage.removeItem("aigc_usage");
      addUsage(100, 120, { prompt_tokens: 200, completion_tokens: 150 });
      addUsage(50, 60, null);
      const u = getUsage();
      renderUsage();
      return JSON.stringify({
        requests: u.requests, inputChars: u.inputChars, outputChars: u.outputChars,
        promptTokens: u.promptTokens, completionTokens: u.completionTokens,
        shown: document.getElementById("usageStat").textContent
      });
    })()`,
      (v) => {
        const o = JSON.parse(v);
        return o.requests === 2 && o.inputChars === 150 && o.outputChars === 180 &&
          o.promptTokens === 200 && o.completionTokens === 150 &&
          /2/.test(o.shown) && /150/.test(o.shown);
      }],
    ["对比视图「改这句」能在输入区选中原文句", `(() => {
      // 先关掉可能还开着的面板：面板打开时主区是 inert，focus() 不会生效
      for (const [id, cls] of [["modalOverlay", "open"], ["historyOverlay", "show"], ["detectOverlay", "show"], ["announceOverlay", "show"]]) {
        document.getElementById(id).classList.remove(cls);
      }
      syncBackgroundInert();
      const orig = "第一句保持不变。第二句需要重新处理。第三句也保持不变。";
      setInputText(orig);
      locateSentence("第二句需要重新处理。");
      const ta = document.getElementById("inputText");
      return JSON.stringify({
        selected: ta.value.slice(ta.selectionStart, ta.selectionEnd),
        focusOk: document.activeElement === ta
      });
    })()`,
      (v) => { const o = JSON.parse(v); return o.selected === "第二句需要重新处理。" && o.focusOk; }],
    ["多文件拖入会按顺序合并", `(async () => {
      const f1 = new File(["第一部分内容。"], "a.txt", { type: "text/plain" });
      const f2 = new File(["第二部分内容。"], "b.txt", { type: "text/plain" });
      await handleFile([f1, f2]);
      const val = document.getElementById("inputText").value;
      return JSON.stringify({ value: val, hint: document.getElementById("uploadHint").textContent });
    })()`,
      (v) => {
        const o = JSON.parse(v);
        return o.value.includes("第一部分内容。") && o.value.includes("第二部分内容。") &&
          o.value.indexOf("第一部分") < o.value.indexOf("第二部分") &&
          o.hint.includes("已合并 2 个文件");
      }],
    ["单文件路径仍可用（不与合并逻辑冲突）", `(async () => {
      const f = new File(["单独一个文件的内容。"], "solo.txt", { type: "text/plain" });
      await handleFile(f);
      return JSON.stringify({ value: document.getElementById("inputText").value, hint: document.getElementById("uploadHint").textContent });
    })()`,
      (v) => { const o = JSON.parse(v); return o.value === "单独一个文件的内容。" && o.hint.includes("solo.txt"); }],
    ["面板打开时背景被 inert，关闭后恢复", `(() => {
      const main = document.querySelector(".main");
      const header = document.querySelector(".header");
      openSettings();
      const opened = { main: main.inert === true, header: header.inert === true, aria: main.getAttribute("aria-hidden"), lock: document.body.classList.contains("panel-open") };
      closeSettings({ target: document.getElementById("modalOverlay") });
      const closed = { main: main.inert === false, aria: main.getAttribute("aria-hidden"), lock: document.body.classList.contains("panel-open") };
      return JSON.stringify({ opened, closed });
    })()`,
      (v) => {
        const o = JSON.parse(v);
        return o.opened.main && o.opened.header && o.opened.aria === "true" && o.opened.lock &&
          o.closed.main && o.closed.aria === null && o.closed.lock === false;
      }],
    ["关闭面板后焦点回到打开它的按钮", `(async () => {
      // openPanel 的聚焦是延时的：不要等固定毫秒（CI 上会不够），改为轮询到条件成立
      const until = async (fn, ms = 3000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 40)); }
        return false;
      };
      const btn = document.getElementById("pickFileBtn");
      btn.focus();
      openHistory();
      const inside = await until(() => document.querySelector(".history-panel").contains(document.activeElement));
      const back = await until(() => { closeHistory({ target: document.getElementById("historyOverlay") }); return document.activeElement === btn; }, 2000);
      return JSON.stringify({ focusedInside: inside, backToTrigger: back });
    })()`,
      (v) => { const o = JSON.parse(v); return o.focusedInside && o.backToTrigger; }],
    ["轻提示不参与 inert（aria-live 要能被播报）", `(() => {
      openSettings();
      const toast = document.getElementById("toast");
      const r = { toastInert: toast.inert === true, toastAria: toast.getAttribute("aria-hidden") };
      closeSettings({ target: document.getElementById("modalOverlay") });
      return JSON.stringify(r);
    })()`,
      (v) => { const o = JSON.parse(v); return o.toastInert === false && o.toastAria === null; }],
    ["打印样式只输出结果栏", `(() => {
      const css = [...document.querySelectorAll("style")].map((el) => el.textContent).join("\\n");
      const block = (css.match(/@media print \\{[\\s\\S]*?\\n  \\}/) || [""])[0];
      return JSON.stringify({
        hasPrint: /@media print/.test(css),
        hidesInputCard: /#inputCard\\s*\\{[^}]*display:\\s*none/.test(block),
        hidesHeader: /\\.header/.test(block),
        resetsHeight: /min-height:\\s*0\\s*!important/.test(block)
      });
    })()`,
      (v) => {
        const o = JSON.parse(v);
        return o.hasPrint && o.hidesInputCard && o.hidesHeader && o.resetsHeight;
      }],
    ["触屏断点已定义（控件放大到可点）", `(() => {
      // 页面上可能出现多个 style（例如导出模板被解析成真元素），全部拼接再查
      const css = [...document.querySelectorAll("style")].map((el) => el.textContent).join("\\n");
      return JSON.stringify({
        styles: document.querySelectorAll("style").length,
        hasCoarse: /@media\\s*\\(pointer:\\s*coarse\\)/.test(css),
        minHeight: /\\.btn-sm\\s*\\{[^}]*min-height:\\s*36px/.test(css)
      });
    })()`,
      (v) => { const o = JSON.parse(v); return o.hasCoarse && o.minHeight; }],
    ["关键文字对比度达 WCAG AA（真实渲染取样）", `(() => {
      // 直接量渲染结果：前景色 + 向上合成出的有效背景（含玻璃面板的半透明层）
      const parseC = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
        const p = m[1].split(",").map((x) => parseFloat(x.trim()));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
      const over = (f, b) => ({ r: f.r*f.a + b.r*(1-f.a), g: f.g*f.a + b.g*(1-f.a), b: f.b*f.a + b.b*(1-f.a), a: 1 });
      const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
        return 0.2126*f(c.r) + 0.7152*f(c.g) + 0.0722*f(c.b); };
      const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
      const effBg = (el) => {
        const stack = []; let node = el;
        while (node && node.nodeType === 1) {
          const bg = parseC(getComputedStyle(node).backgroundColor);
          if (bg && bg.a > 0) stack.push(bg);
          if (bg && bg.a === 1) break;
          node = node.parentElement;
        }
        let acc = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = stack.length - 1; i >= 0; i--) acc = over(stack[i], acc);
        return acc;
      };
      const sels = [".panel-title", ".char-count", ".foot-note", ".tools-note", ".strategy-label",
        ".strategy-desc", ".action-tip", ".header-info", ".history-item-orig", ".section-title",
        ".cmp-left", "#outputArea", "#inputText", ".btn-rewrite", ".notice-bar", ".qh-warn", ".qh-bad",
        ".cmp-add", ".cmp-remove", ".custom-model-item span"];
      const bad = [];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const cs = getComputedStyle(el);
        const fg = parseC(cs.color), bg = effBg(el);
        const size = parseFloat(cs.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
        const need = large ? 3.0 : 4.5;
        const r = ratio(fg, bg);
        if (r < need) bad.push(sel + "=" + r.toFixed(2) + ":1(需" + need + ")");
      }
      return JSON.stringify(bad);
    })()`,
      (v) => JSON.parse(v).length === 0],

    ["深色主题的文字令牌对最苛刻背景也达标", `(() => {
      // 直接遍历 CSSOM 找 @media (prefers-color-scheme: dark) 里的 :root 变量
      const vars = {};
      const collect = (rules) => {
        for (const r of rules) {
          const isDark = (r.conditionText || "").indexOf("prefers-color-scheme: dark") >= 0;
          if (isDark && r.cssRules) {
            for (const inner of r.cssRules) {
              if (!inner.selectorText || inner.selectorText.indexOf(":root") < 0 || !inner.style) continue;
              for (let i = 0; i < inner.style.length; i++) {
                const name = inner.style[i];
                if (name.indexOf("--") === 0) vars[name] = inner.style.getPropertyValue(name).trim();
              }
            }
            continue;
          }
          if (r.cssRules) collect(r.cssRules);
        }
      };
      for (const sheet of document.styleSheets) {
        try { collect(sheet.cssRules); } catch (e) { /* 跨域样式表跳过 */ }
      }

      const parseC = (h) => { const x = h.replace("#", "");
        return { r: parseInt(x.slice(0,2),16), g: parseInt(x.slice(2,4),16), b: parseInt(x.slice(4,6),16) }; };
      const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
        return 0.2126*f(c.r) + 0.7152*f(c.g) + 0.0722*f(c.b); };
      const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };

      // 深色下最苛刻的三种底：玻璃合成 #1c2027、卡片 #191c22、页面 #101216
      const bgs = ["#1c2027", "#191c22", "#101216"];
      const names = ["--text", "--text-secondary", "--text-tertiary", "--danger-text", "--warning-text", "--success-text"];
      const bad = [];
      for (const name of names) {
        const val = vars[name];
        if (!val || val.indexOf("#") !== 0) { bad.push(name + "=缺失"); continue; }
        for (const bg of bgs) {
          const r = ratio(parseC(val), parseC(bg));
          if (r < 4.5) bad.push(name + " on " + bg + " = " + r.toFixed(2));
        }
      }
      return JSON.stringify(bad);
    })()`,
      (v) => JSON.parse(v).length === 0],

    ["加/删模型后状态栏立即同步（曾漏掉刷新）", `(() => {
      const info = () => document.getElementById("headerInfo").textContent.trim();
      if (!getActiveKey()) {
        document.getElementById("newKeyName").value = "状态栏用例 Key";
        document.getElementById("newKeyValue").value = "sk-statusbar";
        addApiKey();
      }
      const s = loadSettings();
      s.customModels = [];
      s.model = null;
      saveSettings(s);
      renderCustomModels();
      updateHeaderInfo();
      const emptyText = info();

      document.getElementById("cmName").value = "状态栏用例模型";
      document.getElementById("cmUrl").value = "https://hdr.example.com/v1/chat/completions";
      document.getElementById("cmId").value = "m-statusbar";
      addCustomModel();
      const addedText = info();
      return JSON.stringify({ emptyText, addedText });
    })()`,
      (v) => { const o = JSON.parse(v); return /未配置/.test(o.emptyText) && !/未配置/.test(o.addedText); }],

    ["流式未收到结束标记时标记为可能截断", `(async () => {
      const frames = [
        'data: {"choices":[{"delta":{"content":"只有一半"}}]}\\n\\n'
        // 故意不发 [DONE]，也不给 finish_reason —— 模拟上游中途断开
      ];
      const stream = new ReadableStream({
        start(c) { const enc = new TextEncoder(); for (const f of frames) c.enqueue(enc.encode(f)); c.close(); }
      });
      const orig = window.fetch;
      window.fetch = async () => new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      try {
        const cm = { id: "t1", name: "截断测试", url: "https://x.example.com/v1", modelId: "m", auth: "bearer" };
        const r = await doRewriteStream("k", cm, "短原文", "");
        return JSON.stringify({ success: r.success, truncated: r.truncated === true, text: r.text || "" });
      } finally { window.fetch = orig; }
    })()`,
      (v) => { const o = JSON.parse(v); return o.success === true && o.truncated === true; }],

    ["流式带 [DONE] 时不标记截断", `(async () => {
      const frames = [
        'data: {"choices":[{"delta":{"content":"完整结果"}}]}\\n\\n',
        'data: [DONE]\\n\\n'
      ];
      const stream = new ReadableStream({
        start(c) { const enc = new TextEncoder(); for (const f of frames) c.enqueue(enc.encode(f)); c.close(); }
      });
      const orig = window.fetch;
      window.fetch = async () => new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      try {
        const cm = { id: "t2", name: "完整测试", url: "https://x.example.com/v1", modelId: "m", auth: "bearer" };
        const r = await doRewriteStream("k", cm, "短原文", "");
        return JSON.stringify({ success: r.success, truncated: r.truncated === true });
      } finally { window.fetch = orig; }
    })()`,
      (v) => { const o = JSON.parse(v); return o.success === true && o.truncated === false; }],

    ["上游结构不符时给出精准诊断（而不是含糊的「返回为空」）", `(async () => {
      const orig = window.fetch;
      window.fetch = async () => new Response(JSON.stringify({ foo: "bar" }),
        { status: 200, headers: { "Content-Type": "application/json" } });
      try {
        const s = loadSettings();
        const r = await doRewrite("k", s, "短原文", false, "");
        return JSON.stringify({ success: r.success, err: r.error || "" });
      } finally { window.fetch = orig; }
    })()`,
      (v) => { const o = JSON.parse(v); return o.success === false && /choices/.test(o.err) && /地址/.test(o.err); }],

    ["另一标签页改了 Key 时本页会同步刷新", `(() => {
      // storage 事件在真实场景由其他标签页触发；这里手动派发来验证同步逻辑
      const fire = (key) => window.dispatchEvent(new StorageEvent("storage", { key }));
      // 先让本页显示"未配置"，再模拟另一页写入了 Key
      const s = loadSettings();
      const keys = loadKeys();
      keys.push({ id: "k_sync", name: "另一页的 Key", key: "sk-sync-1234567890" });
      s.activeKeyId = "k_sync";
      localStorage.setItem("aigc_keys", JSON.stringify(keys));
      localStorage.setItem("aigc_settings", JSON.stringify(s));
      const before = document.getElementById("headerInfo").textContent;
      fire("aigc_keys");
      fire("aigc_settings");
      const after = document.getElementById("headerInfo").textContent;
      return JSON.stringify({ before: before.slice(0, 30), after: after.slice(0, 30) });
    })()`,
      (v) => { const o = JSON.parse(v); return /另一页的 Key/.test(o.after); }],

    ["另一标签页改了模型列表时本页下拉会更新", `(() => {
      const s = loadSettings();
      s.customModels = [{ id: "cm_sync", name: "另一页加的模型", url: "https://sync.example.com/v1", modelId: "sync-m", auth: "bearer" }];
      s.model = "cm_sync";
      localStorage.setItem("aigc_settings", JSON.stringify(s));
      window.dispatchEvent(new StorageEvent("storage", { key: "aigc_settings" }));
      const sel = document.getElementById("modelSelect");
      return JSON.stringify({
        options: [...sel.options].map((o) => o.textContent),
        header: document.getElementById("headerInfo").textContent.slice(0, 30)
      });
    })()`,
      (v) => { const o = JSON.parse(v); return o.options.includes("另一页加的模型") && !/未配置/.test(o.header); }],

    ["无关的存储键不会触发刷新（不做多余渲染）", `(() => {
      let touched = false;
      const orig = window.renderCustomModels;
      window.renderCustomModels = function () { touched = true; return orig.apply(this, arguments); };
      window.dispatchEvent(new StorageEvent("storage", { key: "some-unrelated-key" }));
      const result = touched;
      window.renderCustomModels = orig;
      return String(result);
    })()`,
      (v) => v === "false"],

    ["超长无标点单句会被硬切（不会把整句塞进一次请求）", `(() => {
      const long = "a".repeat(1200);
      const chunks = splitIntoChunks(long, 500);
      return JSON.stringify({ count: chunks.length, max: Math.max(...chunks.map((c) => c.length)) });
    })()`,
      (v) => { const o = JSON.parse(v); return o.count >= 3 && o.max <= 500; }],

    ["纯英文长文按词切且 diff 正常", `(() => {
      const a = "The quick brown fox jumps over the lazy dog and then runs away quickly.";
      const b = "A quick brown fox leaps over a lazy dog and then runs away fast.";
      const tokens = tokenize(a);
      const [left, right] = diffWords(a, b);
      return JSON.stringify({
        tokens: tokens.length,
        firstToken: tokens[0],
        marked: left.indexOf("cmp-remove") >= 0 || right.indexOf("cmp-add") >= 0
      });
    })()`,
      (v) => { const o = JSON.parse(v); return o.tokens >= 12 && o.firstToken === "The" && o.marked; }],

    ["Markdown 表格与代码块不会导致分段异常", `(() => {
      const md = "| 项目 | 数值 |\\n| --- | --- |\\n| A | 1 |\\n| B | 2 |\\n\\n\`\`\`js\\nconst x = 1;\\n\`\`\`";
      const chunks = splitIntoChunks(md, 500);
      const tech = extractTechnicalTokens("见 \`exam_grade\` 表与 2.6.13 版本");
      return JSON.stringify({
        chunks: chunks.length,
        joined: chunks.join("").length,
        tech: tech.sort()
      });
    })()`,
      (v) => {
        const o = JSON.parse(v);
        return o.chunks >= 1 && o.joined > 20 && o.tech.indexOf("exam_grade") >= 0 && o.tech.indexOf("2.6.13") >= 0;
      }],

    ["emoji 与代理对不会被切坏", `(() => {
      const tokens = tokenize("测试🎉emoji😀混排");
      return JSON.stringify({
        tokens: tokens,
        emojiIntact: tokens.indexOf("🎉") >= 0 && tokens.indexOf("😀") >= 0
      });
    })()`,
      (v) => JSON.parse(v).emojiIntact === true],

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
      (v) => JSON.stringify(v) === JSON.stringify([3600, 2800, 16384])],
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
  recordCount("npm run test:ui", results.length);
  if (failed.length) {
    console.log("失败项：");
    for (const f of failed) console.log("  - " + f.name);
  }
  await killAll(failed.length ? 1 : 0);
} catch (err) {
  console.error("验证过程异常: " + err.message);
  await killAll(1);
}
