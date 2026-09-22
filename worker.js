import { handleRewrite } from "./functions/_lib/rewrite-handler.mjs";

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
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/rewrite" || url.pathname === "/api/health") {
      return handleRewrite(request, env);
    }

    const resp = await env.ASSETS.fetch(request);
    const headers = new Headers(resp.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers,
    });
  },
};
