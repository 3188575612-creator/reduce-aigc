# AIGC 降重工具

降低论文 AIGC 检测率的文本改写工具。通过 DeepSeek API 对论文段落进行"去 AI 化"改写。

## 快速部署（Vercel）

1. 安装 Vercel CLI：`npm i -g vercel`
2. 在项目目录运行：`vercel`
3. 按提示完成部署，得到一个公网链接
4. 把链接发给用户，打开即用

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
