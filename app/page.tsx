"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type ViewId =
  | "overview"
  | "monitor"
  | "opportunities"
  | "content"
  | "knowledge"
  | "risk"
  | "roi";

type PromptRow = {
  id: string;
  prompt: string;
  topic: string;
  engines: string[];
  visibility: number;
  change: number;
  cited: string;
  status: "领先" | "追赶" | "缺口";
};

const navItems: { id: ViewId; index: string; label: string; badge?: number }[] = [
  { id: "overview", index: "01", label: "指挥舱" },
  { id: "monitor", index: "02", label: "AI 监测", badge: 128 },
  { id: "opportunities", index: "03", label: "机会洞察", badge: 6 },
  { id: "content", index: "04", label: "内容作战", badge: 12 },
  { id: "knowledge", index: "05", label: "知识底座" },
  { id: "risk", index: "06", label: "风险纠偏", badge: 3 },
  { id: "roi", index: "07", label: "ROI 归因" },
];

const initialPrompts: PromptRow[] = [
  {
    id: "P-018",
    prompt: "制造业供应链协同平台有哪些推荐？",
    topic: "采购决策",
    engines: ["豆包", "DeepSeek", "ChatGPT"],
    visibility: 83,
    change: 12.4,
    cited: "行业白皮书 / 知乎",
    status: "领先",
  },
  {
    id: "P-027",
    prompt: "适合中型工厂的库存预测软件怎么选？",
    topic: "方案对比",
    engines: ["元宝", "Perplexity"],
    visibility: 62,
    change: 4.8,
    cited: "官网解决方案",
    status: "追赶",
  },
  {
    id: "P-041",
    prompt: "AI 供应链系统实施周期一般多久？",
    topic: "实施评估",
    engines: ["ChatGPT", "Gemini"],
    visibility: 28,
    change: -6.1,
    cited: "竞品客户案例",
    status: "缺口",
  },
  {
    id: "P-063",
    prompt: "国产供应链 SaaS 数据安全可靠吗？",
    topic: "安全信任",
    engines: ["DeepSeek", "豆包"],
    visibility: 71,
    change: 9.2,
    cited: "等保说明 / 公众号",
    status: "追赶",
  },
  {
    id: "P-088",
    prompt: "供应链数字化项目失败的常见原因",
    topic: "风险认知",
    engines: ["豆包", "元宝", "ChatGPT"],
    visibility: 18,
    change: -2.3,
    cited: "未引用我方信源",
    status: "缺口",
  },
];

const weeklyTrend = [48, 52, 51, 59, 64, 61, 68, 74];
const engineVisibility = [
  { name: "DeepSeek", value: 82, delta: "+8.6" },
  { name: "豆包", value: 76, delta: "+12.1" },
  { name: "ChatGPT", value: 71, delta: "+4.2" },
  { name: "元宝", value: 66, delta: "+6.8" },
  { name: "Perplexity", value: 57, delta: "+2.5" },
];

const opportunities = [
  {
    score: 94,
    title: "补齐“实施周期与成本”决策内容",
    detail: "竞品云链科技在 17 个高意图回答中被引用，我方目前没有可抽取的项目周期表。",
    source: "销售异议 × AI 缺口",
    action: "创建实施指南",
    impact: "高",
  },
  {
    score: 88,
    title: "更新 2024 版库存预测参数",
    detail: "3 个模型仍引用旧参数，需用带 dateModified 的权威事实页覆盖。",
    source: "幻觉监测 × 事实库",
    action: "发起纠偏",
    impact: "高",
  },
  {
    score: 81,
    title: "建设国产化适配第三方信源",
    detail: "安全类问题中，AI 更偏好行业媒体与认证机构，官网自述权重不足。",
    source: "引用图谱 × 竞品",
    action: "创建 PR 任务",
    impact: "中",
  },
  {
    score: 76,
    title: "将客户访谈转为可引用案例",
    detail: "现有 12 份访谈缺少结构化结果数据和客户授权状态，无法进入内容流水线。",
    source: "知识库 × 内容生产",
    action: "整理证据块",
    impact: "中",
  },
];

