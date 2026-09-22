const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3456);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const MAX_BODY = 300 * 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https://raw.githubusercontent.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const STATIC_ROUTES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/announcement.json": ["announcement.json", "application/json; charset=utf-8"],
};

let handlerModule = null;
async function getHandler() {
  if (!handlerModule) handlerModule = await import("./functions/_lib/rewrite-handler.mjs");
  return handlerModule;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("请求体过大"), { code: "TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function toHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return headers;
}

async function sendWebResponse(res, webResp) {
  const out = {};
  webResp.headers.forEach((value, key) => { out[key] = value; });
  res.writeHead(webResp.status, out);
  const buf = Buffer.from(await webResp.arrayBuffer());
  res.end(buf);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function serveStatic(res, urlPath) {
  const route = STATIC_ROUTES[urlPath];
  if (!route) return false;
  const [file, contentType] = route;
  try {
    const content = fs.readFileSync(path.join(ROOT, file));
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === "/api/rewrite" || url.pathname === "/api/health") {
    let body = Buffer.alloc(0);
    if (req.method !== "GET" && req.method !== "HEAD") {
      try {
        body = await readBody(req);
      } catch (err) {
        return sendJson(res, 413, { error: err.message });
      }
    }

    const init = { method: req.method, headers: toHeaders(req.headers) };
    if (body.length) init.body = body;

    try {
      const { handleRewrite } = await getHandler();
      const webResp = await handleRewrite(new Request(url.toString(), init), process.env);
      await sendWebResponse(res, webResp);
    } catch (err) {
      sendJson(res, 500, { error: "本地代理异常: " + err.message });
    }
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    if (serveStatic(res, url.pathname)) return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

server.listen(PORT, HOST, () => {
  console.log(`AIGC 降重工具已启动: http://${HOST}:${PORT}`);
  console.log(`健康检查: http://${HOST}:${PORT}/api/health`);
  console.log(`改写接口: POST http://${HOST}:${PORT}/api/rewrite`);
  if (!process.env.ALLOWED_ORIGINS) {
    console.log("提示: 未设置 ALLOWED_ORIGINS，仅放行同源与本地环回请求。");
  }
  if (!process.env.ALLOW_PRIVATE_UPSTREAM) {
    console.log("提示: 未开启 ALLOW_PRIVATE_UPSTREAM，请求内网/本机模型地址会被拒绝（连 Ollama 等需设为 1）。");
  }
});
