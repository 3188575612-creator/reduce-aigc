# AIGC 降重工具

把论文段落交给大模型做"去 AI 化"改写，用于降低 AIGC 检测率。

线上：https://reduce-aigc.pages.dev/ 　（部署状态随时可用 `GET /api/health` 确认版本）

> ⚠️ 文本与你的 API Key 会经由本服务转发给第三方大模型 API。改写结果仅供写作参考，请遵守所在机构关于 AI 使用的规定，不要用本工具规避学术诚信要求。

## 架构

单一代理实现，三个入口共用：

| 文件 | 角色 |
|---|---|
| `index.html` | 全部前端（无框架、无构建）。策略、分段改写、历史、对比、自查 |
| `functions/_lib/rewrite-handler.mjs` | **唯一**的代理核心：模型路由、鉴权、超时、重试、流式、限流、CORS |
| `functions/api/rewrite.js` | Cloudflare Pages Functions 入口（`/api/rewrite`） |
| `functions/api/health.js` | 健康检查（`/api/health`） |
| `worker.js` | Cloudflare Workers 入口 + 静态资源安全响应头 |
| `server.js` | 本地开发服务器，复用同一代理核心 |

> `functions/_lib/` 以 `_` 开头，Pages 不会把它当成路由。
> 改代理行为只需改 `functions/_lib/rewrite-handler.mjs`，三个入口都只是薄封装。

## 部署

### 方式一：Cloudflare Pages（当前线上用的就是这条）

1. 把仓库推到 GitHub（**注意**：git 若被 `url.*.insteadOf` 重写到镜像站，镜像站证书异常时会全部失败，见下方"已知环境问题"）
2. Cloudflare 控制台 → Workers & Pages → 选该项目 → 触发一次重新部署（Git 集成项目每次 push 会自动构建）
3. Build command 留空，Build output directory 填 `/`
4. 部署后打开 `/api/health`，确认版本号

> Git 集成型 Pages 项目**不能**再用 `wrangler pages deploy` 直传，二者互斥。

### 方式二：Cloudflare Workers（不依赖 GitHub）

```bash
npx wrangler login     # 需要你本人授权
npx wrangler deploy
```

配置见 `wrangler.jsonc`（`main` = `worker.js`，`assets.directory` = 仓库根目录）。
`.assetsignore` 决定哪些文件不会被当作静态资源上传（`.git`、`functions/`、`scripts/`、`server.js` 等已排除）。
本地可先验证打包而不发布：

```bash
npx wrangler deploy --dry-run
```

### 可选环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ALLOWED_ORIGINS` | 空 | 逗号分隔的跨域白名单。留空时只放行同源与本地环回请求 |
| `RATE_LIMIT_PER_MIN` | 30 | 单 IP 每分钟请求上限（按 isolate 内存计数，尽力而为） |
| `UPSTREAM_TIMEOUT_MS` | 25000 | 上游请求超时 |

## 本地开发

```bash
npm start          # http://127.0.0.1:3456（默认只监听本机；HOST=0.0.0.0 可放开）
```

## 验证

| 命令 | 覆盖范围 |
|---|---|
| `npm test` | 代理层回归自测：本地 mock 上游，32 项断言（鉴权、超时、重试、流式、限流、CORS、参数夹取、SSE） |
| `npm run test:e2e` | 端到端：真起 `server.js` + mock 上游，用 HTTP 打全链路（含 model 透传、静态路由、CSP、404） |
| `npm run test:ui` | 无头 Edge + CDP：在真实页面上下文断言分段、max_tokens、历史全文、Key 存储等 21 项，并抓运行时异常 |
| `npm run test:all` | 依次跑以上三项 |

三个测试都不需要真实 API Key。

## 使用

1. 打开页面 → ⚙ → 添加 API Key（只存在你自己的浏览器里）
2. 粘贴段落或拖入 `.docx` / `.txt`
3. 选策略（结构 / 风格）与强度（普通 / 重度）→ 开始改写
4. 超过 2000 字会自动分段（每段约 500 字，段间带上文保持指代一致）

## 支持的模型

