# 📚 English Vocab Learning — 英语词汇学习助手

一个功能全面的英语学习 Web 应用，集成 AI 大模型与多种 TTS 语音引擎，覆盖单词查询、卡片学习、拼写练习、语境学词、文章陪读、翻译批改、作文批改、好句背诵等全场景学习流程。

## ✨ 核心功能

### 🔍 单词查询
- 输入英文单词，AI 自动生成完整学习内容：释义、音标、例句、例句翻译、近义词、反义词、搭配、词根词缀、派生词、难度等级
- 支持多种 AI 服务商（智谱免费、DeepSeek、OpenAI、Moonshot、Groq、豆包、自定义）

### 📝 单词管理
- 手动添加 / 批量导入 / 剪贴板粘贴
- 支持 Tab 分隔、逗号分隔、空格分隔等多种格式
- 自动识别词性（n. / v. / adj. / adv. 等）
- 短语导入支持
- 批量 AI 生成学习内容
- 导出 / 导入数据备份

### 🎴 单词卡片（Learn）
- 正面英文 + 音标，背面中文释义 + 例句
- 翻转卡片、左右滑动切换
- 键盘快捷键：← → 切换，空格/回车翻转
- 自动朗读单词、释义、例句
- 熟词管理，播放完成后自动推进

### ✏️ 拼写练习（Spell）
- 中文提示，输入英文拼写
- 自动判错，统计正确率、用时、每题平均耗时
- 进度条，错词重做

### 📝 看英选中（Quiz）
- 英文单词展示，四选一中文释义
- 统计正确率、用时，错词重做

### 📖 文章陪读
- 粘贴英文文章，AI 自动解析标题和段落
- 点击单词弹出词义、音标、派生词
- 选中句子/短语弹出翻译，可保存到好句背诵
- 支持有题目模式（阅读理解）
- 文章云端保存与同步

### 🌐 语境学词（Context）
- 选择最多 10 个单词，AI 生成包含这些词的短文
- 点击文中词汇查看释义
- 显示文中词汇汇总表

### 🔊 文章朗读
- 粘贴英文文章，AI 生成音频
- 播放 / 暂停 / 继续 / 停止
- 语速调节（0.5x ~ 1.5x）
- 下载音频、云端保存

### 🔤 翻译练习
- AI 自动生成翻译题目（含参考译文和重难点）
- 翻译批改：得分、错误标注、AI 范文、修改后范文

### ✍️ 作文练习
- 输入题目和英文作文，AI 评分批改
- 错误标注、范文生成、修改建议

### 📊 批改记录
- 翻译和作文批改历史记录
- 查看、导出 PDF、删除、清空

### 📖 好句背诵
- 添加英文句子 + 中文翻译 + 来源 + 分类（口语/作文）
- AI 辅助翻译和自动分类
- 背诵练习，多选导出 PDF

## 🎤 TTS 语音引擎

| 服务商 | 状态 | 说明 |
|--------|------|------|
| 浏览器内置 | 免费 | 使用 Web Speech API，无需配置 |
| 小米 MIMO ✨ | 免费代理 | 通过 Supabase Edge Function 代理，无需配置 Key |
| 火山引擎 | 需 Key | 60+ 中文音色，支持新旧版控制台 |
| MiniMax | 需 Key | 8 种英文音色，HD/Turbo 模型 |
| OpenAI TTS | 需 Key | 6 种音色，tts-1 / tts-1-hd |

## 🤖 AI 服务商

| 服务商 | 模型 | 说明 |
|--------|------|------|
| 智谱免费（GLM） | glm-4-flash | 免费代理，无需 Key |
| DeepSeek | deepseek-v4-pro / flash | 需 API Key |
| OpenAI | gpt-4o / gpt-4o-mini / gpt-4-turbo / gpt-3.5-turbo | 需 API Key |
| Moonshot | moonshot-v1-8k/32k/128k | 需 API Key |
| Groq | llama-3.3-70b / mixtral-8x7b / gemma2-9b | 需 API Key |
| 智谱 AI | glm-4-flash / plus / air | 需 API Key |
| 豆包 | doubao-pro-32k/128k / doubao-lite-32k | 需 API Key |
| 自定义 | 自定义模型名 | 支持自定义 API 地址 |

