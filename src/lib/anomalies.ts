/**
 * 异常识别规则引擎
 *
 * 所有异常均由「模拟数据 + 规则阈值」动态计算，不在 UI 层写死。
 * 阈值集中定义在 src/lib/config.ts 的 THRESHOLDS，修改后全站生效。
 *
 * 规则一览：
 *  R1 贴吧·日   生成成功率 < 90%，且当日已完成生成尝试 >= 20 次
 *  R2 贴吧·日   平均生成时长 > 12s，且当日成功任务 >= 20 次
 *  R3 贴吧·日   三层审核中任一环节拒绝率 > 40% 或待审积压 > 50 条，且该环节处理 >= 20 条
 *  R4 贴吧·区间 某 Query 意图分类连续 3 天日均内容供给 < 5 条（区间 >= 7 天，且该分类在本吧至少覆盖 3 个 Query）
 *  R5 贴吧·区间 搜索 CTR < 6% 或调起贴吧成功率 < 45%，且曝光 >= 500（扩展演示规则）
 *  R6 贴吧·区间 评测维度不合格率 > 55% / 综合质量分 < 66 分 / 人机一致率 < 72%，且该维度打分 >= 200 条
 */

import type { Dataset, Filters, ReviewStage } from '../types';
import {
  DIMENSION_LABELS,
  EVAL_DIMENSIONS,
  REVIEW_STAGES,
  SEVERITY_ESCALATION,
  STAGE_LABELS,
  THRESHOLDS,
} from './config';
import {
  type Agg,
  type BarRow,
  type ContentIndex,
  type DistRow,
  type EvalBarRow,
  type SelectedData,
  aggregate,
  ctrByRank,
  durationHistogram,
  evalBarRows,
  evalIssueDist,
  evalLowScoreContents,
  failureReasonDist,
  jumpFailReasonDist,
  queryCategoryRejectDist,
  rejectReasonDist,
} from './metrics';
import { fmtScore } from './format';
import { dayKey, fullTs, rangeLength } from './time';
import type { Dicts } from './data';

export type RuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';
export type AnomalyCategory = '生成质量' | '内容审核' | '内容供给' | '分发转化' | '内容质量';
export type Severity = '严重' | '高' | '中';

export interface Anomaly {
  id: string;
  ruleId: RuleId;
  ruleName: string;
  category: AnomalyCategory;
  severity: Severity;
  /** 统计粒度，例如「贴吧·日」「贴吧·区间」 */
  granularity: string;
  /** 发生日期或统计区间 */
  periodLabel: string;
  day: string | null;
  barId: string | null;
  barName: string | null;
  /** 仅 R4 会带上 Query 意图分类 */
  queryCategory: string | null;
  metricName: string;
  actualText: string;
  thresholdText: string;
  sampleText: string;
  /** 待验证假设，不是已确认根因 */
  hypotheses: string[];
  actions: string[];
}

export interface AnomalyContext {
  ds: Dataset;
  sel: SelectedData;
  index: ContentIndex;
  filters: Filters;
  barRows: BarRow[];
  dicts: Dicts;
}

interface BarDayAgg {
  day: string;
  barId: string;
  agg: Agg;
}

function buildBarDayAggs(sel: SelectedData, index: ContentIndex): BarDayAgg[] {
  const map = new Map<string, SelectedData>();
  const get = (key: string): SelectedData => {
    let b = map.get(key);
    if (!b) {
      b = {
        queryEvents: [],
        tasks: [],
        contents: [],
        evals: [],
        distributes: [],
        impressionStats: [],
        clicks: [],
        jumpBacks: [],
        hasAnyData: true,
      };
      map.set(key, b);
    }
    return b;
  };

  for (const q of sel.queryEvents) get(`${dayKey(q.ts)}|${q.barId}`).queryEvents.push(q);
  for (const t of sel.tasks) get(`${dayKey(t.ts)}|${t.barId}`).tasks.push(t);
  for (const c of sel.contents) get(`${dayKey(c.ts)}|${c.barId}`).contents.push(c);
  for (const c of sel.clicks) get(`${dayKey(c.ts)}|${c.barId}`).clicks.push(c);
  for (const j of sel.jumpBacks) get(`${dayKey(j.ts)}|${j.barId}`).jumpBacks.push(j);
  for (const s of sel.impressionStats) {
    const dist = index.distById.get(s.distributeId);
    if (dist) get(`${s.day}|${dist.barId}`).impressionStats.push(s);
  }
  for (const d of sel.distributes) {
    const c = index.byId.get(d.contentId);
    if (c) get(`${dayKey(c.ts)}|${d.barId}`).distributes.push(d);
  }

  return [...map.entries()]
    .map(([key, bucket]) => {
      const [day, barId] = key.split('|');
      return { day, barId, agg: aggregate({ ...bucket, index }) };
    })
    .sort((a, b) =>
      a.day === b.day ? a.barId.localeCompare(b.barId) : a.day.localeCompare(b.day),
    );
}

const pct = (v: number | null, digits = 1): string =>
  v === null ? '—' : `${(v * 100).toFixed(digits)}%`;