| 选项 | 上游 | 已核对的约束 |
|---|---|---|
| DeepSeek V4 Pro / Flash | api.deepseek.com | 温度 0–2 |
| GLM-4.7 | open.bigmodel.cn | 温度上限按 1.0 处理；输出上限 8192；显式关闭思考模式 |
| Qwen-Turbo / Qwen-Plus | dashscope.aliyuncs.com | 输出上限 4096 |
| Xiaomi MiMo（mimo-v2.5-pro）| api.xiaomimimo.com | `api-key` 鉴权；温度上限 1.5；显式关闭思考模式 |

端点、模型 ID 与鉴权方式均已对照各厂商官方文档核对。GLM-4.7 与 MiMo **默认会开启思考模式**，
推理 token 会挤占 `max_tokens`、导致正文返回为空或过短，因此代理里显式传了
`thinking: { type: "disabled" }`（改写是风格转换，不需要长链推理）。若某模型的该参数不被接受，
删掉 `MODEL_ENDPOINTS` 里对应的 `extraBody` 即可。

也可在设置里添加自定义模型：填名称、**完整** API 地址、模型 ID。地址必须为 https（本机环回可用 http）；
只填到 `/v1` 会自动补 `/chat/completions`。自定义模型不套用上面的预置约束。

## 安全与隐私

- API Key 仅存放在浏览器（默认 localStorage；可在设置里改成仅本次会话，关闭浏览器即清除）
- 但每次请求都会把你的 Key 与文本经本代理转发给上游 —— **不要使用你不信任的第三方部署**
- 跨站请求默认拒绝；若自建且需要被其它域调用，用 `ALLOWED_ORIGINS` 显式放行
- "AI 痕迹自查"是让模型给自己打分，**不是**权威查重/AIGC 检测，分数会偏乐观

## 已知环境问题（本机）

- 全局 git 配置存在 `url.https://kkgithub.com/.insteadof = https://github.com/`，
  该镜像站当前 TLS 证书校验失败（`SEC_E_WRONG_PRINCIPAL`），**所有走 github.com 的 git 操作都会失败**。
  实测直连 `github.com` 正常，临时绕过（不改全局配置）：

  ```bash
  GIT_CONFIG_GLOBAL=/dev/null git push https://github.com/<用户>/<仓库>.git main
  ```

- 本机 `gh` 已安装但**未登录**，HTTPS 与 SSH（`~/.ssh/id_ed25519` 未注册）都无可用凭据，
  推送前需先 `gh auth login` 或配置 PAT。
- `raw.githubusercontent.com` 在本机不可达，故公告改为**同源优先**（`/announcement.json`）。

## 变更记录

### 2.1.0
- 按官方文档核对四个上游的端点、模型 ID、鉴权头与参数上限
- GLM-4.7：`max_tokens` 上限 4096 → 8192（官方最大输出 128K，原上限会截断长段结果）
- GLM-4.7 / MiMo 显式关闭思考模式，避免推理 token 挤占正文；MiMo 温度上限按官方压到 1.5
- 参数逻辑拆成可测纯函数（`resolveTarget` / `applyModelLimits` / `buildRequestBody`），自测增至 47 项
- 公告支持多条（`items` 数组），并在本地补齐 `announcement.json`（此前指向不存在的文件）
- 首次访问增加一次隐私与学术规范提示条，可关闭并记住

### 2.0.0
- 代理核心抽成单一实现，Pages / Workers / 本地三处不再漂移（此前 Workers 版缺失超时、重试、流式与自定义模型支持）
- 安全：移除 `Access-Control-Allow-Origin: *`，改为同源 + 白名单；新增按 IP 限流、请求体大小与文本长度上限、上游地址协议校验、静态资源 CSP
- 修复：`server.js` 不再硬编码模型、历史记录不再截断原文前 200 字、`renderHeader` 未定义导致的初始化报错、AI 检测忽略自定义模型
- 体验：分段改写按句切分并带上文、去掉逐段重复的打字动画、打字动画总时长封顶、超长句不再卡死对比视图、公告改为同源优先、新增代理健康检查
- 新增 `npm test` 回归自测
