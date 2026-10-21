# 业务场景重构：线下大屏互动 → 贴吧 AIGC 内容增长

## Context

当前看板的业务场景是「线下商场/景区 AIGC 互动大屏」：用户走到屏幕前参与互动，AI 生成个性化图片，再扫码保存或分享；运营人员监控大屏设备状态、活动效果与内容审核。

需要换成新场景：**贴吧侧用 AIGC 能力批量生成与用户搜索 Query 相关的图文帖/视频帖，经过机审→人审→质量审核三层把关后，分发到手百搜索结果页，用户点击后调起贴吧，推动贴吧用户增长**。目标读者从运营人员变为**贴吧增长产品经理**，看板名称保持「AIGC生成数据看板」不变。

**为什么这是完整重构而不是改文案**：旧场景的概念已渗透到数据模型底层——`Site`/`Device` 是核心实体，`Moderation` 是单层审核，`ScanEvent`/`ShareEvent` 承载线下转化，设备心跳还驱动了实时在线率与 R4 规则。只改文案会导致「文档说贴吧、图表画大屏」的割裂。

**已确认的决策**：完整重构；原「点位」→ 贴吧（主维度），原「设备」→ 内容类型（图文/视频），原「设备运行监控」区块 → 「分发与增长效果」；三层审核拆成三层独立指标与漏斗；曝光按聚合计数建模、点击与调起保持逐条事件。

**必须守住的项目特性**：全部指标从事件级原始数据派生（任何页面不写死结果）、异常详情保留六级证据下钻、固定随机种子可复现、25 项测试规模、三份文档与看板内容严格一致。

---

## 1. 数据模型（重写 src/types.ts）

### ID 关联链条

```
barId → queryId → generationTaskId → contentId → reviewId(stage: auto|manual|quality)
                                                    ↓
                                              distributeId → impressionStat(按日聚合) / clickEvent / jumpBackEvent
```

内容允许同一 Query 反复生产挑优，故 `taskId → contentId` 是 1:N，`Content` 带 `version`。

### 核心类型

| 类型 | 替代 | 关键字段 |
| --- | --- | --- |
| `Bar` | `Site` | `id, name, category（垂类）, tier(S/A/B/C), openedAt, dailyQueryBase` |
| `QueryDictItem` | 新增 | `id, name, category`（Query 意图分类） |
| `ContentType` | `Device` | `id('CT-IMG'/'CT-VIDEO'), name` |
| `QueryEvent` | `ParticipationEvent` | `eventId, ts, barId, queryId, userId`（搜索需求侧） |
| `GenerationTask` | 同名改造 | `taskId, ts, barId, queryId, contentType, userId, status, durationMs, failureReason` |
| `Content` | 同名改造 | `contentId, taskId, version, ts, barId, queryId, contentType` |
| `ReviewRecord` | `Moderation` | `reviewId, contentId, stage, ts, status, rejectReason, costMs` |
| `DistributeEvent` | 新增 | `distributeId, contentId, ts, barId, queryId, rankInPage, slot` |
| `ImpressionStat` | 新增（**聚合**） | `contentId, distributeId, day, rankInPage, impressions` |
| `ClickEvent` | 新增（逐条） | `eventId, ts, distributeId, contentId, barId, queryId` |
| `JumpBackEvent` | 新增（逐条） | `eventId, ts, contentId, barId, queryId, status, failReason` |

**删除**：`Site`、`Device`、`ParticipationEvent`、`ScanEvent`、`ShareEvent`、`Moderation`、`Heartbeats`；`Meta.heartbeat` 字段移除。`Meta.dictionaries` 改为 `queryCategories / contentTypes / reviewStages / reviewRejectReasons（按 stage 分组）/ failureReasons / jumpFailReasons / slotPositions`。

**重要修正**：不要在 `Content` 上存 `finalReviewPassed` 这类预计算布尔值——这违反「不写死结果」原则。三层总通过状态由 `buildContentIndex()` 在运行时从 `reviews` 派生。

---

## 2. 指标体系（重写 src/lib/metrics.ts）

### 顶部 7 张 KPI 卡（沿用现有卡片组件，仅换字段）

| # | 指标 | 口径（分子÷分母） |
| --- | --- | --- |
| 1 | 覆盖贴吧数 | 统计期内有内容产出的去重 `barId` 数 |
| 2 | AIGC 生成成功率 | `success ÷ (success + failed)`，pending 不入分母 |
| 3 | 三层审核总通过率 | 三关全通过内容数 ÷ 已发起审核内容数 |
| 4 | 分发内容量 | 审核全通过且已进入手百结果页的去重 `contentId` 数 |
| 5 | 搜索曝光量 | `ImpressionStat.impressions` 求和 |
| 6 | 搜索结果 CTR | `clicks ÷ impressions`，按 `distributeId` 去重 |
| 7 | 调起贴吧率 | `jump.success ÷ (success + failed)`，按 `contentId` 去重 |