const sec = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(2)}s`);

export function detectAnomalies(ctx: AnomalyContext): Anomaly[] {
  const { ds, sel, index, filters, barRows } = ctx;
  const barName = new Map(ds.bars.map((b) => [b.id, b.name]));
  const barDays = buildBarDayAggs(sel, index);
  const out: Anomaly[] = [];

  // ---------------- R1 / R2 / R3：贴吧·日 ----------------
  for (const bd of barDays) {
    const name = barName.get(bd.barId) ?? bd.barId;

    // R1 生成成功率
    if (
      bd.agg.completedTasks >= THRESHOLDS.genSuccessRateMinSamples &&
      bd.agg.successRate !== null &&
      bd.agg.successRate < THRESHOLDS.genSuccessRateMin
    ) {
      const critical = bd.agg.successRate < SEVERITY_ESCALATION.genSuccessRateCritical;
      out.push({
        id: `R1-${bd.barId}-${bd.day}`,
        ruleId: 'R1',
        ruleName: 'AIGC 生成成功率低于阈值',
        category: '生成质量',
        severity: critical ? '严重' : '高',
        granularity: '贴吧·日',
        periodLabel: bd.day,
        day: bd.day,
        barId: bd.barId,
        barName: name,
        queryCategory: null,
        metricName: 'AIGC 生成成功率',
        actualText: pct(bd.agg.successRate),
        thresholdText: `≥ ${pct(THRESHOLDS.genSuccessRateMin, 0)}`,
        sampleText: `已完成生成尝试 ${bd.agg.completedTasks} 次（成功 ${bd.agg.tasksSuccess} / 失败 ${bd.agg.tasksFailed}）`,
        hypotheses: [
          '待验证假设 A：该贴吧命中的某类 Query 素材检索为空，导致改写与生成链路大面积失败。',
          '待验证假设 B：生成模型服务在该时段扩容不足，请求排队后被服务端超时放弃。',
          '待验证假设 C：该贴吧近期上调了生产配额，触发上游模型服务的限流策略。',
        ],
        actions: [
          `在「内容供给」中筛选 ${name}，对比图文与视频两种内容类型的成功率，定位失败是否集中在某一形态。`,
          '查看该日失败原因分布：若以「模型推理超时」为主，升级为服务端容量问题并同步研发；若以「素材检索为空」为主，先修 Query 侧的素材召回。',
          '抽取失败任务的 Query 样例，确认是否集中在某一类搜索意图上。',
          '在异常窗口结束后复核成功率是否回到基线，确认处置有效。',
        ],
      });
    }

    // R2 平均生成时长
    if (
      bd.agg.tasksSuccess >= THRESHOLDS.avgDurationMinSamples &&
      bd.agg.avgDurationMs !== null &&
      bd.agg.avgDurationMs > THRESHOLDS.avgDurationMaxMs
    ) {
      const critical = bd.agg.avgDurationMs > SEVERITY_ESCALATION.avgDurationCriticalMs;
      out.push({
        id: `R2-${bd.barId}-${bd.day}`,
        ruleId: 'R2',
        ruleName: '平均生成时长超过阈值',
        category: '生成质量',
        severity: critical ? '严重' : '高',
        granularity: '贴吧·日',
        periodLabel: bd.day,
        day: bd.day,
        barId: bd.barId,
        barName: name,
        queryCategory: null,
        metricName: '平均生成时长',
        actualText: sec(bd.agg.avgDurationMs),
        thresholdText: `≤ ${(THRESHOLDS.avgDurationMaxMs / 1000).toFixed(0)}s`,
        sampleText: `成功任务 ${bd.agg.tasksSuccess} 次，其中高延迟 ${bd.agg.slowTaskCount} 次（P95 ${sec(bd.agg.p95DurationMs)}）`,
        hypotheses: [
          '待验证假设 A：视频帖渲染算力需求高于图文帖，该日视频占比上升拉高了均值（若耗时集中在视频）。',
          '待验证假设 B：生成模型服务排队时长上升，与生产配额或并发调整有关。',
          '待验证假设 C：该贴吧素材体积整体偏大，编码与合成阶段变慢。',
        ],
        actions: [
          '先按内容类型拆分耗时：若只有视频变慢、图文正常，属内容结构问题，按供给配比调整即可；若两类同时变慢，升级为服务端容量问题。',
          '查看耗时分桶判断是整体变慢还是长尾变慢：长尾远高于均值时优先优化排队策略。',
          '查看同期全吧平均耗时，若同步抬升说明与单个贴吧无关。',
          '复核处置后该吧的 P95 时长是否回落。',
        ],
      });
    }

    // R3 三层审核任一环节拒绝率飙升 / 积压
    for (const stage of REVIEW_STAGES) {
      const sa = bd.agg.stages[stage];
      if (sa.entered < THRESHOLDS.reviewMinSamples) continue;
      const rejectHigh = sa.rejectRate !== null && sa.rejectRate > THRESHOLDS.reviewRejectRateMax;
      const backlogHigh = sa.pending > THRESHOLDS.reviewPendingMaxCount;
      if (!rejectHigh && !backlogHigh) continue;

      const label = STAGE_LABELS[stage];
      const criticalReject = sa.rejectRate !== null && sa.rejectRate > SEVERITY_ESCALATION.reviewRejectRateCritical;
      const criticalBacklog = sa.pending > SEVERITY_ESCALATION.reviewPendingCriticalCount;
      const critical = criticalReject || criticalBacklog;

      // 同一环节同一贴吧同一天只报一次，优先反映拒绝率问题
      const isRejectType = rejectHigh;
      out.push({
        id: `R3-${bd.barId}-${daySuffix(stage)}-${bd.day}`,
        ruleId: 'R3',
        ruleName: rejectHigh ? `${label}环节拒绝率飙升` : `${label}环节审核积压`,
        category: '内容审核',
        severity: critical ? '严重' : '高',
        granularity: '贴吧·日',
        periodLabel: bd.day,
        day: bd.day,
        barId: bd.barId,
        barName: name,
        queryCategory: null,
        metricName: `${label}拒绝率`,
        actualText: isRejectType ? pct(sa.rejectRate) : `${sa.pending} 条待审`,
        thresholdText: isRejectType
          ? `≤ ${pct(THRESHOLDS.reviewRejectRateMax, 0)}`
          : `≤ ${THRESHOLDS.reviewPendingMaxCount} 条待审`,
        sampleText: `${label}处理 ${sa.entered} 条（通过 ${sa.pass} / 拒绝 ${sa.reject} / 待审 ${sa.pending}），平均耗时 ${sec(sa.avgCostMs)}`,
        hypotheses: [
          `待验证假设 A：本次只在该环节出现，${label}规则或人力近期有调整，需要先确认是否是策略变更导致的正常波动。`,
          `待验证假设 B：该贴吧的内容供给结构变化（如新增某类 Query），更容易触发${label}的拒绝标准。`,
          `待验证假设 C：${label}存在系统性误杀，把合格内容也拦了下来，压制了该贴吧的可分发量。`,
        ],
        actions: [
          `先确认是哪个环节：打开「三层审核流水线」对比机审 / 人审 / 质量审核三段的通过率，只有${label}异常时问题定位在该环节内部。`,
          `查看${label}拒绝原因分布：若集中在单一原因，优先修策略或提示词；若分布均匀，考虑${label}标准过严。`,
          rejectHigh
            ? '抽取被拒内容样例人工复核，区分真实问题与误杀，误杀样本反馈给审核策略侧。'
            : '评估审核人力是否到位，必要时临时扩容或将该环节部分抽样转自动策略处理。',
          '复核处置后该环节的通过率与待审积压是否同时回落到基线。',
        ],
      });
    }
  }

  // ---------------- R4：Query 意图分类内容断供（贴吧·区间） ----------------
  if (rangeLength(filters.range) >= THRESHOLDS.querySupplyMinRangeDays) {
    for (const row of barRows) {
      if (!row.barId) continue;
      const perCat = new Map<string, Map<string, number>>();
      const queryCountByCat = new Map<string, Set<string>>();
      for (const c of sel.contents) {
        if (c.barId !== row.barId) continue;
        const cat = index.queryById.get(c.queryId)?.category ?? 'UNKNOWN';
        let days = perCat.get(cat);
        if (!days) {
          days = new Map();
          perCat.set(cat, days);
          queryCountByCat.set(cat, new Set());
        }
        queryCountByCat.get(cat)?.add(c.queryId);
        const d = dayKey(c.ts);
        days.set(d, (days.get(d) ?? 0) + 1);
      }

      const sortedDays = [...new Set(sel.contents.map((c) => dayKey(c.ts)))].sort();
      for (const [cat, days] of perCat) {
        // 只有 1 个 Query 覆盖的分类天然产不出量，属结构性低产而非断供
        if ((queryCountByCat.get(cat)?.size ?? 0) < THRESHOLDS.querySupplyMinQueries) continue;
        // 找出从区间尾部往回连续低于供给下限的天数
        let breakLen = 0;
        for (let i = sortedDays.length - 1; i >= 0; i -= 1) {
          const v = days.get(sortedDays[i]) ?? 0;
          if (v < THRESHOLDS.querySupplyMin) breakLen += 1;
          else break;
        }
        if (breakLen < THRESHOLDS.querySupplyBreakDays) continue;

        const critical = breakLen >= SEVERITY_ESCALATION.querySupplyBreakDaysCritical;
        const catName = ctx.dicts.queryCategories.get(cat) ?? cat;
        const recentDays = sortedDays.slice(-breakLen);
        const baselineDays = sortedDays.slice(Math.max(0, sortedDays.length - breakLen - 7), -breakLen);
        const baselineAvg =
          baselineDays.length > 0
            ? baselineDays.reduce((s, d) => s + (days.get(d) ?? 0), 0) / baselineDays.length
            : 0;

        out.push({
          id: `R4-${row.barId}-${cat}`,
          ruleId: 'R4',
          ruleName: 'Query 分类内容断供',
          category: '内容供给',
          severity: critical ? '严重' : '高',
          granularity: '贴吧·区间',
          periodLabel: `${recentDays[0]} ~ ${recentDays[recentDays.length - 1]}`,
          day: recentDays[recentDays.length - 1],
          barId: row.barId,
          barName: row.barName,
          queryCategory: cat,
          metricName: `${catName}日均内容供给`,
          actualText: `连续 ${breakLen} 天 < ${THRESHOLDS.querySupplyMin} 条/天`,
          thresholdText: `≥ ${THRESHOLDS.querySupplyMin} 条/天`,
          sampleText: `断供前日均约 ${baselineAvg.toFixed(1)} 条，断供期间日均 ${(recentDays.reduce((s, d) => s + (days.get(d) ?? 0), 0) / breakLen).toFixed(1)} 条`,
          hypotheses: [
            `待验证假设 A：${catName}类 Query 的素材库或提示词模板被下架，生产链路对该分类直接跳过。`,
            `待验证假设 B：该分类的生产配额被临时调整给其他 Query 分类（需确认调度配置变更记录）。`,
            `待验证假设 C：${catName}类内容近期审核标准收紧，前一道审核环节拒绝率上升导致供给被截断（需回看 R3）。`,
          ],
          actions: [
            `在「三层审核流水线」查看该分类的机审通过率：若偏低，说明是被审核卡住的「假断供」，应先修审核策略。`,
            `若机审正常，则为真实供给缺口：核对${catName}的素材召回与提示词模板是否可用。`,
            `恢复供给后连续观察 3 天日均产出是否回到 ${THRESHOLDS.querySupplyMin} 条以上。`,
            '断供期间该分类在手百搜索结果页的存量内容会逐步失去曝光，建议评估是否需要临时回补存量。',
          ],
        });
      }
    }
  }

  // ---------------- R5：搜索 CTR / 调起率下滑（贴吧·区间） ----------------
  for (const row of barRows) {
    if (!row.barId) continue;
    if (row.agg.impressions < THRESHOLDS.ctrMinImpressions) continue;
    const ctrLow = row.agg.ctr !== null && row.agg.ctr < THRESHOLDS.ctrMin;
    const jumpLow = row.agg.jumpRate !== null && row.agg.jumpRate < THRESHOLDS.jumpRateMin;
    if (!ctrLow && !jumpLow) continue;

    const criticalCtr = row.agg.ctr !== null && row.agg.ctr < SEVERITY_ESCALATION.ctrCritical;
    const criticalJump =
      row.agg.jumpRate !== null && row.agg.jumpRate < SEVERITY_ESCALATION.jumpRateCritical;
    const overall = barRows.length > 0 ? overallOf(barRows) : null;

    out.push({
      id: `R5-${row.barId}`,
      ruleId: 'R5',
      ruleName: ctrLow ? '搜索结果 CTR 显著下滑' : '调起贴吧成功率显著下滑',
      category: '分发转化',
      severity: criticalCtr || criticalJump ? '严重' : '中',
      granularity: '贴吧·区间',
      periodLabel: `${filters.range.startDate} ~ ${filters.range.endDate}`,
      day: null,
      barId: row.barId,
      barName: row.barName,
      queryCategory: null,
      metricName: ctrLow ? '搜索结果 CTR' : '调起贴吧成功率',
      actualText: ctrLow ? pct(row.agg.ctr) : pct(row.agg.jumpRate),
      thresholdText: ctrLow ? `≥ ${pct(THRESHOLDS.ctrMin, 0)}` : `≥ ${pct(THRESHOLDS.jumpRateMin, 0)}`,
      sampleText: `曝光 ${row.agg.impressions.toLocaleString()} 次 / 分发 ${row.agg.distributedContents} 条；CTR ${pct(row.agg.ctr)}，调起率 ${pct(row.agg.jumpRate)}（全吧 CTR ${pct(overall?.ctr ?? null)}）`,
      hypotheses: ctrLow
        ? [
            '待验证假设 A：该贴吧内容的搜索结果展示位次整体靠后，用户在首屏看不到（需看位次 CTR 衰减曲线）。',
            '待验证假设 B：标题与摘要模板对该贴吧的 Query 不适配，点击吸引力弱于其他吧。',
            '待验证假设 C：同类 Query 下，该贴吧的内容供给量不足，用户看到的是低质存量内容。',
          ]
        : [
            '待验证假设 A：点击后调起贴吧的链路失败率上升，需看调起失败原因分布。',
            '待验证假设 B：该贴吧的用户以未安装贴吧 App 的手百用户为主，跳转承接能力不足。',
            '待验证假设 C：内容落地页加载过慢，用户在调起完成前流失。',
          ],
      actions: ctrLow
        ? [
            `在「分发与增长」中查看 ${row.barName} 的位次 CTR 衰减：若低位次的 CTR 与高位次接近，说明不是位次问题，而是内容本身吸引力不足。`,
            '抽取该吧在搜索结果页的标题与摘要样例，与 CTR 高的吧做对照，定位文案模板差异。',
            '若该吧内容供给量偏低，优先补量而非继续调优——搜索结果页内容太少会同时拉低曝光与点击。',
            '做一次小流量 A/B：更换标题模板后观察 3 天 CTR 是否回升。',
          ]
        : [
            `查看 ${row.barName} 的调起失败原因分布：若以「未安装贴吧 App」为主，属于用户构成问题，应推动落地页的 App 安装引导。`,
            '若以「网络失败」或「App 版本过低」为主，联合客户端与服务端排查跳转链路。',
            '核对点击到调起之间是否有落地页加载阻塞，必要时做加载优化或降级。',
            '处置后观察调起率是否回到基线，并同步复核 CTR 是否受影响。',
          ],
    });
  }

  // ---------------- R6：AIGC 内容质量异常（贴吧·区间） ----------------
  // 判定粒度必须是「贴吧·区间」而非「贴吧·日」：批量生产里某一维度不合格本就是常态，
  // 每吧每天只有 20~45 条内容，日粒度的二项噪声足以把不合格率打到阈值线上；
  // 区间样本 200+ 时噪声仅约 1.5%，才能把「常态波动」与「真的劣化」区分开。
  const evalRows = evalBarRows(ds, sel, index);
  // 同一维度可能多个吧同时越线，只对表现最差的那个吧告警，避免一个问题重复报 6 次
  const worstBarByDim = new Map<string, EvalBarRow>();
  for (const r of evalRows) {
    for (const d of r.agg.dimAgg) {
      const cur = worstBarByDim.get(d.dim);
      if (!cur || (d.failRate ?? 0) > (cur.agg.dimAgg.find((x) => x.dim === d.dim)?.failRate ?? 0)) {
        worstBarByDim.set(d.dim, r);
      }
    }
  }

  for (const row of evalRows) {
    if (!row.barId) continue;
    const period = `${filters.range.startDate} ~ ${filters.range.endDate}`;
    const gradeDist = row.agg.gradeDist;

    // R6-1 维度不合格率超标
    for (const d of row.agg.dimAgg) {
      if (d.scored < THRESHOLDS.evalMinSamples) continue;
      if (d.failRate === null || d.failRate <= THRESHOLDS.evalFailRateMax) continue;
      if (worstBarByDim.get(d.dim)?.barId !== row.barId) continue;

      const critical = d.failRate > SEVERITY_ESCALATION.evalFailRateCritical;
      const others = evalRows
        .filter((r) => r.barId !== row.barId)
        .map((r) => r.agg.dimAgg.find((x) => x.dim === d.dim)?.failRate ?? null)
        .filter((v): v is number => v !== null);
      const peerMax = others.length > 0 ? Math.max(...others) : null;

      out.push({
        id: `R6-${row.barId}-${d.dim}`,
        ruleId: 'R6',
        ruleName: `${d.label}维度不合格率偏高`,
        category: '内容质量',
        severity: critical ? '严重' : '高',
        granularity: '贴吧·区间',
        periodLabel: period,
        day: null,
        barId: row.barId,
        barName: row.barName,
        queryCategory: null,
        metricName: `${d.label}不合格率`,
        actualText: pct(d.failRate),
        thresholdText: `≤ ${pct(THRESHOLDS.evalFailRateMax, 0)}`,
        sampleText: `${row.barName} 该维度打分 ${d.scored} 条内容，不合格 ${d.failCount} 条（均分 ${fmtScore(d.mean)}，P10 ${fmtScore(d.p10)} / P90 ${fmtScore(d.p90)}）；其余贴吧该维度最高 ${pct(peerMax)}`,
        hypotheses: evalDimHypotheses(d.dim),
        actions: evalDimActions(row.barName, d.label),
      });
    }

    // R6-2 区间综合质量分低于下限
    if (
      row.agg.evaluated >= THRESHOLDS.evalMinSamples &&
      row.agg.overallScore !== null &&
      row.agg.overallScore < THRESHOLDS.evalScoreMin
    ) {
      const critical = row.agg.overallScore < SEVERITY_ESCALATION.evalScoreCritical;
      out.push({
        id: `R6-${row.barId}-score`,
        ruleId: 'R6',
        ruleName: 'AIGC 综合质量分低于阈值',
        category: '内容质量',
        severity: critical ? '严重' : '高',
        granularity: '贴吧·区间',
        periodLabel: period,
        day: null,
        barId: row.barId,
        barName: row.barName,
        queryCategory: null,
        metricName: '综合质量分',
        actualText: fmtScore(row.agg.overallScore),
        thresholdText: `≥ ${THRESHOLDS.evalScoreMin} 分`,
        sampleText: `评测 ${row.agg.evaluated} 条内容，达标率 ${pct(row.agg.passRate)}；分档 优 ${gradeDist[0]} / 良 ${gradeDist[1]} / 中 ${gradeDist[2]} / 差 ${gradeDist[3]}`,
        hypotheses: [
          '待验证假设 A：该贴吧命中的某类 Query 本身就难写（如需要具体数值或时效性强的政策类），模型产出质量天花板低。',
          '待验证假设 B：生成提示词模板在该吧未做适配，仍在套用通用模板。',
          '待验证假设 C：素材召回质量下滑，模型只能基于低质素材硬编，质量分被素材维度拖累。',
        ],
        actions: [
          `在「AIGC 内容评测」查看 ${row.barName} 的维度画像：先确认是单一维度拖累还是全面下滑。`,
          '若为「内容-Query 符合度」拖累，属提示词问题：抽取该吧低分内容样例，回看模型是否真的回答了 Query 的核心问题。',
          '若为感官维度（画面 / 素材）拖累，属素材问题：优先修素材召回，不必改生成模型。',
          '处置后连续观察 3 天综合质量分是否回到阈值以上。',
        ],
      });
    }

    // R6-3 人机一致率过低：说明自动评测本身不可信，质量看板失去判别力
    if (
      row.agg.humanSampled >= THRESHOLDS.evalAgreeMinSamples &&
      row.agg.humanAgreeRate !== null &&
      row.agg.humanAgreeRate < THRESHOLDS.evalAgreeRateMin
    ) {
      const critical = row.agg.humanAgreeRate < SEVERITY_ESCALATION.evalAgreeRateCritical;
      out.push({
        id: `R6-${row.barId}-agree`,
        ruleId: 'R6',
        ruleName: '自动评测与人工复核一致率过低',
        category: '内容质量',
        severity: critical ? '严重' : '中',
        granularity: '贴吧·区间',
        periodLabel: period,
        day: null,
        barId: row.barId,
        barName: row.barName,
        queryCategory: null,
        metricName: '人机分档一致率',
        actualText: pct(row.agg.humanAgreeRate),
        thresholdText: `≥ ${pct(THRESHOLDS.evalAgreeRateMin, 0)}`,
        sampleText: `抽样复核 ${row.agg.humanSampled} 条内容，其中分档一致 ${row.agg.humanAgree} 条`,
        hypotheses: [
          '待验证假设 A：该吧的内容形态（如大量视频帖）超出当前评测模型的判别能力，感官维度打分不稳定。',
          '待验证假设 B：评测模型在该吧的 Query 类型上存在系统性偏差（如把简答当简答、把时效类当知识类）。',
          '待验证假设 C：人工复核标准与评测模型的档位阈值本身没有对齐，差异来自口径而非能力。',
        ],
        actions: [
          '抽取人机分档不一致的样例，人工确认是模型判错还是人审判错，先分清责任方再动手。',
          '若不一致集中在某一维度（通常是画面或声画一致性），优先补充该维度的评测样本与标注规范。',
          '核对人审与评测模型是否使用同一套档位阈值；口径不一致时先统一口径。',
          '若确认为模型能力不足，考虑对该形态提升人工抽样比例，或改用专用评测模型。',
        ],
      });
    }
  }

  const order: Record<Severity, number> = { 严重: 0, 高: 1, 中: 2 };
  return out.sort((a, b) => {
    if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
    return (b.periodLabel ?? '').localeCompare(a.periodLabel ?? '');
  });
}

function daySuffix(stage: ReviewStage): string {
  return stage === 'auto' ? 'a' : stage === 'manual' ? 'm' : 'q';
}

/** R6-1 的假设文案按维度区分：感官维度、语义维度的排查方向完全不同 */
function evalDimHypotheses(dim: string): string[] {
  const common: string[] = [
    '待验证假设 C：该维度打分口径与实际生产口径不一致（例如素材库已换源但评测仍按旧库判定）。',
  ];
  if (dim === 'visual') {
    return [
      '待验证假设 A：视频生成的画面渲染链路劣化（后处理降级、码率压制或转码参数被改），属生产侧问题而非模型问题。',
      '待验证假设 B：素材源本身清晰度下降，模型只能基于低质素材做画面。',
      common[0],
    ];
  }
  if (dim === 'av_sync') {
    return [
      '待验证假设 A：TTS 语音与字幕轨的时间戳对齐逻辑被改动，出现整体偏移。',
      '待验证假设 B：背景音乐轨的音量包络异常，人声被压住导致评测模型判为声画不同步。',
      common[0],
    ];
  }
  if (dim === 'relevance') {
    return [
      '待验证假设 A：该贴吧命中的 Query 语义漂移（如从经验类滑向时效类），但提示词模板仍按原意图生成。',
      '待验证假设 B：Query 改写环节的召回变差，模型拿到的是泛化后的宽泛主题而非原问题。',
      common[0],
    ];
  }
  if (dim === 'material') {
    return [
      '待验证假设 A：素材检索服务召回质量下降，配图与正文主题无关或重复度升高。',
      '待验证假设 B：素材审核规则近期收紧，可用的合规素材池变小，模型被迫降级选图。',
      common[0],
    ];
  }
  if (dim === 'readability') {
    return [
      '待验证假设 A：篇幅控制参数被上调，模型倾向写长文导致重点不突出。',
      '待验证假设 B：结构化模板失效，行文退化为无小标题、无步骤的长段落。',
      common[0],
    ];
  }
  return [
    '待验证假设 A：内容引用了时效性强的事实，模型未接入时效检索导致数据过期或错误。',
    '待验证假设 B：事实性约束在提示词中被弱化，模型开始自由发挥。',
    common[0],
  ];
}

function evalDimActions(barName: string, dimLabel: string): string[] {
  return [
    `在「AIGC 内容评测」的维度画像中确认 ${barName} 是否只有「${dimLabel}」异常：单维异常指向该维度的专属链路，全面异常才考虑生成模型本身。`,
    `查看「${dimLabel}」的低分原因分布：原因集中指向单一环节时直接修该环节，不要笼统归因到模型。`,
    '抽取该维度最低分的 5~10 条内容人工复核，区分真实劣化与评测模型误判。',
    '处置后连续观察 3 天该维度不合格率是否回落到阈值以内。',
  ];
}

function overallOf(rows: BarRow[]): { ctr: number | null } {
  // 各分吧数据互不重叠，直接求和即可还原全站口径
  let imp = 0;
  let clicks = 0;
  for (const r of rows) {
    imp += r.agg.impressions;
    clicks += r.agg.clicks;
  }
  return { ctr: imp > 0 ? clicks / imp : null };
}

// ---------------------------------------------------------------------------
// 异常详情（证据下钻）
// ---------------------------------------------------------------------------

export interface ComparisonRow {
  name: string;
  valueText: string;
  value: number | null;
  highlight: boolean;
  note?: string;
}

export interface SampleTable {
  title: string;
  columns: string[];
  rows: string[][];
}

export interface AnomalyDetail {
  facts: { label: string; value: string }[];
  comparison: { title: string; note: string; rows: ComparisonRow[] } | null;
  distribution: { title: string; note: string; rows: DistRow[] } | null;
  samples: SampleTable | null;
  relatedRuleText: string;
}

export function buildAnomalyDetail(a: Anomaly, ctx: AnomalyContext): AnomalyDetail {
  const { sel, index, dicts, filters, barRows } = ctx;
  const facts: { label: string; value: string }[] = [
    { label: '异常类型', value: `${a.ruleId} ${a.ruleName}` },
    { label: '严重程度', value: a.severity },
    { label: '统计粒度', value: a.granularity },
    { label: '发生日期 / 区间', value: a.periodLabel },
    { label: '涉及贴吧', value: a.barName ?? '—' },
    ...(a.queryCategory
      ? [{ label: 'Query 分类', value: dicts.queryCategories.get(a.queryCategory) ?? a.queryCategory }]
      : []),
    { label: a.metricName, value: `${a.actualText}（阈值 ${a.thresholdText}）` },
    { label: '样本量', value: a.sampleText },
  ];

  const empty: AnomalyDetail = {
    facts,
    comparison: null,
    distribution: null,
    samples: null,
    relatedRuleText: '',
  };

  const barId = a.barId;
  if (!barId) return empty;
  const day = a.day;
  const inDay = (ts: string) => day === null || dayKey(ts) === day;

  const scopedTasks = sel.tasks.filter((t) => t.barId === barId && inDay(t.ts));
  const scopedContents = sel.contents.filter((c) => c.barId === barId && inDay(c.ts));
  const scopedSel: SelectedData = { ...sel, tasks: scopedTasks, contents: scopedContents };

  if (a.ruleId === 'R1') {
    const rows: ComparisonRow[] = barRows.map((r) => ({
      name: r.barName,
      valueText: pct(r.agg.successRate),
      value: r.agg.successRate,
      highlight: r.barId === barId,
      note: `完成 ${r.agg.completedTasks} 次 / 失败 ${r.agg.tasksFailed} 次`,
    }));
    const dist = failureReasonDist(scopedSel, dicts.failureReasons);
    const failed = scopedTasks
      .filter((t) => t.status === 'failed')
      .slice(0, 8)
      .map((t) => [
        t.taskId,
        fullTs(t.ts),
        dicts.contentTypes.get(t.contentType) ?? t.contentType,
        dicts.failureReasons.get(t.failureReason ?? '') ?? '—',
      ]);
    return {
      facts,
      comparison: {
        title: `${a.barName} · ${a.periodLabel} 与全部分吧的生成成功率对比`,
        note: '若只有该吧下滑，优先排查该吧的素材与模板；若全部分吧同步下滑，升级为模型服务容量问题。',
        rows: rows.sort((x, y) => (x.value ?? 1) - (y.value ?? 1)),
      },
      distribution: {
        title: `${a.barName} 该日生成失败原因分布`,
        note: '失败原因直接来自原始任务记录',
        rows: dist,
      },
      samples: {
        title: '失败任务原始样例（最多 8 条）',
        columns: ['任务 ID', '发生时间', '内容类型', '失败原因'],
        rows: failed,
      },
      relatedRuleText: `规则 R1：生成成功率 < ${pct(THRESHOLDS.genSuccessRateMin, 0)} 且当日已完成生成尝试 ≥ ${THRESHOLDS.genSuccessRateMinSamples} 次。`,
    };
  }

  if (a.ruleId === 'R2') {
    const rows: ComparisonRow[] = barRows.map((r) => ({
      name: r.barName,
      valueText: sec(r.agg.avgDurationMs),
      value: r.agg.avgDurationMs,
      highlight: r.barId === barId,
      note: `成功 ${r.agg.tasksSuccess} 次 / P95 ${sec(r.agg.p95DurationMs)}`,
    }));
    const hist = durationHistogram(scopedTasks).map((h) => ({
      key: h.bucket,
      label: h.bucket,
      value: h.count,
      percent: null,
    }));
    const slowest = scopedTasks
      .filter((t) => t.status === 'success' && t.durationMs !== null)
      .sort((x, y) => (y.durationMs ?? 0) - (x.durationMs ?? 0))
      .slice(0, 8)
      .map((t) => [
        t.taskId,
        fullTs(t.ts),
        dicts.contentTypes.get(t.contentType) ?? t.contentType,
        sec(t.durationMs),
      ]);
    return {
      facts,
      comparison: {
        title: `${a.barName} · ${a.periodLabel} 与全部分吧的平均生成时长对比`,
        note: '全部分吧同步抬升指向模型服务；单吧抬升优先看该吧的图文 / 视频供给结构。',
        rows: rows.sort((x, y) => (y.value ?? 0) - (x.value ?? 0)),
      },
      distribution: {
        title: `${a.barName} 该日成功任务耗时分桶`,
        note: '用于判断是整体变慢还是长尾变慢',
        rows: hist,
      },
      samples: {
        title: '耗时最长的成功任务样例',
        columns: ['任务 ID', '发生时间', '内容类型', '耗时'],
        rows: slowest,
      },
      relatedRuleText: `规则 R2：平均生成时长 > ${(THRESHOLDS.avgDurationMaxMs / 1000).toFixed(0)}s 且当日成功任务 ≥ ${THRESHOLDS.avgDurationMinSamples} 次。`,
    };
  }

  if (a.ruleId === 'R3') {
    const stageLabel = a.metricName.replace('拒绝率', '');
    const stage = (['auto', 'manual', 'quality'] as ReviewStage[]).find(
      (s) => STAGE_LABELS[s] === stageLabel,
    );
    if (!stage) return empty;

    // 三个环节横向对比：一眼看出是哪一环出问题
    const pipelineRows: ComparisonRow[] = REVIEW_STAGES.map((s) => {
      const sa = sel.contents
        .filter((c) => c.barId === barId && inDay(c.ts))
        .map((c) => index.reviewByContent.get(c.contentId)?.byStage[s])
        .filter((r): r is NonNullable<typeof r> => r !== undefined);
      const pass = sa.filter((r) => r.status === 'pass').length;
      const reviewed = sa.filter((r) => r.status !== 'pending').length;
      return {
        name: STAGE_LABELS[s],
        valueText: pct(reviewed > 0 ? pass / reviewed : null),
        value: reviewed > 0 ? pass / reviewed : null,
        highlight: s === stage,
        note: `处理 ${sa.length} 条 / 待审 ${sa.filter((r) => r.status === 'pending').length} 条`,
      };
    });

    const dist = rejectReasonDist(scopedSel, index, stage, dicts.reviewRejectReasons[stage]);
    const rejected = scopedContents
      .map((c) => index.reviewByContent.get(c.contentId)?.byStage[stage])
      .filter((r): r is NonNullable<typeof r> => r?.status === 'reject')
      .slice(0, 8)
      .map((r) => {
        const c = index.byId.get(r.contentId);
        const q = c ? index.queryById.get(c.queryId) : undefined;
        return [
          r.contentId,
          fullTs(r.ts),
          dicts.contentTypes.get(c?.contentType ?? '') ?? c?.contentType ?? '—',
          dicts.queryCategories.get(q?.category ?? '') ?? '—',
          dicts.reviewRejectReasons[stage].get(r.rejectReason ?? '') ?? '—',
        ];
      });

    const catRows = queryCategoryRejectDist(scopedSel, index, dicts.queryCategories);

    return {
      facts,
      comparison: {
        title: `${a.barName} · ${a.periodLabel} 三层审核通过率横向对比`,
        note: `只有「${stageLabel}」低于其他环节时，问题就定位在该环节内部；三个环节同步下降则要考虑上游供给结构或整体审核标准变化。`,
        rows: pipelineRows,
      },
      distribution: {
        title: `${a.barName} 该日${stageLabel}拒绝原因分布`,
        note: '若集中在单一原因，优先修策略或提示词；若分布均匀，考虑该环节标准过严',
        rows: dist,
      },
      samples: {
        title: `${stageLabel}被拒内容原始样例`,
        columns: ['内容 ID', '审核时间', '内容类型', 'Query 分类', '拒绝原因'],
        rows: rejected,
      },
      relatedRuleText: `规则 R3：任一审核环节拒绝率 > ${pct(THRESHOLDS.reviewRejectRateMax, 0)} 或待审积压 > ${THRESHOLDS.reviewPendingMaxCount} 条，且该环节处理 ≥ ${THRESHOLDS.reviewMinSamples} 条。同时可在下方对比各 Query 分类的人审拒绝偏离度（共 ${catRows.length} 个分类）。`,
    };
  }

  if (a.ruleId === 'R4') {
    const cat = a.queryCategory;
    if (!cat) return empty;
    const catName = dicts.queryCategories.get(cat) ?? cat;
    const perBarCat = new Map<string, number>();
    for (const c of sel.contents) {
      if (index.queryById.get(c.queryId)?.category !== cat) continue;
      perBarCat.set(c.barId, (perBarCat.get(c.barId) ?? 0) + 1);
    }
    const bars = ctx.ds.bars;
    const stageOf = sel.contents
      .filter((c) => index.queryById.get(c.queryId)?.category === cat)
      .map((c) => index.reviewByContent.get(c.contentId)?.byStage.auto)
      .filter((r): r is NonNullable<typeof r> => r !== undefined);
    const autoPass = stageOf.filter((r) => r.status === 'pass').length;
    const autoReviewed = stageOf.filter((r) => r.status !== 'pending').length;

    const recent = sel.contents
      .filter((c) => index.queryById.get(c.queryId)?.category === cat && inDay(c.ts))
      .slice(0, 8)
      .map((c) => [
        c.contentId,
        fullTs(c.ts),
        dicts.contentTypes.get(c.contentType) ?? c.contentType,
        index.queryById.get(c.queryId)?.name ?? c.queryId,
        dicts.queryCategories.get(index.queryById.get(c.queryId)?.category ?? '') ?? '—',
      ]);

    return {
      facts: [
        ...facts,
        { label: '断供期间机审通过率', value: pct(autoReviewed > 0 ? autoPass / autoReviewed : null) },
        {
          label: '断供前 7 天日均供给',
          value: facts.find((f) => f.label === '样本量')?.value.split('；')[0] ?? '—',
        },
      ],
      comparison: {
        title: `各分吧「${catName}」内容产出对比（统计期内）`,
        note: '若只有该吧断供而其他吧正常，问题在该吧自身的生产链路；若全部断供，则该分类的素材或模板整体不可用。',
        rows: bars
          .map((b) => ({
            name: b.name,
            valueText: `${(perBarCat.get(b.id) ?? 0).toLocaleString()} 条`,
            value: perBarCat.get(b.id) ?? 0,
            highlight: b.id === barId,
            note: b.category,
          }))
          .sort((x, y) => (y.value ?? 0) - (x.value ?? 0)),
      },
      distribution: {
        title: `「${catName}」在 ${a.barName} 的 Query 构成`,
        note: '断供前该分类由哪些 Query 支撑，有助于判断是整类失效还是个别 Query 失效',
        rows: topQueriesOfCategory(sel, index, cat).map((q) => ({
          key: q.queryId,
          label: q.name,
          value: q.count,
          percent: q.percent,
        })),
      },
      samples: {
        title: `「${catName}」内容原始样例`,
        columns: ['内容 ID', '生成时间', '内容类型', 'Query', '分类'],
        rows: recent,
      },
      relatedRuleText: `规则 R4：某 Query 分类连续 ${THRESHOLDS.querySupplyBreakDays} 天日均内容供给 < ${THRESHOLDS.querySupplyMin} 条，且统计区间 ≥ ${THRESHOLDS.querySupplyMinRangeDays} 天。`,
    };
  }

  if (a.ruleId === 'R5') {
    const peers = barRows.map((r) => ({
      name: r.barName,
      valueText: pct(r.agg.ctr),
      value: r.agg.ctr,
      highlight: r.barId === barId,
      note: `曝光 ${r.agg.impressions.toLocaleString()} / 调起率 ${pct(r.agg.jumpRate)}`,
    }));
    const ranks = ctrByRank(scopedSel);
    const jumpDist = jumpFailReasonDist(
      { ...sel, jumpBacks: sel.jumpBacks.filter((j) => j.barId === barId) },
      dicts.jumpFailReasons,
    );
    const clickedSamples = sel.clicks
      .filter((c) => c.barId === barId)
      .slice(0, 8)
      .map((c) => {
        const content = index.byId.get(c.contentId);
        const q = content ? index.queryById.get(content.queryId) : undefined;
        const dist = index.distByContent.get(c.contentId);
        const jumped = sel.jumpBacks.some(
          (j) => j.contentId === c.contentId && j.status === 'success',
        );
        return [
          c.eventId,
          fullTs(c.ts),
          q?.name ?? c.queryId,
          dist ? `第 ${dist.rankInPage} 位` : '—',
          jumped ? '已调起' : '未调起',
        ];
      });

    const rankNote =
      ranks.length > 0
        ? `该吧位次 CTR 衰减：${ranks
            .slice(0, 5)
            .map((r) => `第${r.rank}位 ${pct(r.ctr)}`)
            .join('、')}。`
        : '';

    return {
      facts: rankNote ? [...facts, { label: '位次 CTR 衰减', value: rankNote }] : facts,
      comparison: {
        title: `${filters.range.startDate} ~ ${filters.range.endDate} 各分吧搜索结果 CTR 对比`,
        note: `与其他分吧对比可区分「内容本身问题」与「该吧流量结构问题」。${rankNote}`,
        rows: peers.sort((x, y) => (x.value ?? 1) - (y.value ?? 1)),
      },
      distribution: {
        title: `${a.barName} 点击后调起贴吧的结果分布`,
        note: '若失败以某一原因集中出现，处置方向明确；若分散则更可能是链路整体问题',
        rows:
          jumpDist.length > 0
            ? jumpDist
            : [
                {
                  key: 'none',
                  label: '无调起失败记录',
                  value: 0,
                  percent: null,
                } as DistRow,
              ],
      },
      samples: {
        title: `${a.barName} 点击事件原始样例`,
        columns: ['事件 ID', '点击时间', 'Query', '展示位次', '调起结果'],
        rows: clickedSamples,
      },
      relatedRuleText: `规则 R5（扩展演示规则）：CTR < ${pct(THRESHOLDS.ctrMin, 0)} 或调起成功率 < ${pct(THRESHOLDS.jumpRateMin, 0)}，且区间曝光 ≥ ${THRESHOLDS.ctrMinImpressions} 次。`,
    };
  }

  if (a.ruleId === 'R6') {
    const scopedEvalSel: SelectedData = {
      ...sel,
      evals: sel.evals.filter((e) => e.barId === barId),
    };
    const agg = evalBarRows(ctx.ds, scopedEvalSel, index).find((r) => r.barId === barId)?.agg;

    if (!agg) return empty;

    // 维度画像横向对比：一眼看出是单维劣化还是全面下滑
    const dimRows: ComparisonRow[] = agg.dimAgg.map((d) => ({
      name: d.label,
      valueText: fmtScore(d.mean),
      value: d.mean,
      highlight: a.metricName.startsWith(d.label),
      note: `不合格率 ${pct(d.failRate)} / 打分 ${d.scored} 条`,
    }));

    const focusDim = EVAL_DIMENSIONS.find((dim) =>
      a.metricName.startsWith(DIMENSION_LABELS[dim] ?? dim),
    );
    const issueDist = evalIssueDist(
      scopedEvalSel.evals,
      dicts.evalIssueReasons,
      focusDim,
    );
    const lowRows = evalLowScoreContents(
      ctx.ds,
      scopedEvalSel,
      index,
      dicts.evalIssueReasons,
      8,
      focusDim,
    );

    const barAgg = barRows.find((r) => r.barId === barId)?.agg;
    return {
      facts: [
        ...facts,
        { label: '该吧质量达标率', value: pct(agg.passRate) },
        { label: '该吧人机一致率', value: pct(agg.humanAgreeRate) },
      ],
      comparison: {
        title: `${a.barName} 各评测维度均分对比`,
        note: `单维骤降指向该维度的专属链路（渲染 / 素材 / 提示词）；全面同降才考虑生成模型本身。当前分档 优 ${agg.gradeDist[0]} / 良 ${agg.gradeDist[1]} / 中 ${agg.gradeDist[2]} / 差 ${agg.gradeDist[3]}。${barAgg ? `同期该吧三层审核通过率 ${pct(barAgg.passRate)}，可对照判断是「质量问题」还是「供给问题」。` : ''}`,
        rows: dimRows,
      },
      distribution:
        issueDist.length > 0
          ? {
              title: `${a.barName} 低分原因分布${focusDim ? `（${issueDist[0].dimLabel}）` : ''}`,
              note: '低分原因由评测模型直接产出，集中指向单一原因时可直接定位到具体环节',
              rows: issueDist.slice(0, 10).map((r) => ({
                key: r.reason,
                label: r.reasonLabel,
                value: r.count,
                percent: null,
              })),
            }
          : null,
      samples: {
        title: focusDim
          ? `${a.barName}「${DIMENSION_LABELS[focusDim]}」维度得分最低的内容样例`
          : `${a.barName} 综合质量分最低的内容样例`,
        columns: [
          '内容 ID',
          '生成时间',
          '内容类型',
          ...(focusDim ? [DIMENSION_LABELS[focusDim]] : []),
          '综合分',
          '档位',
          '扣分原因',
        ],
        rows: lowRows.map((r) => [
          r.contentId,
          fullTs(
            index.byId.get(r.contentId)?.ts ??
              scopedEvalSel.evals.find((e) => e.contentId === r.contentId)?.ts ??
              `${filters.range.startDate}T00:00:00`,
          ),
          dicts.contentTypes.get(r.contentType) ?? r.contentType,
          ...(focusDim ? [fmtScore(r.focusScore)] : []),
          fmtScore(r.overallScore),
          r.gradeLabel,
          r.issues.map((i) => i.reasonLabel).join('；') || '—',
        ]),
      },
      relatedRuleText: `规则 R6：① 任一评测维度不合格率 > ${pct(THRESHOLDS.evalFailRateMax, 0)} 且该维度打分 ≥ ${THRESHOLDS.evalMinSamples} 条；② 区间综合质量分 < ${THRESHOLDS.evalScoreMin} 且评测 ≥ ${THRESHOLDS.evalMinSamples} 条；③ 人机分档一致率 < ${pct(THRESHOLDS.evalAgreeRateMin, 0)} 且抽样 ≥ ${THRESHOLDS.evalAgreeMinSamples} 条。均按「贴吧·区间」粒度判定——批量生产里单一维度不合格本属常态，日粒度的二项噪声会淹没真实信号。`,
    };
  }

  return empty;
}

function topQueriesOfCategory(
  sel: SelectedData,
  index: ContentIndex,
  cat: string,
): Array<{ queryId: string; name: string; count: number; percent: number | null }> {
  const counts = new Map<string, number>();
  let total = 0;
  for (const c of sel.contents) {
    if (index.queryById.get(c.queryId)?.category !== cat) continue;
    counts.set(c.queryId, (counts.get(c.queryId) ?? 0) + 1);
    total += 1;
  }
  return [...counts.entries()]
    .map(([queryId, count]) => ({
      queryId,
      name: index.queryById.get(queryId)?.name ?? queryId,
      count,
      percent: total > 0 ? count / total : null,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

/** 供自检面板使用：把当前生效的阈值渲染成文本 */
export function thresholdTextList(): { rule: string; text: string }[] {
  return [
    {
      rule: 'R1 生成成功率',
      text: `< ${(THRESHOLDS.genSuccessRateMin * 100).toFixed(0)}%，且当日已完成生成尝试 ≥ ${THRESHOLDS.genSuccessRateMinSamples} 次（贴吧·日）`,
    },
    {
      rule: 'R2 平均生成时长',
      text: `> ${(THRESHOLDS.avgDurationMaxMs / 1000).toFixed(0)}s，且当日成功任务 ≥ ${THRESHOLDS.avgDurationMinSamples} 次（贴吧·日）`,
    },
    {
      rule: 'R3 审核环节异常',
      text: `任一环节拒绝率 > ${(THRESHOLDS.reviewRejectRateMax * 100).toFixed(0)}% 或待审 > ${THRESHOLDS.reviewPendingMaxCount} 条，且该环节处理 ≥ ${THRESHOLDS.reviewMinSamples} 条（贴吧·日）`,
    },
    {
      rule: 'R4 Query 分类断供',
      text: `某 Query 分类连续 ${THRESHOLDS.querySupplyBreakDays} 天日均供给 < ${THRESHOLDS.querySupplyMin} 条，且区间 ≥ ${THRESHOLDS.querySupplyMinRangeDays} 天（贴吧·区间）`,
    },
    {
      rule: 'R5 分发转化下滑（扩展）',
      text: `CTR < ${(THRESHOLDS.ctrMin * 100).toFixed(0)}% 或调起率 < ${(THRESHOLDS.jumpRateMin * 100).toFixed(0)}%，且区间曝光 ≥ ${THRESHOLDS.ctrMinImpressions} 次（贴吧·区间）`,
    },
    {
      rule: 'R6 AIGC 内容质量异常',
      text: `任一维度不合格率 > ${(THRESHOLDS.evalFailRateMax * 100).toFixed(0)}% 且打分 ≥ ${THRESHOLDS.evalMinSamples} 条，或综合质量分 < ${THRESHOLDS.evalScoreMin}，或人机一致率 < ${(THRESHOLDS.evalAgreeRateMin * 100).toFixed(0)}%（贴吧·区间）`,
    },
  ];
}