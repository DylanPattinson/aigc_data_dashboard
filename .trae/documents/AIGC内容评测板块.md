# 新增「AIGC内容评测」板块（最大篇幅）

## Context

现有看板覆盖贴吧 AIGC 链路的「生产 → 三层审核 → 分发 → 曝光 → 点击 → 调起」，但**只刻画了内容「有没有出来」「过没过审」「有没有人点」，没有刻画内容「好不好」**。而对 AIGC 批量生产来说，质量恰恰是决定这套模式能不能规模化的关键变量：画面糊、声画对不上、文不对题的内容照样能过审上线，只是没人点、点了也调不起贴吧。

本轮新增一个**占看板最大篇幅**的「AIGC内容评测」板块，从 6 个质量维度刻画 AIGC 产出质量，并把它和下游转化（CTR / 调起成功率）关联起来，回答增长 PM 最关心的两个问题：**内容质量现在处在什么水位？低质内容是不是真的没人点？**

已确认的四个设计决策：
1. 评测来源：**自动评测为主（全量）+ 人审抽样复核（少量）**，可算人机一致率；
2. 评测维度：**6 维**（画面质量 / 声画一致性 / 内容-Query 符合度 / 图片素材质量 / 文本可读性与信息量 / 事实性与合规），声画一致性仅视频帖适用；
3. 分值体系：**0~100 连续分 + 自动分档**（优 ≥85 / 良 70~85 / 中 55~70 / 差 <55），不合格 = 中及以下；
4. 配套范围：顶部加「AIGC 综合质量分」KPI 卡（7→8 张）、新增异常规则 **R6 质量异常**、做**质量分 × 下游转化关联分析**。

## 铁律延续

- 所有指标继续从事件级原始数据派生，不写死任何结果；跨页面数值必然一致。
- **不适用维度不预存布尔字段**：图文帖的 `scores` 里根本没有 `av_sync` 键，由 `buildContentIndex()` 运行时判定，与「三层审核结论不预存」同源。
- 分母为零返回 `null`，前端展示 `—`；不显示 NaN / Infinity。

---

## 一、数据模型（新增第 9 类事件）

`src/types.ts`：

```typescript
export type EvalDimension =
  | 'visual' | 'av_sync' | 'relevance' | 'material' | 'readability' | 'factuality';
export type EvalSource = 'auto' | 'human';

/** 单条内容的一次评测结果（一条记录含该来源下的全部适用维度） */
export interface ContentEval {
  evalId: string;
  contentId: string;
  barId: string;
  queryId: string;
  contentType: string;
  /** 归属到内容生成日，与内容 / 审核 / 分发同口径 */
  ts: string;
  source: EvalSource;
  /** 维度分 0~100；不适用维度缺键 */
  scores: Partial<Record<EvalDimension, number>>;
  /** 仅低分维度（< 70）产出，用于下钻看扣分原因 */
  issues: Array<{ dim: EvalDimension; reason: string }>;
  /** 评测模型版本，用于看迭代效果 */
  modelVersion: string;
}
```

- `Events` 新增 `evals: ContentEval[]`；`Meta.dictionaries` 新增 `evalDimensions`、`evalSources`、`evalIssueReasons`（按维度分组的低分原因字典，写法照 `reviewRejectReasons`）。
- `Meta.counts` 新增 `evals` / `evalsHuman`。
- `src/lib/config.ts` 新增：`EVAL_DIMENSIONS`、`DIMENSION_LABELS`、`DIMENSION_APPLIES_TO`、`SCORE_GRADES`（分档阈值 + 优良率口径）、`DIMENSION_WEIGHTS`（综合分权重）、`EVAL_COLORS`（维度固定配色，跨页面同维度同色，参照 `STAGE_COLORS`）。

**归属口径**：评测 `ts` 落在内容生成后，归因到**内容生成日**（不用曝光日——评测是生产侧行为）。此口径需写入 METRICS.md。

## 二、数据生成脚本 `scripts/generate_mock_data.py`

在 contents 生成循环内，为每条 content 生成评测（不新增独立循环，复用 `content_meta`）：