分母为 0 一律返回 `null`，前端展示 `—`（沿用现有 `safeDiv`）。底部「相对上一可比周期」沿用 `previousRange` 逻辑。

### 四个区块

| 区块 | 图表 |
| --- | --- |
| **内容供给与生成质量** | 每日生成量柱+成功率折线；图文/视频分组对比；贴吧排名（带 CTR 标签）；贴吧明细表 |
| **三层审核流水线** | 三层漏斗（机审→人审→质量审核→可分发，每层标本层通过率与平均耗时）；每层拒绝率日趋势（3 线）；每层拒绝原因 Top（3 个独立字典）；各层 pending 积压趋势 |
| **分发与增长效果** | 分发漏斗（分发→曝光→点击→调起）；按 `rankInPage` 的 CTR 衰减曲线；贴吧 CTR/调起率对比；Query 分类×日期热度 |
| **异常监控与定位** | 沿用五规则 chip 过滤 + 列表 + 抽屉下钻 |

保留 `CaseSection`（重写为两个新案例）与 `MetricsNoteSection`。

### 函数层改造

- 新增：`barBreakdown`、`contentTypeBreakdown`、`reviewPipelineStats`（三层各自的 count/通过率/平均耗时/p95/积压）、`distributeFunnel`、`ctrByRank`、`crossBarDedupeNote`
- 删除：`computeDeviceStatuses`、`onlineSummary`、`operatingSlots`、`DeviceStatus`、`DeviceIncident`、`crossSiteDedupeNote`、`siteBreakdown`、`deviceBreakdown`
- 保留并改造：`aggregate`、`selectData`、`aggFromSelection`、`dailySeries`、`buildFunnel`、`failureReasonDist`、`rejectReasonDist`（改为按 stage 分组）、`durationHistogram`、`buildContentIndex`
- `styleRejectDist` 的「按当日大盘归一化 excessRate」方法学有价值，**改造为按 Query 分类维度的 excessRate** 保留下来

---

## 3. 异常规则（重写 src/lib/anomalies.ts + config.ts）

粒度统一为「贴吧·日」或「贴吧·区间」，阈值集中在 `THRESHOLDS`，严重度升级条件集中在 `SEVERITY_ESCALATION`。

| ID | 名称 | 判定 | 最小样本 | 升级为「严重」 |
| --- | --- | --- | --- | --- |
| R1 | 生成失败率异常 | 成功率 < 0.9 | 已完成 ≥ 20 | 成功率 < 0.8 |
| R2 | 平均生成时长异常 | 均值 > 12s | 成功 ≥ 20 | 均值 > 25s |
| R3 | 审核某环拒绝率飙升/积压 | 任一 stage 拒绝率 > 0.08 **或** pending > 50 | 进入该层 ≥ 20 | 拒绝率 > 0.2 / 积压 > 200 |
| R4 | Query 分类内容断供 | 某 queryCategory 连续 3 天日均产出 < 5 | 区间 ≥ 7 天 | 连续 5 天 |
| R5 | 搜索 CTR/调起率下滑 | CTR < 0.06 **或** 调起率 < 0.45 | 曝光 ≥ 500 | CTR < 0.02 / 调起率 < 0.20 |

每条规则的 `hypotheses`（明确标注「待验证假设」）与 `actions` 文案全部按新业务重写。下钻证据按 ruleId 分支渲染，继续保持：异常事实 → 对比证据 → 分布证据 → 原始样例 → 待验证假设 → 运营建议。

---

## 4. UI（重写 src/App.tsx 与区块组件）

- 状态：`siteId → barId`；`openDeviceId → openBar`；新增 `contentType` 筛选
- useMemo：删除 `statuses`/`deviceRows`，新增 `barRows`/`contentTypeBreakdown`/`reviewPipelineStats`/`distributeFunnel`/`ctrByRank`
- 导航四项改为：内容供给 / 审核流水线 / 分发增长 / 异常监控
- `ActivitySection.tsx` → 重写为 `SupplySection.tsx`
- `QualitySection.tsx` → 重写为 `ReviewSection.tsx`（三层审核）
- `DeviceSection.tsx` → 重写为 `DistributionSection.tsx`
- `DeviceDrawer.tsx` → 重写为 `BarDrawer.tsx`：贴吧下钻（基本信息 + 三层审核带 + 30 天产出趋势 + Top Query 表 + 关联异常 + 一键筛选到该贴吧）
- `KpiCards.tsx` / `FilterBar.tsx` / `AnomalySection.tsx` / `AnomalyDetailPanel.tsx` / `CaseSection.tsx`：改字段与文案
- `Drawer.tsx` / `ui.tsx` / `time.ts` / `format.ts`：基本不动

---

## 5. 模拟数据脚本（重写 scripts/generate_mock_data.py）