const contentColumns = [
  {
    title: "机会池",
    count: 4,
    items: [
      ["供应链项目周期指南", "机会分 94", "市场部"],
      ["国产化适配白皮书", "机会分 81", "PR"],
    ],
  },
  {
    title: "事实核验",
    count: 3,
    items: [
      ["库存预测参数更新", "需产品确认", "产品部"],
      ["华东客户降本案例", "缺 2 项证据", "客户成功"],
    ],
  },
  {
    title: "内容生产",
    count: 3,
    items: [
      ["2027 供应链选型清单", "完成 68%", "内容组"],
      ["AI 排产 FAQ", "完成 42%", "行业专家"],
    ],
  },
  {
    title: "分发监测",
    count: 2,
    items: [
      ["零库存实践报告", "已分发 5 渠道", "增长组"],
      ["安全合规说明", "等待首次采样", "研发"],
    ],
  },
];

const knowledgeAssets = [
  { name: "品牌与产品事实库", owner: "品牌中心", freshness: 96, status: "健康", facts: 286 },
  { name: "客户案例证据库", owner: "客户成功", freshness: 78, status: "待更新", facts: 94 },
  { name: "产品参数与定价", owner: "产品部", freshness: 89, status: "健康", facts: 132 },
  { name: "行业研究与白皮书", owner: "市场部", freshness: 64, status: "需治理", facts: 58 },
  { name: "合规资质与安全", owner: "法务 / IT", freshness: 92, status: "健康", facts: 73 },
];

const risks = [
  {
    level: "P0",
    title: "价格幻觉：ChatGPT 引用已下线套餐",
    detail: "在 21 次采样中出现 7 次，污染源指向 2024 年第三方评测文章。",
    owner: "品牌公关",
    eta: "今日 18:00",
    path: "RAG 污染 · 可在 1–4 周修复",
  },
  {
    level: "P1",
    title: "豆包混淆“预测”与“排产”产品能力",
    detail: "官网两个解决方案页实体定义不一致，建议统一标准品牌描述。",
    owner: "产品市场",
    eta: "明日",
    path: "实体冲突 · 需修复事实源",
  },
  {
    level: "P2",
    title: "旧客户投诉被元宝重复引用",
    detail: "负面帖子已有官方回复，但缺少新版问题修复的时间锚点与第三方验证。",
    owner: "客户成功",
    eta: "本周五",
    path: "旧负面 · 需新叙事覆盖",
  },
];

const roiSources = [
  { label: "AI 引荐访问", value: "4,286", delta: "+31.2%", note: "GA4 自定义渠道" },
  { label: "AI 归因线索", value: "184", delta: "+22.7%", note: "访问 + 表单自报" },
  { label: "线索转化率", value: "8.7%", delta: "+2.4 pt", note: "SEO 渠道为 4.1%" },
  { label: "估算管道金额", value: "¥ 368万", delta: "+18.6%", note: "CRM 机会金额" },
];

function MiniStatus({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "good" | "warn" | "bad" }) {
  return <span className={`mini-status ${tone}`}>{label}</span>;
}

function Meter({ value, tone = "lime" }: { value: number; tone?: "lime" | "orange" | "ink" }) {
  return (
    <div className="meter" aria-label={`${value}%`}>
      <span className={tone} style={{ width: `${value}%` }} />
    </div>
  );
}