## ☁️ 云端同步

- 基于 Supabase 实现数据云端存储
- 支持登录/注册/重置密码
- 单词数据、句子数据上传/下载同步
- 文章和音频云端保存
- 学习时长自动记录与每日同步
- 云同步状态实时显示

## 🚀 快速开始

### 网页端使用（推荐）

直接访问：**[https://lthc2007.github.io/english-vocab-learning/](https://lthc2007.github.io/english-vocab-learning/)**

无需安装任何依赖，打开即用。推荐使用 Chrome / Edge 浏览器。

### 本地运行

1. 克隆仓库或直接下载 `index.html`
2. 用浏览器打开 `index.html`
3. 无需安装任何依赖，开箱即用

### 使用云端功能（可选）

如需使用云端同步，需部署 Supabase 后端：

```bash
# 安装 Supabase CLI
npm install -g supabase

# 登录
supabase login

# 部署 Edge Functions
supabase functions deploy mimo-tts-proxy --project-ref <your-project-ref> --no-verify-jwt
supabase functions deploy dict-proxy --project-ref <your-project-ref> --no-verify-jwt
supabase functions deploy mineru-proxy --project-ref <your-project-ref> --no-verify-jwt
```

然后在 Supabase 控制台设置 Secret：
- `MIMO_API_KEY`：小米 MIMO API Key

## 🛠️ 技术栈

- **前端**：纯 HTML + CSS + JavaScript（单文件应用）
- **AI API**：OpenAI 兼容接口（支持多家服务商）
- **TTS**：Web Speech API + 多家云端 TTS API
- **后端代理**：Supabase Edge Functions（Deno）
- **数据存储**：localStorage（本地）+ Supabase（云端）

## 📁 项目结构

```
english-vocab-learning/
├── index.html                          # 主应用（单文件）
└── supabase/
    └── functions/
        ├── dict-proxy/
        │   └── index.ts                # 单词拼写校验（内置词表）
        ├── mimo-tts-proxy/
        │   └── index.ts                # 小米 MIMO TTS 代理（Edge Function）
        ├── mineru-proxy/
        │   └── index.ts                # Mineru 文档解析代理（拍照 OCR）
        ├── volcano-tts-proxy/
        │   └── index.ts                # 火山引擎 TTS 代理（Edge Function）
        └── zhipu-proxy/
            └── index.ts                # 智谱 AI 代理（Edge Function）
```

## 🔧 Edge Function 说明

`mimo-tts-proxy` 用于代理小米 MIMO TTS API 调用，避免前端暴露 API Key。内置重试机制（最多 3 次，指数退避），应对间歇性 401/5xx 错误。

`dict-proxy` 用于单词拼写校验，内置 37 万英语词表（来自 dwyl/english-words 的 words_alpha.txt），存在性判断为纯内存查询，不依赖任何上游 API，结果确定、响应稳定（毫秒级，冷启动约 3 秒）。单词不存在时前端提示检查拼写（可点击"继续查询"强制查询）；另带 AI 兜底判断，确保拼写提示在任何网络环境下都不会丢失。

`mineru-proxy` 用于拍照 OCR：前端上传图片二进制（已压缩为 JPEG），本函数完成 Mineru 三步调用（提交任务拿签名 URL → PUT 上传 → 轮询结果）后返回 Markdown 文本。当前使用免 Token 的 Agent 轻量 API（单文件 ≤10MB、IP 限频、仅输出 Markdown）；拿到标准 Token 后可切换到标准 API（每日 1000~2000 页免费额度）。

## 📝 License

MIT