**字典**：6 个贴吧（如考研吧、摄影吧、汽车吧等，含 category 与 tier）；2 种内容类型；5 类 Query 意图分类；每类 12–20 个 Query 共约 80 个；三层各自的拒绝原因字典（机审：文本策略拦截/图像策略拦截/低俗/重复；人审：质量低/策略覆写/用户举报/品牌风险；质量审核：可读性不足/事实错误/无信息增量/语言质量）；生成失败原因（模型超时/服务异常/Query改写失败/素材检索为空）；调起失败原因（未装App/版本过低/网络失败/用户取消）。

**规模（对齐混合建模，控制体积在 ~22MB）**：`queryEvents` 7,000 · `generationTasks` 13,000 · `contents` 12,000 · `reviews` 32,400（机审 12,000 + 人审 10,800 + 质量审核 9,600，按串行关卡递減）· `distributes` 9,000 · `impressionStats` 38,000 · `clicks` 28,000 · `jumpBacks` 24,000。

**注入 5 个异常场景**（硬编码窗口，不用随机概率）：某贴吧模型超时导致失败率飙升；某贴吧视频帖生成变慢；某贴吧人审环节拒绝率飙升且集中在时事类 Query；某 Query 分类在考研吧连续断供；某贴吧 CTR 与调起率双降。

保持 `SEED` 固定并写入 `meta.seed`；输出 `mock_bars.json` / `mock_queries.json` / `mock_events.json` / `mock_meta.json`，删除 `mock_devices.json`、`mock_sites.json`、`mock_heartbeats.json`。

---

## 6. 测试（保持 25 项）

`metrics.test.ts` 16 项：三层审核通过率各测一次（pending 不入分母、零分母返回 null）· CTR 与调起率的内容级去重 · 跨贴吧用户去重 · 分发漏斗分层 · 日序列求和 = 汇总（覆盖 queryEvents/tasks/contents/reviews 分 stage）· 贴吧拆分求和 = 汇总 · 内容类型拆分求和 = 汇总 · Query 分类 excessRate · 上一可比周期为等长紧邻区间 · 审核积压不随日期筛选漂移。

`anomalies.test.ts` 9 项：阈值说明列表 · R1–R5 各自在注入窗口触发 · 未注入窗口不报严重 · 贴吧筛选生效 · 小样本不触发 R1。

---

## 7. 文件改动清单

**重写**：`src/types.ts`、`src/lib/metrics.ts`、`src/lib/config.ts`、`src/lib/anomalies.ts`、`scripts/generate_mock_data.py`、`src/App.tsx`、`README.md`、`METRICS.md`、`AI_USAGE.md`

**新增**：`src/components/SupplySection.tsx`、`ReviewSection.tsx`、`DistributionSection.tsx`、`BarDrawer.tsx`

**删除**：`src/components/ActivitySection.tsx`、`QualitySection.tsx`、`DeviceSection.tsx`、`DeviceDrawer.tsx`、`public/data/mock_sites.json`、`mock_devices.json`、`mock_heartbeats.json`

**小改**：`src/lib/data.ts`（加载新文件、新字典分组）、`KpiCards.tsx`、`FilterBar.tsx`、`AnomalySection.tsx`、`AnomalyDetailPanel.tsx`、`CaseSection.tsx`、`format.ts`、`AI_USAGE.md` 场景段落

**不动**：`src/lib/time.ts`、`src/lib/data.ts` 加载机制、`Drawer.tsx`、`ui.tsx`、`styles.css`、`vite.config.ts`、`vitest.config.ts`、`tsconfig.json`、`package.json`（脚本不变）、`index.html`（标题已是「AIGC生成数据看板」）

---

## 8. 实施顺序与验证

1. **数据层**：types → config → data.ts → 重写生成脚本 → `npm run gen:data`
   验证：核对 `mock_meta.json` 的 counts 与实际文件；抽样检查 ID 关联链条完整（内容能否找到三层审核、能否找到分发与点击）
2. **指标层 + 指标测试**：重写 metrics.ts → 重写 metrics.test.ts → `npm test` 通过
3. **异常层 + 异常测试**：重写 anomalies.ts → 重写 anomalies.test.ts → `npm test` 通过；逐条确认 R1–R5 在注入窗口触发且证据字段齐全
4. **UI 层**：App.tsx → 四个区块组件 → 两个抽屉 → `npm run dev` 人工核验
   验证：跨页面同一指标数值一致；切换贴吧/内容类型/日期后全部联动；R1–R5 各点开一次确认六级证据完整
5. **文档**：重写三份文档（README 不引用截图；旧业务截图已删除）
6. **终验**：`npm run typecheck && npm test && npm run build` 全绿；`METRICS.pdf` 控制在 A4 一页

**文档准确性要求**：README 里「约 10MB、1–2 秒加载」的描述必须以实测值改写，不得保留与新数据体积不符的旧数字；METRICS.md 的指标口径需与 metrics.ts 逐条对齐。