- **基线**：各维度独立正态/对数正态，均值按维度设定（relevance / readability / factuality 较高，visual / material 略低，av_sync 中等）；方差按内容类型区分（视频画面分方差更大）。
- **声画一致性**：仅 `CT-VIDEO` 打分，图文帖 `scores` 里不写该键。
- **人审抽样**：`HUMAN_REVIEW_RATE ≈ 0.09` 生成 `source='human'` 记录，分数为 auto 分 + 人工修正噪声（常态人机**分档一致率 ~88%**，即存在约 12% 的分歧样本）。
- **低分原因**：某维度分 < 70 时按该维度字典抽 1 个 reason 写入 `issues`。
- **质量 → 转化的耦合**：点击派生时乘质量系数 `ctr_factor = 0.72 + 0.56 * (综合分 / 100)`，让「质量 × CTR 关联分析」能得出真实结论而不是噪声。
- **新注入场景 SCEN-06**：`BAR-03` 汽车吧，`visual`（画面质量）维度在窗口内均分从基线骤降、不合格率翻倍（配 `SCEN06 = {bar, start, end, visual_penalty, fail_weight}`，写法照 SCEN01~05 + `in_window()`），并在 `ANOMALY_SCENARIOS` 里写入脚本实测的证据文案。
- 保持 `SEED` / `BASELINE_TIME` 不变；`mock_meta.json` 的 `notes` 补评测相关说明。

**副作用**：事件文件从 ~18.5MB 增至 ~21MB，README / AI_USAGE 里的数据体积与加载耗时必须按重新生成后的实测值改写。

## 三、指标层 `src/lib/metrics.ts`

- `buildContentIndex()` 扩展 `ContentIndex`：`evalByContent: Map<string, ContentEval[]>`（auto + human 各一条）。
- `selectData()` 扩展 `SelectedData.evals`：按既有「内容级集合收敛」范式用 `contentIds` 过滤，防口径串味。
- 新增聚合与分组函数（命名沿用现有 `xxxDist` / `xxxBreakdown` 风格）：
  - `evalAggregate(sel, index, dicts): EvalAgg` —— `overallScore`（内容级：适用维度按 `DIMENSION_WEIGHTS` 加权）、`gradeDist`（优/良/中/差）、`passRate`（优+良占比）、`humanSampled` / `humanAgreeRate`（auto 与 human **分档**一致率）、`dimAgg`（每维度 `mean / p10 / p90 / failCount / failRate / scored`，`scored=0` 时均分展示 `—`）。
  - `evalDailySeries()`、`evalDimensionBreakdown()`（含图文 vs 视频对比）、`evalCategoryHeatmap()`（Query 分类 × 维度）、`evalBarRows()`、`evalGradeConversion()`（按档位的 CTR / 调起成功率）、`evalLowScoreContents()`（Top N + issues，供下钻）。
- `src/lib/format.ts` 新增 `fmtScore(v: number | null)`（一位小数，分母为零返回 `—`）。
- `aggFromSelection` / `dailySeries` / `barBreakdown` 等既有函数保持不动，评测指标单独成块，避免污染已有 27 项测试的口径。

## 四、异常规则 R6 `anomalies.ts` + `config.ts`

`THRESHOLDS` 新增：`evalFailRateMax`、`evalScoreMin`、`evalAgreeRateMin`、`evalMinSamples`、`evalAgreeMinSamples`；`SEVERITY_ESCALATION` 新增对应的严重档。

R6 三个形态：
- **R6-1** 某维度不合格率超阈值（贴吧·日，样本量 ≥ `evalMinSamples`）；
- **R6-2** 区间综合质量分跌破 `evalScoreMin`；
- **R6-3** 人机一致率低于 `evalAgreeRateMin`。

`buildAnomalyDetail()` 增加 R6 分支：横向对比（各维度均分对比）、**低分原因分布**（`issues.reason` 分布，复用现有 `DistRow` 形态）、原始样例（`evalLowScoreContents()` 输出）、待验证假设、行动项。

**阈值标定**：沿用本项目已确立的「常态水位必须显著优于阈值 ≥3σ」原则。评测的日样本量充足（贴吧·日 约 200 条），余量好留，但**必须在重新生成数据后逐条复验异常清单，确保 0 条日常波动误报**——这是上一轮 R1/R3 踩过的坑。