function SectionHeading({ eyebrow, title, meta }: { eyebrow: string; title: string; meta?: string }) {
  return (
    <div className="section-heading">
      <div>
        <p>{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {meta ? <span>{meta}</span> : null}
    </div>
  );
}

export default function GeoWorkbench() {
  const [activeView, setActiveView] = useState<ViewId>("overview");
  const [prompts, setPrompts] = useState<PromptRow[]>(initialPrompts);
  const [engineFilter, setEngineFilter] = useState("全部引擎");
  const [scanProgress, setScanProgress] = useState<number | null>(null);
  const [showPromptModal, setShowPromptModal] = useState(false);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShowCommandMenu((open) => !open);
      }
      if (event.key === "Escape") {
        setShowPromptModal(false);
        setShowCommandMenu(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const filteredPrompts = useMemo(() => {
    if (engineFilter === "全部引擎") return prompts;
    return prompts.filter((row) => row.engines.includes(engineFilter));
  }, [engineFilter, prompts]);

  const runScan = () => {
    if (scanProgress !== null) return;
    setScanProgress(8);
    let current = 8;
    const timer = window.setInterval(() => {
      current += Math.floor(Math.random() * 16) + 8;
      if (current >= 100) {
        window.clearInterval(timer);
        setScanProgress(100);
        window.setTimeout(() => {
          setScanProgress(null);
          setNotice("本轮 128 个提示词采样完成，发现 2 个新机会");
        }, 500);
      } else {
        setScanProgress(current);
      }
    }, 420);
  };

  const addPrompt = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const prompt = String(form.get("prompt") || "").trim();
    const topic = String(form.get("topic") || "").trim() || "新主题";
    if (!prompt) return;
    setPrompts((rows) => [
      {
        id: `P-${String(rows.length + 101).padStart(3, "0")}`,
        prompt,
        topic,
        engines: ["豆包", "DeepSeek", "ChatGPT"],
        visibility: 0,
        change: 0,
        cited: "等待首次采样",
        status: "缺口",
      },
      ...rows,
    ]);
    setShowPromptModal(false);
    setNotice("提示词已加入监测计划");
  };

  const goTo = (view: ViewId) => {
    setActiveView(view);
    setShowCommandMenu(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const renderOverview = () => (
    <>
      <section className="command-hero">
        <div className="hero-copy">
          <div className="hero-kicker"><span /> 今日作战指令 · 2026-W48</div>
          <h1>先修复事实，<br />再扩大声量。</h1>
          <p>AI 已在 3 个高意图问题中引用旧版产品参数。修复权威事实页后，再推动“实施周期指南”进入内容生产。</p>
          <div className="hero-actions">
            <button className="primary-action" onClick={() => goTo("risk")}>处理 3 个风险 <span>→</span></button>
            <button className="text-action" onClick={() => goTo("opportunities")}>查看完整机会清单</button>
          </div>
        </div>
        <div className="hero-score">
          <div className="score-topline"><span>综合 GEO 健康度</span><MiniStatus label="稳步提升" tone="good" /></div>
          <div className="score-number"><strong>72.4</strong><span>/ 100</span></div>
          <div className="score-delta">↑ 8.6 <span>过去 30 天</span></div>
          <div className="score-grid">
            <div><span>AI 可见度</span><b>74%</b></div>
            <div><span>引用率</span><b>61%</b></div>
            <div><span>事实准确度</span><b>92%</b></div>
          </div>
        </div>
      </section>

      <section className="metric-strip" aria-label="核心指标">
        <div><span>AI 声量份额</span><strong>27.8%</strong><em>+4.2 pt</em></div>
        <div><span>有效提示词</span><strong>128</strong><em>6 个待补缺口</em></div>
        <div><span>首选推荐率</span><strong>18.6%</strong><em>+3.1 pt</em></div>
        <div><span>AI 归因线索</span><strong>184</strong><em>+22.7%</em></div>
      </section>

      <section className="dashboard-grid two-one">
        <article className="panel trend-panel">
          <SectionHeading eyebrow="品牌可见度" title="8 周趋势" meta="目标线 70%" />
          <div className="chart-area">
            <div className="y-labels"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div>
            <div className="bars-area">
              <div className="target-line"><span>目标</span></div>
              {weeklyTrend.map((value, index) => (
                <div className="week-bar" key={`week-${index}`}>
                  <span style={{ height: `${value}%` }}><i>{value}</i></span>
                  <small>W{41 + index}</small>
                </div>
              ))}
            </div>
          </div>
          <div className="chart-legend"><span><i className="legend-lime" /> 星河科技</span><span><i className="legend-line" /> 阶段目标</span><b>本周首次超过目标线</b></div>
        </article>

        <article className="panel engine-panel">
          <SectionHeading eyebrow="引擎表现" title="可见度排行" meta="近 30 天" />
          <div className="engine-list">
            {engineVisibility.map((engine, index) => (
              <div className="engine-row" key={engine.name}>
                <span className="rank">0{index + 1}</span>
                <div><strong>{engine.name}</strong><Meter value={engine.value} tone={index === 0 ? "lime" : "ink"} /></div>
                <b>{engine.value}%</b>
                <em>{engine.delta}</em>
              </div>
            ))}
          </div>
          <button className="panel-link" onClick={() => goTo("monitor")}>进入 AI 监测 <span>→</span></button>
        </article>
      </section>

      <section className="dashboard-grid one-one">
        <article className="panel action-panel">
          <SectionHeading eyebrow="优先行动" title="本周最值得做的 4 件事" meta="按机会分排序" />
          <div className="action-list">
            {opportunities.slice(0, 4).map((item, index) => (
              <button key={item.title} onClick={() => goTo(index === 1 ? "risk" : "opportunities")}>
                <span className="action-index">{String(index + 1).padStart(2, "0")}</span>
                <div><strong>{item.title}</strong><small>{item.source}</small></div>
                <span className="opportunity-score">{item.score}</span>
                <span className="row-arrow">↗</span>
              </button>
            ))}
          </div>
        </article>

        <article className="panel source-panel">
          <SectionHeading eyebrow="信源结构" title="谁在影响 AI 的答案" meta="1,824 条引用" />
          <div className="source-visual">
            <div className="source-donut"><div><strong>61%</strong><span>第三方信源</span></div></div>
            <div className="source-legend">
              <div><span><i className="source-dot a" />行业媒体</span><b>28%</b></div>
              <div><span><i className="source-dot b" />企业官网</span><b>24%</b></div>
              <div><span><i className="source-dot c" />社区问答</span><b>21%</b></div>
              <div><span><i className="source-dot d" />评测与百科</span><b>17%</b></div>
              <div><span><i className="source-dot e" />其他</span><b>10%</b></div>
            </div>
          </div>
          <div className="source-note"><span>!</span><p><strong>官网不是唯一答案。</strong> 供应链安全类问题中，第三方认证与行业媒体的引用权重高于企业自述。</p></div>
        </article>
      </section>
    </>
  );

  const renderMonitor = () => (
    <>
      <section className="page-intro">
        <div><p>OBSERVABILITY</p><h1>AI 监测</h1><span>用不带品牌词的真实问题，持续观察品牌在不同模型中的出现概率。</span></div>
        <div className="page-actions">
          <button className="secondary-button" onClick={() => setShowPromptModal(true)}>＋ 添加提示词</button>
          <button className="primary-action compact" onClick={runScan}>{scanProgress === null ? "运行新一轮采样" : `采样中 ${scanProgress}%`}</button>
        </div>
      </section>

      {scanProgress !== null ? <div className="scan-banner"><span style={{ width: `${scanProgress}%` }} /><p>正在跨 6 个 AI 引擎采集答案与引用信源…</p></div> : null}

      <section className="metric-strip monitor-metrics">
        <div><span>本周期采样</span><strong>12,800</strong><em>100 次 / 提示词</em></div>
        <div><span>品牌出现率</span><strong>74.1%</strong><em>+5.8 pt</em></div>
        <div><span>幽灵引用率</span><strong>9.6%</strong><em className="warn-text">需关注</em></div>
        <div><span>负面 / 幻觉</span><strong>2.3%</strong><em>低于警戒线</em></div>
      </section>

      <section className="panel table-panel">
        <div className="table-toolbar">
          <div><strong>提示词监测矩阵</strong><span>{filteredPrompts.length} 个主题问题</span></div>
          <div className="filter-group">
            {["全部引擎", "豆包", "DeepSeek", "ChatGPT", "元宝"].map((engine) => (
              <button className={engineFilter === engine ? "active" : ""} onClick={() => setEngineFilter(engine)} key={engine}>{engine}</button>
            ))}
          </div>
          <button className="icon-button" aria-label="更多筛选">筛选 ▾</button>
        </div>
        <div className="data-table prompt-table">
          <div className="table-head"><span>问题 / 主题</span><span>监测引擎</span><span>出现率</span><span>主要引用</span><span>状态</span></div>
          {filteredPrompts.map((row) => (
            <button className="table-row" key={row.id} onClick={() => setNotice(`已打开 ${row.id} 的回答样本`)}>
              <span className="prompt-cell"><small>{row.id} · {row.topic}</small><strong>{row.prompt}</strong></span>
              <span className="engine-chips">{row.engines.slice(0, 3).map((engine) => <i key={engine}>{engine.slice(0, 2)}</i>)}</span>
              <span className="visibility-cell"><strong>{row.visibility}%</strong><small className={row.change < 0 ? "negative" : ""}>{row.change > 0 ? "+" : ""}{row.change}</small></span>
              <span className="cited-cell">{row.cited}</span>
              <span><MiniStatus label={row.status} tone={row.status === "领先" ? "good" : row.status === "缺口" ? "bad" : "warn"} /></span>
            </button>
          ))}
        </div>
      </section>

      <section className="method-note">
        <span>监测口径</span>
        <p>每个核心问题每天采样 100 次以上；严禁带品牌词；按国家、语言和引擎切片。定量看出现率趋势，单次回答再复核推荐位次与语境。</p>
      </section>
    </>
  );

  const renderOpportunities = () => (
    <>
      <section className="page-intro">
        <div><p>INSIGHT TO ACTION</p><h1>机会洞察</h1><span>把“没被推荐”拆成可执行的内容、信源、技术与事实修复任务。</span></div>
        <button className="primary-action compact" onClick={() => setNotice("本周机会简报已生成")}>生成周报 <span>→</span></button>
      </section>
      <section className="opportunity-layout">
        <div className="opportunity-feed">
          {opportunities.map((item, index) => (
            <article className="opportunity-card" key={item.title}>
              <div className="score-block"><strong>{item.score}</strong><span>机会分</span></div>
              <div className="opportunity-body">
                <div><MiniStatus label={item.impact === "高" ? "高影响" : "中影响"} tone={item.impact === "高" ? "bad" : "warn"} /><span className="source-label">{item.source}</span></div>
                <h3>{item.title}</h3><p>{item.detail}</p>
                <button onClick={() => setNotice(`“${item.title}”已创建任务`)}>{item.action} <span>→</span></button>
              </div>
              <span className="card-index">0{index + 1}</span>
            </article>
          ))}
        </div>
        <aside className="opportunity-sidebar">
          <article className="panel compact-panel">
            <SectionHeading eyebrow="机会来源" title="本周分布" />
            {[['内容缺口', 42], ['信源缺口', 27], ['事实冲突', 18], ['技术可读性', 13]].map(([label, value]) => (
              <div className="distribution-row" key={String(label)}><span>{label}</span><Meter value={Number(value)} tone="lime" /><b>{value}%</b></div>
            ))}
          </article>
          <article className="principle-card">
            <span>GEO 原则 / 04</span>
            <h3>不是再写一篇，<br />而是增加一条新证据。</h3>
            <p>每个内容任务至少注入 1 组内部数据、1 个真实案例和 1 条可核验来源。</p>
          </article>
        </aside>
      </section>
    </>
  );

  const renderContent = () => (
    <>
      <section className="page-intro">
        <div><p>CONTENT OPERATIONS</p><h1>内容作战</h1><span>AI 搭骨架，业务专家填证据；所有发布动作都经过人工审批。</span></div>
        <button className="primary-action compact" onClick={() => setNotice("新内容任务已创建")}>＋ 新建内容任务</button>
      </section>
      <section className="content-stages">
        <span className="active">1 机会入池</span><i>→</i><span>2 事实核验</span><i>→</i><span>3 专家增益</span><i>→</i><span>4 合规审批</span><i>→</i><span>5 多渠道分发</span><i>→</i><span>6 引用复盘</span>
      </section>
      <section className="kanban-board">
        {contentColumns.map((column) => (
          <div className="kanban-column" key={column.title}>
            <div className="column-heading"><strong>{column.title}</strong><span>{column.count}</span></div>
            {column.items.map((item, index) => (
              <article className="content-card" key={item[0]}>
                <span className={`content-type type-${index}`}>{index % 2 === 0 ? "长文" : "事实页"}</span>
                <h3>{item[0]}</h3>
                <p>{item[1]}</p>
                <div><span className="avatar-small">{item[2].slice(0, 1)}</span><small>{item[2]}</small><button aria-label="打开任务">↗</button></div>
              </article>
            ))}
            <button className="add-card">＋ 添加任务</button>
          </div>
        ))}
      </section>
      <section className="method-note dark-note">
        <span>发布边界</span><p>自动化可以读数据、写草稿、提建议，但没有发布按钮。任何事实声明、客户案例与外部投放都必须由责任人逐条批准。</p>
      </section>
    </>
  );

  const renderKnowledge = () => (
    <>
      <section className="page-intro">
        <div><p>SINGLE SOURCE OF TRUTH</p><h1>知识底座</h1><span>一套事实、双语复用；让内容生产和 AI 回答引用同一份企业真相。</span></div>
        <button className="primary-action compact" onClick={() => setNotice("知识库健康检查已排队")}>运行健康检查</button>
      </section>
      <section className="knowledge-summary">
        <article className="knowledge-score"><span>知识库成熟度</span><strong>84</strong><small>/ 100</small><p>已达到“可规模化生产”阶段</p></article>
        <article><span>可引用事实块</span><strong>643</strong><em>+38 本月</em></article>
        <article><span>证据覆盖率</span><strong>76%</strong><em>目标 85%</em></article>
        <article><span>过期资产</span><strong>17</strong><em className="warn-text">7 天内处理</em></article>
      </section>
      <section className="panel table-panel">
        <div className="table-toolbar"><div><strong>企业事实资产</strong><span>按业务域维护唯一事实源</span></div><button className="icon-button">＋ 新建知识域</button></div>
        <div className="data-table knowledge-table">
          <div className="table-head"><span>知识域</span><span>责任部门</span><span>事实块</span><span>新鲜度</span><span>状态</span></div>
          {knowledgeAssets.map((asset) => (
            <button className="table-row" key={asset.name} onClick={() => setNotice(`已打开“${asset.name}”`)}>
              <span className="asset-name"><i>{asset.name.slice(0, 1)}</i><strong>{asset.name}</strong></span><span>{asset.owner}</span><span>{asset.facts}</span>
              <span className="freshness"><Meter value={asset.freshness} tone={asset.freshness < 70 ? "orange" : "lime"} /><b>{asset.freshness}%</b></span>
              <span><MiniStatus label={asset.status} tone={asset.status === "健康" ? "good" : asset.status === "需治理" ? "bad" : "warn"} /></span>
            </button>
          ))}
        </div>
      </section>
      <section className="foundation-grid">
        <article><span>01</span><h3>标准品牌定义</h3><p>品牌名 + 品类 + 核心差异化，所有公开信源保持一致。</p><MiniStatus label="已锁定" tone="good" /></article>
        <article><span>02</span><h3>原始证据层</h3><p>专利、案例、产品参数、客户数据，每个数字可回溯。</p><MiniStatus label="覆盖 76%" tone="warn" /></article>
        <article><span>03</span><h3>AI 可读层</h3><p>结论前置、Q&A、对比表、Schema 与明确更新时间。</p><MiniStatus label="通过 89%" tone="good" /></article>
        <article><span>04</span><h3>资产分级</h3><p>公开诱饵层与内部金库层隔离，权限和版权边界清晰。</p><MiniStatus label="已配置" tone="good" /></article>
      </section>
    </>
  );

  const renderRisk = () => (
    <>
      <section className="page-intro risk-intro">
        <div><p>TRUST & CORRECTION</p><h1>风险纠偏</h1><span>识别 RAG 污染、旧负面与实体冲突，用时间戳和权威信源恢复事实。</span></div>
        <button className="primary-action compact" onClick={() => setNotice("已开始全引擎风险扫描")}>启动风险扫描</button>
      </section>
      <section className="risk-summary">
        <div><span className="risk-pulse" />当前风险水位 <strong>中等</strong></div><p>过去 7 天发现 3 个需人工处理的问题，均未触发合规红线。</p><span>最近扫描：今天 09:40</span>
      </section>
      <section className="risk-list">
        {risks.map((risk) => (
          <article key={risk.title}>
            <span className={`risk-level ${risk.level.toLowerCase()}`}>{risk.level}</span>
            <div className="risk-body"><h3>{risk.title}</h3><p>{risk.detail}</p><span>{risk.path}</span></div>
            <div className="risk-owner"><span>负责人</span><strong>{risk.owner}</strong><small>{risk.eta}</small></div>
            <button onClick={() => setNotice(`已进入“${risk.title}”处置流程`)}>进入处置台 <span>→</span></button>
          </article>
        ))}
      </section>
      <section className="correction-path">
        <SectionHeading eyebrow="标准处置路径" title="从污染定位到复盘验证" />
        <div><span>01</span><strong>定位来源</strong><p>区分实时检索污染与底层记忆</p></div><i>→</i>
        <div><span>02</span><strong>修复事实源</strong><p>时间戳、权威页、结构化标记</p></div><i>→</i>
        <div><span>03</span><strong>建立外部共识</strong><p>第三方验证与新版客观复盘</p></div><i>→</i>
        <div><span>04</span><strong>连续采样</strong><p>观察 1–4 周修复趋势</p></div>
      </section>
    </>
  );

  const renderRoi = () => (
    <>
      <section className="page-intro">
        <div><p>BUSINESS IMPACT</p><h1>ROI 归因</h1><span>把点击、零点击与销售线索放在同一张商业价值地图里。</span></div>
        <button className="primary-action compact" onClick={() => setNotice("管理层月报已导出")}>导出管理层月报</button>
      </section>
      <section className="roi-grid">
        {roiSources.map((source) => <article key={source.label}><span>{source.label}</span><strong>{source.value}</strong><em>{source.delta}</em><p>{source.note}</p></article>)}
      </section>
      <section className="dashboard-grid two-one roi-lower">
        <article className="panel attribution-panel">
          <SectionHeading eyebrow="三层归因" title="AI 带来的真实业务价值" meta="本季度" />
          <div className="attribution-funnel">
            <div style={{ width: "100%" }}><span>AI 引荐与直接访问</span><strong>4,286</strong><small>可追踪点击</small></div>
            <div style={{ width: "82%" }}><span>品牌搜索增量</span><strong>1,124</strong><small>相关性估算</small></div>
            <div style={{ width: "64%" }}><span>表单自报 AI 来源</span><strong>96</strong><small>零点击线索</small></div>
            <div style={{ width: "46%" }}><span>已进入销售机会</span><strong>41</strong><small>CRM 回传</small></div>
          </div>
        </article>
        <article className="panel manager-panel">
          <SectionHeading eyebrow="管理层摘要" title="本月 GEO 结论" />
          <div className="summary-point"><span>01</span><p><strong>声量份额升至 27.8%</strong>，超过竞品云链科技 2.1 个百分点。</p></div>
          <div className="summary-point"><span>02</span><p><strong>AI 线索转化率 8.7%</strong>，是自然搜索渠道的 2.1 倍。</p></div>
          <div className="summary-point"><span>03</span><p><strong>旧价格幻觉仍未清零</strong>，预计影响本月 6–12 条高意向线索。</p></div>
          <button className="panel-link" onClick={() => setNotice("已复制摘要")}>复制摘要 <span>→</span></button>
        </article>
      </section>
      <section className="method-note"><span>价值口径</span><p>GEO 的商业价值不能只看点击。统一汇总 AI 引荐访问、表单自报来源、品牌词增量、CRM 线索与成交，才能避免低估零点击影响。</p></section>
    </>
  );

  const viewContent: Record<ViewId, () => React.ReactNode> = {
    overview: renderOverview,
    monitor: renderMonitor,
    opportunities: renderOpportunities,
    content: renderContent,
    knowledge: renderKnowledge,
    risk: renderRisk,
    roi: renderRoi,
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => goTo("overview")} aria-label="返回指挥舱"><span>G</span><strong>GEO<span>/OS</span></strong></button>
        <div className="workspace-chip"><span>星</span><div><strong>星河科技</strong><small>企业工作区</small></div><button aria-label="切换企业">⌄</button></div>
        <nav aria-label="主导航">
          <p>工作台</p>
          {navItems.map((item) => (
            <button key={item.id} className={activeView === item.id ? "active" : ""} onClick={() => goTo(item.id)}>
              <span>{item.index}</span><strong>{item.label}</strong>{item.badge ? <small>{item.badge}</small> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button><span>08</span><strong>团队与审批</strong></button>
          <button><span>09</span><strong>数据连接</strong><i>4</i></button>
          <div className="plan-card"><span>企业版</span><strong>128 / 500</strong><small>提示词用量</small><Meter value={26} tone="lime" /></div>
          <div className="user-card"><span className="avatar">林</span><div><strong>林澈</strong><small>增长负责人</small></div><button>•••</button></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>星河科技</span><i>/</i><strong>{navItems.find((item) => item.id === activeView)?.label}</strong></div>
          <div className="top-actions">
            <button className="search-trigger" onClick={() => setShowCommandMenu(true)}><span>⌕</span> 搜索或跳转 <kbd>⌘ K</kbd></button>
            <button className="date-button">近 30 天 <span>⌄</span></button>
            <button className="notification-button" aria-label="通知"><span>3</span>●</button>
            <button className="help-button" aria-label="帮助">?</button>
          </div>
        </header>
        <div className="page-content"><p role="note" style={{margin:"0 0 12px",fontSize:"13px",opacity:.8}}>演示模式 · 示例数据；真实监测服务请参见 GitHub README。</p>{viewContent[activeView]()}</div>
      </main>

      {showPromptModal ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowPromptModal(false)}>
          <form className="modal" onSubmit={addPrompt} onMouseDown={(event) => event.stopPropagation()}>
            <div><span>NEW PROMPT</span><button type="button" onClick={() => setShowPromptModal(false)}>×</button></div>
            <h2>添加监测问题</h2><p>使用客户会真实提出的问题，不要在问题中包含品牌词。</p>
            <label>问题内容<textarea name="prompt" placeholder="例如：适合中型制造企业的库存预测软件有哪些？" autoFocus required /></label>
            <label>主题分类<input name="topic" placeholder="例如：方案对比" /></label>
            <div className="modal-actions"><button type="button" onClick={() => setShowPromptModal(false)}>取消</button><button type="submit">加入监测计划</button></div>
          </form>
        </div>
      ) : null}

      {showCommandMenu ? (
        <div className="command-backdrop" onMouseDown={() => setShowCommandMenu(false)}>
          <div className="command-menu" onMouseDown={(event) => event.stopPropagation()}>
            <div><span>⌕</span><input placeholder="搜索页面、提示词或任务…" autoFocus /><kbd>ESC</kbd></div>
            <p>快速跳转</p>
            {navItems.map((item) => <button onClick={() => goTo(item.id)} key={item.id}><span>{item.index}</span><strong>{item.label}</strong><small>跳转 →</small></button>)}
          </div>
        </div>
      ) : null}

      {notice ? <div className="toast"><span>✓</span>{notice}</div> : null}
    </div>
  );
}
