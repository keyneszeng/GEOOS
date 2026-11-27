# GEO/OS — 企业 GEO 优化工作台

GEO/OS 是一个面向企业市场、品牌、公关、内容、产品和数据团队的生成式引擎优化（GEO）工作台。它围绕“监测 → 诊断 → 行动 → 复盘”建立闭环，帮助企业观察品牌在 ChatGPT、DeepSeek、豆包、元宝、Gemini、Perplexity 等 AI 引擎中的可见度，并把内容缺口、事实冲突和信源问题转化为可执行任务。

在线演示：[geo-os-workbench.swift-lake-5238.chatgpt.site](https://geo-os-workbench.swift-lake-5238.chatgpt.site)

> 当前版本为可交互的产品原型，界面数据均为安全的示例数据，尚未连接真实企业数据或第三方 API。

## 核心能力

- **GEO 指挥舱**：综合健康度、AI 声量份额、推荐率、引用率与趋势总览
- **AI 监测**：提示词管理、多引擎筛选、批量采样状态和幽灵引用观察
- **机会洞察**：将内容缺口、信源缺口、事实冲突和技术问题转成行动建议
- **内容作战**：机会入池、事实核验、专家增益、合规审批、分发与引用复盘
- **知识底座**：维护企业唯一事实源、证据覆盖率、新鲜度和公开/内部资产分级
- **风险纠偏**：处理 RAG 污染、旧负面、价格幻觉和品牌实体定义冲突
- **ROI 归因**：统一观察 AI 引荐访问、零点击线索、品牌搜索增量和 CRM 商机

## 产品方法

工作台遵循以下企业 GEO 原则：

1. 用不含品牌词的真实决策问题监测“出现概率”，避免把单次回答当作稳定排名。
2. 内容生产必须由企业事实与原始证据驱动，AI 负责搭骨架，业务专家负责信息增益。
3. 官网、行业媒体、社区问答、评测和百科共同构成 AI 的信源共识。
4. 监测的目的不是生成报表，而是找到下一步可执行的内容、技术、PR 或事实修复动作。
5. GEO 价值不能只按点击归因，需同时观察表单自报、品牌搜索与 CRM 线索。
6. 自动化可以采集、分析和写草稿，但外部发布与事实声明必须经过人工审批。

## 技术栈

- React 19
- Next.js 16 App Router
- vinext + Vite
- TypeScript
- Tailwind CSS 4（基础构建）与产品级自定义 CSS
- Cloudflare Workers 兼容构建

## 本地运行

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

默认访问 `http://localhost:3000`。

部分旧版 macOS 无法运行 Cloudflare `workerd`。此时可使用纯 UI 预览模式：

```bash
SITES_LOCAL_UI_PREVIEW=1 npm run dev
```

## 验证

```bash
npm run build
node --test tests/rendered-html.test.mjs
```

## 项目结构

```text
app/
  page.tsx          # 工作台数据、视图和交互
  globals.css       # 完整视觉系统与响应式布局
  layout.tsx        # 站点元数据和社交分享配置
public/
  og.png            # GEO/OS 社交分享封面
tests/
  rendered-html.test.mjs
.openai/
  hosting.json      # Sites 托管声明
worker/
  index.ts          # Cloudflare Worker 入口
```

## 后续接入建议

- 通过模型 API 或浏览器采样服务接入真实 AI 回答与引用 URL
- 接入企业 CMS、知识库、GA4、Search Console 与 CRM
- 使用 D1/PostgreSQL 保存提示词、回答快照、内容任务和审计记录
- 增加企业成员、角色权限、审批流和多品牌工作区
- 对接飞书、Slack 或企业微信，实现风险告警与周报推送

## 数据与安全

仓库不包含真实客户资料、API 密钥或本地 Obsidian 原始笔记。生产环境接入企业数据时，应将公开可引用资产与内部机密知识分层管理，并通过服务端权限控制保护写操作。

## 真实监测服务（阶段一 MVP）

原在线演示保留。新增独立本地服务，不依赖 D1 或前端构建。Node.js >=22.13.0，内置 SQLite（可能显示实验性警告）。

```bash
# 从安全终端环境注入供应商密钥，不要提交到 Git
# DeepSeek: DEEPSEEK_API_KEY + GEO_DEEPSEEK_MODEL（账户可用模型 ID）
# Perplexity: PERPLEXITY_API_KEY
npm run geo:live
# 打开 http://127.0.0.1:3100
npm run geo:test
```

- 多工作区、品牌别名、竞品和无品牌决策问题，持久化至 .geo-data/geo.sqlite（GEO_DB 可覆盖）。
- DeepSeek Chat Completions / Perplexity Agent API；原始响应、明确引用、检索来源分开记录。
- GEO_DAILY_LIMIT 默认 30（UTC，全局，含失败尝试），GEO_PORT 默认 3100。手动采样可能计费，不自动重试或定时采样。
- 仅绑定 127.0.0.1，校验 Host/Origin；单操作员本地使用，**不可直接代理到公网**。不得将 API 样本视为消费者 AI 产品排名。只统计文本提及率及含引用回答比例，不代表推荐率、企业信源引用率或准确率。链接未验证可访问性。
- 后续：定时队列、权限隔离、业务 UI/API 合并、事实证据与机会生成。