## 五、UI

导航插入第 2 位（生产 → 评测 → 审核 → 分发，语义最顺）：
`内容供给 → AIGC内容评测 → 三层审核 → 分发与增长 → 异常监控 → 演示案例 → 指标口径`

新建：
- `src/components/EvalSection.tsx` —— 板块编排 + 7 个子模块（这是**全看板最大篇幅**，一个板块内含：评测总览小卡组 / 六维雷达图（图文 vs 视频叠加）/ 维度均分与 P10-P90 区间条 / 质量分与合格率日趋势 / Query 分类 × 维度热力图 / 各贴吧质量对比表 / 质量档位 × CTR 与调起成功率 / 低分内容 Top 20 表）。
- `src/components/EvalDetailPanel.tsx` —— 低分内容下钻抽屉内容，沿用 `AnomalyDetailPanel` 的 props 范式（`Drawer` + 分区块 + `.facts`）。

接线：`App.tsx` 的 `NAV` 加一项，`computed` 的 `useMemo` 里新增评测计算块（与 `anomalies` 一样基于当前 `sel` / `index`，保证下钻时不漂移）。

样式：**只复用现有 class**（`.card` / `.grid-2` / `.grid-3` / `.table-wrap` / `.data-table` / `.badge` / `.ratio-bar` / `.facts`），热力图单元格背景用 `COLORS` / `EVAL_COLORS` 常量插值，不硬编码色值，不新增全局样式。KPI 网格从 7 张变 8 张需确认 `.kpi-grid` 列数是否需微调。

## 六、测试

- `src/lib/testData.ts` 增加 `ContentEval` 夹具构造器（`makeEval(...)`）。
- `src/lib/metrics.test.ts` 新增约 12 项：分档边界（69.9 / 70 / 84.9 / 85）、图文帖排除 `av_sync`、合格率分母、人机一致率算法、综合分加权、日序列求和 = 汇总、分类热力图求和 = 汇总、档位 × CTR 关联、空样本返回 `null`。
- `src/lib/anomalies.test.ts` 新增约 5 项：R6 三形态触发、样本量保护、SCEN-06 窗口内触发 / 窗口外不触发。

## 七、文档

- `README.md`：新增「AIGC内容评测」功能章节、导航改 7 项、KPI 改 8 张、异常规则表补 R6、注入场景表补 SCEN-06、数据体积与加载耗时按实测改写。
- `METRICS.md`：新增评测指标口径（综合质量分算法 / 分档阈值 / 不适用维度处理 / 人机一致率算法 / 归属日期）+ R6 阈值。**⚠️ 必须重新生成 METRICS.pdf 并确认仍为 A4 一页**（上次为压回一页已收紧过版式，本次需再腾空间）。
- `AI_USAGE.md`：新增「第四轮：质量评测体系」提示词段（含 6 维选择理由、人机一致率的价值、评测与审核的分工），5.1 验证表补新数据规模与 R6 验收行。

## 八、实施顺序

1. `types.ts` → `config.ts` → 生成脚本加评测与 SCEN-06 → `npm run gen:data`，核对 meta counts 与文件体积；
2. `metrics.ts` 评测聚合 → `metrics.test.ts` 新增用例 → `npm test`；
3. `anomalies.ts` R6 + `buildAnomalyDetail` 分支 → `anomalies.test.ts` 新增用例 → **逐条复验异常清单，清零日常波动误报**；
4. `EvalSection` + `EvalDetailPanel` → `App.tsx` 接线 → KpiCards 加第 8 张；
5. 三份文档重写 → 重新生成两个 PDF（METRICS 必须 1 页）；
6. 终验：`npm run typecheck && npm test && npm run build` 全绿 + 真实浏览器逐屏检查（含抽屉下钻与热力图渲染、控制台 0 error）。

## 九、风险

- **JSON 体积 +3MB**：文档里的所有体积 / 耗时数字必须实测改写，不得沿用旧值。
- **R6 阈值误报**：小样本二项噪声的老坑，必须重新标定并逐条复验。
- **METRICS.pdf 一页约束**：新增一整节指标口径后可能超页，需同步精简措辞或再收一档版式。