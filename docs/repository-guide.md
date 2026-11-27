# GEO/OS 仓库结构与运行入口

## 正式研发主线（本地真实业务）
- `geo/galaxy.html`：ESO 银河全景首页；顶部导航、平面全景、WebGL 球面及 Canvas 降级，不含业务占位面板。
- `geo/assets/eso0932a.jpg`：用户确认的原始 JPEG，保持字节不变；来源与署名见同目录 README。
- `geo/index.html`：登录、真实工作区及 8 个业务阶段，支持 `/workbench?view=knowledge` 等白名单入口。
- `geo/server.mjs`：本地 HTTP、登录、权限、审计、业务 API；SQLite 数据及业务模块位于 geo/。
- `geo/mcp.mjs`、`skills/geoos/`：本地只读 MCP 与 Skill。
- `tests/geo-*.test.mjs`：核心功能和 HTTP 测试；`tests/geo-browser.mjs`：Chromium 冒烟。
- `Dockerfile.geo`、`compose.geo.yml`：本地容器运行。
- `docs/business-workflow.md`：业务顺序、审批边界。

## 独立历史演示
`app/`、`public/`、`worker/` 和 `npm run dev` 属于原 Next/vinext 示例，不与 geo/ 真实 API 混用；保留兼容性，未替换在线演示部署。

## 首次启动
Node.js >=22.13.0。首次数据库初始化需要 GEO_ADMIN_USER 与 GEO_ADMIN_PASSWORD（安全环境注入，至少 12 字符）；然后执行 npm run geo:live。
访问 http://127.0.0.1:3100/ 浏览银河首页，或直接访问 /workbench。图片由同源 HTTP 提供，无 CDN 依赖。模型和渠道凭证由服务端配置。裸机文档解析另需 Python 3 和 pdftotext。
npm run geo:test 执行核心测试；npm run geo:browser 需要 Playwright 和 Chromium，CI 使用固定 Ubuntu 24.04 环境。
服务默认本地 HTTP，不应直接暴露公网。不要提交数据库、密钥或企业内部资料。

## 界面规范
保留真实摄影，不使用生成式星体代替照片。顶部横排功能，与星空交互独立；不显示图片介绍、导入及复位控件。仅保留 ESO 摄影署名和许可链接。选择模块进入真实权限工作台；无工作区时先完成初始化。现有人工审核、发布、计费等边界不变。
