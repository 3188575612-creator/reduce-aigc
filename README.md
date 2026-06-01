# AIGC 降重工具

降低论文 AIGC 检测率的文本改写工具。通过 DeepSeek API 对论文段落进行"去 AI 化"改写。

## 快速部署（Cloudflare Pages）

1. 打开 [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → Create → Pages → Connect to Git
2. 授权 GitHub，选择 `reduce-aigc` 仓库
3. Build settings 保持默认（无需构建命令），直接点 Deploy
4. 得到一个 `xxx.pages.dev` 链接，发给用户即用

> Cloudflare Pages 每天 10 万次免费请求，足够使用。

## 本地开发

```bash
npm start
# 浏览器打开 http://localhost:3456
```

## 使用

1. 获取 [DeepSeek API Key](https://platform.deepseek.com/)
2. 打开工具页面，填入 API Key（仅存浏览器本地）
3. 粘贴论文段落，选择改写策略，点击"开始改写"
4. 复制或下载结果
