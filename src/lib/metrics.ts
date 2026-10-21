/**
 * 指标计算层
 *
 * 铁律：所有指标都从同一套事件级原始数据派生，任何图表 / 卡片 / 详情页都不写死结果。
 *
 * 归属口径：
 *  - 搜索事件、生成任务：按事件自身 ts 的自然日归属。
 *  - 内容、三层审核、分发、点击、调起：统一归因到「内容生成日」（content.ts），
 *    保证「生成成功 → 三层审核 → 分发 → 曝光 → 点击 → 调起」各步口径一致、可比对。
 */

import type {
  Bar,
  ClickEvent,
  Content,
  ContentEval,
  ContentType,
  Dataset,
  DateRange,
  DistributeEvent,
  Events,
  EvalDimension,
  Filters,
  GenerationTask,
  ImpressionStat,
  JumpBackEvent,
  QueryDictItem,
  QueryEvent,
  ReviewRecord,
  ReviewStage,
} from '../types';
import { dayKey } from './time';
import {
  DIMENSION_LABELS,
  DIMENSION_WEIGHTS,
  EVAL_DIMENSIONS,
  GRADE_LABELS,
  REVIEW_STAGES,
  SCORE_GRADES,
  THRESHOLDS,
} from './config';
import type { GradeKey } from './config';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

export function inRange(ts: string, range: DateRange): boolean {
  const d = dayKey(ts);
  return d >= range.startDate && d <= range.endDate;
}

const safeDiv = (num: number, den: number): number | null => (den > 0 ? num / den : null);

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// 内容索引：把三层审核按 contentId 归拢，并派生总通过状态
// ---------------------------------------------------------------------------

export interface ReviewState {
  /** 该内容实际进入过的审核环节（按串行顺序） */
  stages: ReviewStage[];
  /** 各环节审核结果，缺键表示未进入该环节 */
  byStage: Partial<Record<ReviewStage, ReviewRecord>>;
  /** 三层是否全部通过（未进入或未通过的环节都会导致 false） */
  allPassed: boolean;
}

export interface ContentIndex {
  byId: Map<string, Content>;
  /** contentId -> 各层审核状态 */
  reviewByContent: Map<string, ReviewState>;
  /** contentId -> 该内容的两份评测（自动评测 + 可能存在的人工复核） */
  evalByContent: Map<string, ContentEval[]>;
  /** distributeId -> 分发记录 */
  distById: Map<string, DistributeEvent>;
  /** contentId -> 该内容的分发记录（一条内容只分发一次） */
  distByContent: Map<string, DistributeEvent>;
  /** queryId -> Query 维表记录 */
  queryById: Map<string, QueryDictItem>;
}

export function buildContentIndex(events: Events, queries: QueryDictItem[]): ContentIndex {
  const byId = new Map<string, Content>();
  for (const c of events.contents) byId.set(c.contentId, c);

  const staged = new Map<string, Map<ReviewStage, ReviewRecord>>();
  for (const r of events.reviews) {
    let m = staged.get(r.contentId);
    if (!m) {
      m = new Map();
      staged.set(r.contentId, m);
    }
    // 同一内容同一环节只保留一条（生成脚本保证唯一，此处做防御）
    if (!m.has(r.stage)) m.set(r.stage, r);
  }

  const reviewByContent = new Map<string, ReviewState>();
  for (const [contentId, m] of staged) {
    const stages = REVIEW_STAGES.filter((s) => m.has(s)) as ReviewStage[];
    const byStage: Partial<Record<ReviewStage, ReviewRecord>> = {};
    for (const s of stages) byStage[s] = m.get(s);
    // 三层必须全部存在且全部 pass，才算总通过
    const allPassed =
      stages.length === REVIEW_STAGES.length &&
      stages.every((s) => m.get(s)?.status === 'pass');
    reviewByContent.set(contentId, { stages, byStage, allPassed });
  }

  const distById = new Map<string, DistributeEvent>();
  const distByContent = new Map<string, DistributeEvent>();
  for (const d of events.distributes) {
    distById.set(d.distributeId, d);
    if (!distByContent.has(d.contentId)) distByContent.set(d.contentId, d);
  }

  const evalByContent = new Map<string, ContentEval[]>();
  for (const e of events.evals) {
    const list = evalByContent.get(e.contentId);
    if (list) list.push(e);
    else evalByContent.set(e.contentId, [e]);
  }

  const queryById = new Map<string, QueryDictItem>();
  for (const q of queries) queryById.set(q.id, q);

  return { byId, reviewByContent, evalByContent, distById, distByContent, queryById };
}

/** 取内容的总审核状态；无审核记录视为三层均未通过 */
export function reviewStateOf(index: ContentIndex, contentId: string): ReviewState {
  return (
    index.reviewByContent.get(contentId) ?? {
      stages: [],
      byStage: {},
      allPassed: false,
    }
  );
}

// ---------------------------------------------------------------------------
// 聚合结果
// ---------------------------------------------------------------------------

/** 单个审核环节的统计 */
export interface StageAgg {
  stage: ReviewStage;
  /** 进入该环节的内容数 */
  entered: number;
  pass: number;
  reject: number;
  pending: number;
  /** pass + reject，即已完成审核（通过率分母） */
  reviewed: number;
  passRate: number | null;
  rejectRate: number | null;
  /** 仅统计已完成（pass / reject）的审核耗时 */
  avgCostMs: number | null;
  p95CostMs: number | null;
}

export interface Agg {
  /** 搜索事件数（人次） */
  queryEvents: number;
  /** 去重搜索用户数 */
  searchUsers: number;
  /** 覆盖贴吧数（产出过内容的去重 barId） */
  coveredBars: number;
  /** 覆盖 Query 数（产出过内容的去重 queryId） */
  coveredQueries: number;

  tasksTotal: number;
  tasksSuccess: number;
  tasksFailed: number;
  tasksPending: number;
  /** success + failed，即已完成生成尝试（成功率分母） */
  completedTasks: number;
  successRate: number | null;

  /** 仅统计成功任务 */
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  slowTaskCount: number;
  slowTaskRatio: number | null;

  contentTotal: number;
  /** 三层审核各环节统计 */
  stages: Record<ReviewStage, StageAgg>;
  /** 三层全部通过的内容数 */
  allPassedContents: number;
  /** 已发起（至少进入机审）的内容数，总通过率分母 */
  reviewedContents: number;
  /** 三层总通过率 */
  passRate: number | null;

  distributes: number;
  /** 全部过审且已分发的内容数 */
  distributedContents: number;

  impressions: number;
  clicks: number;
  /** 有过曝光的分发数（分发级去重） */
  impressionDistributes: number;
  /** 有过点击的内容数（内容级去重） */
  clickedContents: number;
  /** 搜索结果 CTR = 点击事件数 / 曝光量（分子分母同源，可跨页面直接比对） */
  ctr: number | null;

  jumps: number;
  jumpSuccess: number;
  jumpFailed: number;
  /** 被点击且成功调起过的内容数 */
  jumpedContents: number;
  /** 调起成功率 = 成功调起次数 / 调起次数 */
  jumpRate: number | null;
}

function emptyStage(stage: ReviewStage): StageAgg {
  return {
    stage,
    entered: 0,
    pass: 0,
    reject: 0,
    pending: 0,
    reviewed: 0,
    passRate: null,
    rejectRate: null,
    avgCostMs: null,
    p95CostMs: null,
  };
}

export function emptyAgg(): Agg {
  return {
    queryEvents: 0,
    searchUsers: 0,
    coveredBars: 0,
    coveredQueries: 0,
    tasksTotal: 0,
    tasksSuccess: 0,
    tasksFailed: 0,
    tasksPending: 0,
    completedTasks: 0,
    successRate: null,
    avgDurationMs: null,
    p95DurationMs: null,
    slowTaskCount: 0,
    slowTaskRatio: null,
    contentTotal: 0,
    stages: {
      auto: emptyStage('auto'),
      manual: emptyStage('manual'),
      quality: emptyStage('quality'),
    },
    allPassedContents: 0,
    reviewedContents: 0,
    passRate: null,
    distributes: 0,
    distributedContents: 0,
    impressions: 0,
    clicks: 0,
    impressionDistributes: 0,
    clickedContents: 0,
    ctr: null,
    jumps: 0,
    jumpSuccess: 0,
    jumpFailed: 0,
    jumpedContents: 0,
    jumpRate: null,
  };
}

export interface AggInput {
  queryEvents: QueryEvent[];
  tasks: GenerationTask[];
  contents: Content[];
  distributes: DistributeEvent[];
  impressionStats: ImpressionStat[];
  clicks: ClickEvent[];
  jumpBacks: JumpBackEvent[];
  index: ContentIndex;
}

/**
 * 核心聚合：给定一组已筛选的事件，输出全部业务指标。
 * 分母为 0 时返回 null（前端展示 "—"），不产生 NaN / Infinity。
 */
export function aggregate(input: AggInput): Agg {
  const { queryEvents, tasks, contents, distributes, impressionStats, clicks, jumpBacks, index } =
    input;
  const agg = emptyAgg();

  // ---- 搜索需求侧：人次 + 去重人数 ----
  const userSet = new Set<string>();
  for (const q of queryEvents) userSet.add(q.userId);
  agg.queryEvents = queryEvents.length;
  agg.searchUsers = userSet.size;

  // ---- 生成任务 ----
  const durations: number[] = [];
  for (const t of tasks) {
    agg.tasksTotal += 1;
    if (t.status === 'success') {
      agg.tasksSuccess += 1;
      if (t.durationMs !== null) {
        durations.push(t.durationMs);
        if (t.durationMs > THRESHOLDS.avgDurationMaxMs) agg.slowTaskCount += 1;
      }
    } else if (t.status === 'failed') {
      agg.tasksFailed += 1;
    } else {
      agg.tasksPending += 1;
    }
  }
  agg.completedTasks = agg.tasksSuccess + agg.tasksFailed;
  agg.successRate = safeDiv(agg.tasksSuccess, agg.completedTasks);

  if (durations.length > 0) {
    const sum = durations.reduce((a, b) => a + b, 0);
    agg.avgDurationMs = sum / durations.length;
    const sorted = [...durations].sort((a, b) => a - b);
    agg.p95DurationMs = percentile(sorted, 0.95);
    agg.slowTaskRatio = agg.slowTaskCount / durations.length;
  }

  // ---- 内容 + 三层审核 ----
  const contentIds = new Set<string>();
  const barSet = new Set<string>();
  const querySet = new Set<string>();
  const costByStage: Record<ReviewStage, number[]> = { auto: [], manual: [], quality: [] };

  for (const c of contents) {
    contentIds.add(c.contentId);
    barSet.add(c.barId);
    querySet.add(c.queryId);

    const state = index.reviewByContent.get(c.contentId);
    for (const stage of REVIEW_STAGES) {
      const rec = state?.byStage[stage];
      if (!rec) continue;
      const sa = agg.stages[stage];
      sa.entered += 1;
      if (rec.status === 'pass') {
        sa.pass += 1;
        if (rec.costMs !== null) costByStage[stage].push(rec.costMs);
      } else if (rec.status === 'reject') {
        sa.reject += 1;
        if (rec.costMs !== null) costByStage[stage].push(rec.costMs);
      } else {
        sa.pending += 1;
      }
      sa.reviewed = sa.pass + sa.reject;
      sa.passRate = safeDiv(sa.pass, sa.reviewed);
      sa.rejectRate = safeDiv(sa.reject, sa.reviewed);
    }
    if (state?.allPassed) agg.allPassedContents += 1;
  }

  for (const stage of REVIEW_STAGES) {
    const list = costByStage[stage];
    if (list.length === 0) continue;
    agg.stages[stage].avgCostMs = list.reduce((a, b) => a + b, 0) / list.length;
    agg.stages[stage].p95CostMs = percentile([...list].sort((a, b) => a - b), 0.95);
  }

  agg.contentTotal = contentIds.size;
  agg.coveredBars = barSet.size;
  agg.coveredQueries = querySet.size;
  // 总通过率分母：至少进入机审的内容数
  agg.reviewedContents = agg.stages.auto.entered;
  agg.passRate = safeDiv(agg.allPassedContents, agg.reviewedContents);

  // ---- 分发 ----
  agg.distributes = distributes.length;
  for (const d of distributes) {
    const state = index.reviewByContent.get(d.contentId);
    if (state?.allPassed) agg.distributedContents += 1;
  }

  // ---- 曝光 / 点击：分发级去重 ----
  const impByDist = new Map<string, number>();
  for (const s of impressionStats) {
    agg.impressions += s.impressions;
    impByDist.set(s.distributeId, (impByDist.get(s.distributeId) ?? 0) + s.impressions);
  }
  agg.impressionDistributes = impByDist.size;

  const clickByContent = new Set<string>();
  for (const c of clicks) {
    agg.clicks += 1;
    clickByContent.add(c.contentId);
  }
  agg.clickedContents = clickByContent.size;
  // CTR = 点击事件数 / 曝光量：与位次 CTR、漏斗上下文共用同一分母口径
  agg.ctr = safeDiv(agg.clicks, agg.impressions);

  // ---- 调起 ----
  const jumpedSet = new Set<string>();
  for (const j of jumpBacks) {
    agg.jumps += 1;
    if (j.status === 'success') {
      agg.jumpSuccess += 1;
      jumpedSet.add(j.contentId);
    } else {
      agg.jumpFailed += 1;
    }
  }
  agg.jumpedContents = jumpedSet.size;
  agg.jumpRate = safeDiv(agg.jumpSuccess, agg.jumps);

  return agg;
}

// ---------------------------------------------------------------------------
// 筛选
// ---------------------------------------------------------------------------

export interface SelectedData {
  queryEvents: QueryEvent[];
  tasks: GenerationTask[];
  contents: Content[];
  /** 只含自动评测；人工复核记录由 evalAggregate 单独取，避免分档统计被重复计入 */
  evals: ContentEval[];
  distributes: DistributeEvent[];
  impressionStats: ImpressionStat[];
  clicks: ClickEvent[];
  jumpBacks: JumpBackEvent[];
  hasAnyData: boolean;
}

export function selectData(ds: Dataset, filters: Filters): SelectedData {
  const { range, barId, contentType } = filters;
  const matchBar = (b: string) => barId === 'ALL' || b === barId;
  const matchType = (c: string) => contentType === 'ALL' || c === contentType;

  const queryEvents = ds.events.queryEvents.filter(
    (q) => matchBar(q.barId) && inRange(q.ts, range),
  );
  const tasks = ds.events.generationTasks.filter(
    (t) => matchBar(t.barId) && matchType(t.contentType) && inRange(t.ts, range),
  );
  const contents = ds.events.contents.filter(
    (c) => matchBar(c.barId) && matchType(c.contentType) && inRange(c.ts, range),
  );

  // 内容级集合：用于把下游事件收敛到本筛选范围内，防止口径串味
  const contentIds = new Set(contents.map((c) => c.contentId));
  const distributes = ds.events.distributes.filter((d) => contentIds.has(d.contentId));

  // 评测与审核一样归因到内容生成日：只取自动评测，人工复核由 index.evalByContent 取
  const evals = ds.events.evals.filter(
    (e) => e.source === 'auto' && contentIds.has(e.contentId),
  );

  const distIds = new Set(distributes.map((d) => d.distributeId));

  const impressionStats = ds.events.impressionStats.filter(
    (s) =>
      distIds.has(s.distributeId) && s.day >= range.startDate && s.day <= range.endDate,
  );

  const clicks = ds.events.clicks.filter((c) => contentIds.has(c.contentId));
  const jumpBacks = ds.events.jumpBacks.filter((j) => contentIds.has(j.contentId));

  return {
    queryEvents,
    tasks,
    contents,
    evals,
    distributes,
    impressionStats,
    clicks,
    jumpBacks,
    hasAnyData:
      queryEvents.length +
        tasks.length +
        contents.length +
        evals.length +
        distributes.length +
        impressionStats.length +
        clicks.length +
        jumpBacks.length >
        0,
  };
}

export function aggFromSelection(sel: SelectedData, index: ContentIndex): Agg {
  return aggregate({
    queryEvents: sel.queryEvents,
    tasks: sel.tasks,
    contents: sel.contents,
    distributes: sel.distributes,
    impressionStats: sel.impressionStats,
    clicks: sel.clicks,
    jumpBacks: sel.jumpBacks,
    index,
  });
}

// ---------------------------------------------------------------------------
// 分组序列
// ---------------------------------------------------------------------------

export interface DailyPoint {
  day: string;
  tasksTotal: number;
  tasksSuccess: number;
  tasksFailed: number;
  tasksPending: number;
  completedTasks: number;
  successRate: number | null;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  contentTotal: number;
  autoPass: number;
  autoReject: number;
  autoPending: number;
  manualPass: number;
  manualReject: number;
  manualPending: number;
  qualityPass: number;
  qualityReject: number;
  qualityPending: number;
  allPassedContents: number;
  distributes: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  jumpSuccess: number;
  jumpFailed: number;
  jumpRate: number | null;
}

export function dailySeries(sel: SelectedData, index: ContentIndex): DailyPoint[] {
  const buckets = new Map<string, SelectedData>();
  const get = (day: string): SelectedData => {
    let b = buckets.get(day);
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
      buckets.set(day, b);
    }
    return b;
  };

  for (const q of sel.queryEvents) get(dayKey(q.ts)).queryEvents.push(q);
  for (const t of sel.tasks) get(dayKey(t.ts)).tasks.push(t);
  for (const c of sel.contents) get(dayKey(c.ts)).contents.push(c);
  for (const c of sel.clicks) get(dayKey(c.ts)).clicks.push(c);
  for (const j of sel.jumpBacks) get(dayKey(j.ts)).jumpBacks.push(j);
  // 曝光按 day 字段直接分桶
  for (const s of sel.impressionStats) get(s.day).impressionStats.push(s);
  // 分发归因到所属内容的生成日，与内容层口径保持一致
  for (const d of sel.distributes) {
    const c = index.byId.get(d.contentId);
    if (c) get(dayKey(c.ts)).distributes.push(d);
  }

  return [...buckets.keys()]
    .sort()
    .map((day) => {
      const b = buckets.get(day)!;
      const a = aggFromSelection(b, index);
      return {
        day,
        tasksTotal: a.tasksTotal,
        tasksSuccess: a.tasksSuccess,
        tasksFailed: a.tasksFailed,
        tasksPending: a.tasksPending,
        completedTasks: a.completedTasks,
        successRate: a.successRate,
        avgDurationMs: a.avgDurationMs,
        p95DurationMs: a.p95DurationMs,
        contentTotal: a.contentTotal,
        autoPass: a.stages.auto.pass,
        autoReject: a.stages.auto.reject,
        autoPending: a.stages.auto.pending,
        manualPass: a.stages.manual.pass,
        manualReject: a.stages.manual.reject,
        manualPending: a.stages.manual.pending,
        qualityPass: a.stages.quality.pass,
        qualityReject: a.stages.quality.reject,
        qualityPending: a.stages.quality.pending,
        allPassedContents: a.allPassedContents,
        distributes: a.distributes,
        impressions: a.impressions,
        clicks: a.clicks,
        ctr: a.ctr,
        jumpSuccess: a.jumpSuccess,
        jumpFailed: a.jumpFailed,
        jumpRate: a.jumpRate,
      };
    });
}

export interface BarRow {
  barId: string;
  barName: string;
  category: string;
  tier: string;
  agg: Agg;
}

export function barBreakdown(ds: Dataset, sel: SelectedData, index: ContentIndex): BarRow[] {
  const barMap = new Map(ds.bars.map((b) => [b.id, b]));
  const groups = new Map<string, SelectedData>();
  const get = (id: string): SelectedData => {
    let b = groups.get(id);
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
      groups.set(id, b);
    }
    return b;
  };
  for (const q of sel.queryEvents) get(q.barId).queryEvents.push(q);
  for (const t of sel.tasks) get(t.barId).tasks.push(t);
  for (const c of sel.contents) get(c.barId).contents.push(c);
  for (const d of sel.distributes) get(d.barId).distributes.push(d);
  for (const s of sel.impressionStats) {
    const dist = index.distById.get(s.distributeId);
    if (dist) get(dist.barId).impressionStats.push(s);
  }
  for (const c of sel.clicks) get(c.barId).clicks.push(c);
  for (const j of sel.jumpBacks) get(j.barId).jumpBacks.push(j);

  return [...groups.keys()]
    .sort()
    .map((id) => {
      const bar = barMap.get(id);
      return {
        barId: id,
        barName: bar ? bar.name : id,
        category: bar ? bar.category : '-',
        tier: bar ? bar.tier : '-',
        agg: aggFromSelection(groups.get(id)!, index),
      };
    });
}

export interface ContentTypeRow {
  contentType: string;
  contentTypeName: string;
  agg: Agg;
}

/** 按内容类型（图文 / 视频）拆分 */
export function contentTypeBreakdown(
  ds: Dataset,
  sel: SelectedData,
  index: ContentIndex,
): ContentTypeRow[] {
  const nameOf = new Map(ds.meta.dictionaries.contentTypes.map((c) => [c.id, c.name]));
  const all: ContentType = { id: 'ALL', name: '全部内容' };
  const ids = [all, ...ds.meta.dictionaries.contentTypes];

  return ids.map(({ id, name }) => {
    const pick = <T extends { contentType: string }>(arr: T[]): T[] =>
      id === 'ALL' ? arr : arr.filter((x) => x.contentType === id);
    const contents = pick(sel.contents);
    const contentIds = new Set(contents.map((c) => c.contentId));
    const sub: SelectedData = {
      queryEvents: sel.queryEvents,
      tasks: pick(sel.tasks),
      contents,
      evals: pick(sel.evals),
      distributes: sel.distributes.filter((d) => contentIds.has(d.contentId)),
      impressionStats: sel.impressionStats.filter((s) => contentIds.has(s.contentId)),
      clicks: sel.clicks.filter((c) => contentIds.has(c.contentId)),
      jumpBacks: sel.jumpBacks.filter((j) => contentIds.has(j.contentId)),
      hasAnyData: sel.hasAnyData,
    };
    return {
      contentType: id,
      contentTypeName: id === 'ALL' ? name : (nameOf.get(id) ?? id),
      agg: aggFromSelection(sub, index),
    };
  });
}

// ---------------------------------------------------------------------------
// 分布
// ---------------------------------------------------------------------------

export interface DistRow {
  key: string;
  label: string;
  value: number;
  percent: number | null;
}

export function failureReasonDist(sel: SelectedData, dict: Map<string, string>): DistRow[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const t of sel.tasks) {
    if (t.status === 'failed' && t.failureReason) {
      counts.set(t.failureReason, (counts.get(t.failureReason) ?? 0) + 1);
      total += 1;
    }
  }
  return toDistRows(counts, total, dict);
}

/** 指定审核环节的拒绝原因分布 */
export function rejectReasonDist(
  sel: SelectedData,
  index: ContentIndex,
  stage: ReviewStage,
  dict: Map<string, string>,
): DistRow[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const c of sel.contents) {
    const rec = index.reviewByContent.get(c.contentId)?.byStage[stage];
    if (rec && rec.status === 'reject' && rec.rejectReason) {
      counts.set(rec.rejectReason, (counts.get(rec.rejectReason) ?? 0) + 1);
      total += 1;
    }
  }
  return toDistRows(counts, total, dict);
}

/** 调起失败原因分布 */
export function jumpFailReasonDist(
  sel: SelectedData,
  dict: Map<string, string>,
): DistRow[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const j of sel.jumpBacks) {
    if (j.status === 'failed' && j.failReason) {
      counts.set(j.failReason, (counts.get(j.failReason) ?? 0) + 1);
      total += 1;
    }
  }
  return toDistRows(counts, total, dict);
}

export interface QueryCategoryRow {
  key: string;
  label: string;
  contents: number;
  reviewed: number;
  rejected: number;
  rejectRate: number | null;
  /**
   * 相对「当日大盘」的加权平均偏离（百分点，正数表示比当日整体更容易被拒），
   * 用于剔除「某天整体审核变严」的日级效应，只留下 Query 分类自身差异。
   * 仅纳入该分类当日已审核内容 ≥ MIN_DAY_SAMPLE 的日期。
   */
  excessRate: number | null;
  excessDays: number;
}

const MIN_DAY_SAMPLE = 5;

/** 按 Query 意图分类统计人审拒绝率（用于定位「是否集中在某类搜索意图」） */
export function queryCategoryRejectDist(
  sel: SelectedData,
  index: ContentIndex,
  dict: Map<string, string>,
): QueryCategoryRow[] {
  const reviewed = new Map<string, number>();
  const rejected = new Map<string, number>();
  const byCatDay = new Map<string, Map<string, { r: number; j: number }>>();
  const dayOverall = new Map<string, { r: number; j: number }>();

  for (const c of sel.contents) {
    const rec = index.reviewByContent.get(c.contentId)?.byStage.manual;
    if (!rec || rec.status === 'pending') continue;
    const query = index.queryById.get(c.queryId);
    const cat = query?.category ?? 'UNKNOWN';
    const day = dayKey(c.ts);

    reviewed.set(cat, (reviewed.get(cat) ?? 0) + 1);
    if (rec.status === 'reject') rejected.set(cat, (rejected.get(cat) ?? 0) + 1);

    const overall = dayOverall.get(day) ?? { r: 0, j: 0 };
    overall.r += 1;
    if (rec.status === 'reject') overall.j += 1;
    dayOverall.set(day, overall);

    let days = byCatDay.get(cat);
    if (!days) {
      days = new Map();
      byCatDay.set(cat, days);
    }
    const slot = days.get(day) ?? { r: 0, j: 0 };
    slot.r += 1;
    if (rec.status === 'reject') slot.j += 1;
    days.set(day, slot);
  }

  return [...reviewed.keys()]
    .map((k) => {
      const days = byCatDay.get(k);
      let weightedExcess = 0;
      let weight = 0;
      let excessDays = 0;
      if (days) {
        for (const [day, slot] of days.entries()) {
          if (slot.r < MIN_DAY_SAMPLE) continue;
          const overall = dayOverall.get(day);
          if (!overall || overall.r === 0) continue;
          weightedExcess += slot.r * (slot.j / slot.r - overall.j / overall.r);
          weight += slot.r;
          excessDays += 1;
        }
      }
      return {
        key: k,
        label: dict.get(k) ?? k,
        contents: reviewed.get(k) ?? 0,
        reviewed: reviewed.get(k) ?? 0,
        rejected: rejected.get(k) ?? 0,
        rejectRate: safeDiv(rejected.get(k) ?? 0, reviewed.get(k) ?? 0),
        excessRate: weight > 0 ? weightedExcess / weight : null,
        excessDays,
      };
    })
    .sort((a, b) => (b.excessRate ?? -1) - (a.excessRate ?? -1));
}

function toDistRows(
  counts: Map<string, number>,
  total: number,
  dict: Map<string, string>,
): DistRow[] {
  return [...counts.entries()]
    .map(([key, value]) => ({
      key,
      label: dict.get(key) ?? key,
      value,
      percent: safeDiv(value, total),
    }))
    .sort((a, b) => b.value - a.value);
}

/** 生成耗时分桶（用于「高延迟」展示） */
export function durationHistogram(
  tasks: GenerationTask[],
): Array<{ bucket: string; count: number }> {
  const buckets = [
    { label: '0-3s', min: 0, max: 3_000 },
    { label: '3-6s', min: 3_000, max: 6_000 },
    { label: '6-10s', min: 6_000, max: 10_000 },
    { label: '10-15s', min: 10_000, max: 15_000 },
    { label: '15-25s', min: 15_000, max: 25_000 },
    { label: '>25s', min: 25_000, max: Number.MAX_SAFE_INTEGER },
  ];
  const out = buckets.map((b) => ({ bucket: b.label, count: 0 }));
  for (const t of tasks) {
    if (t.status !== 'success' || t.durationMs === null) continue;
    const i = buckets.findIndex((b) => t.durationMs! >= b.min && t.durationMs! < b.max);
    if (i >= 0) out[i].count += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 三层审核流水线
// ---------------------------------------------------------------------------

export interface ReviewPipeline {
  steps: {
    stage: ReviewStage | 'distribute';
    label: string;
    /** 进入该环节的内容数 */
    value: number;
    /** 相对上一环节的通过率 */
    rateFromPrev: number | null;
    /** 相对环节链首的通过率 */
    rateFromTop: number | null;
    avgCostMs: number | null;
    hint: string;
  }[];
  /** 当前累计未完成审核的内容数（积压） */
  pendingByStage: Record<ReviewStage, number>;
}

/**
 * 三层审核流水线：机审 → 人审 → 质量审核 → 可分发。
 * 每层都输出「本层通过率」与「本层平均耗时」，可定位卡在哪一环。
 */
export function reviewPipeline(agg: Agg): ReviewPipeline {
  const auto = agg.stages.auto;
  const manual = agg.stages.manual;
  const quality = agg.stages.quality;

  const raw: ReviewPipeline['steps'] = [
    {
      stage: 'auto',
      label: '机审',
      value: auto.pass,
      rateFromPrev: auto.passRate,
      rateFromTop: null,
      avgCostMs: auto.avgCostMs,
      hint: '机审通过，进入人审；自动拦截违规与低质内容',
    },
    {
      stage: 'manual',
      label: '人审',
      value: manual.pass,
      rateFromPrev: manual.passRate,
      rateFromTop: null,
      avgCostMs: manual.avgCostMs,
      hint: '人工审核内容质量、品牌风险与举报，处理量决定人力成本',
    },
    {
      stage: 'quality',
      label: '质量审核',
      value: quality.pass,
      rateFromPrev: quality.passRate,
      rateFromTop: null,
      avgCostMs: quality.avgCostMs,
      hint: '对内容做可读性与事实性把关，决定是否值得进入搜索分发',
    },
    {
      stage: 'distribute',
      label: '可分发',
      value: agg.distributedContents,
      rateFromPrev: safeDiv(agg.distributedContents, quality.pass),
      rateFromTop: null,
      avgCostMs: null,
      hint: '三层全通过并已分发到手百搜索结果页的内容数',
    },
  ];

  const top = raw[0].value;
  const steps = raw.map((s) => ({
    ...s,
    rateFromTop: safeDiv(s.value, top),
  }));

  return {
    steps,
    pendingByStage: {
      auto: auto.pending,
      manual: manual.pending,
      quality: quality.pending,
    },
  };
}

// ---------------------------------------------------------------------------
// 分发与增长
// ---------------------------------------------------------------------------

/** 按搜索结果页位次统计曝光与 CTR，用于观察位次衰减（分母口径与 Agg.ctr 一致：点击事件数 / 曝光量） */
export function ctrByRank(sel: SelectedData): Array<{
  rank: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
}> {
  const impByRank = new Map<number, number>();
  const impTotalByDist = new Map<string, number>();
  for (const s of sel.impressionStats) {
    impByRank.set(s.rankInPage, (impByRank.get(s.rankInPage) ?? 0) + s.impressions);
    impTotalByDist.set(
      s.distributeId,
      (impTotalByDist.get(s.distributeId) ?? 0) + s.impressions,
    );
  }
  const rankByDist = new Map<string, number>();
  for (const s of sel.impressionStats) {
    const prev = rankByDist.get(s.distributeId);
    if (prev === undefined || s.rankInPage < prev) rankByDist.set(s.distributeId, s.rankInPage);
  }
  const clicksByRank = new Map<number, number>();
  for (const c of sel.clicks) {
    const rank = rankByDist.get(c.distributeId);
    // 无曝光的点击不计入任何位次，保证与 Agg.ctr 的分子分母范围一致
    if (rank === undefined || (impTotalByDist.get(c.distributeId) ?? 0) === 0) continue;
    clicksByRank.set(rank, (clicksByRank.get(rank) ?? 0) + 1);
  }

  return [...impByRank.keys()]
    .sort((a, b) => a - b)
    .map((rank) => {
      const impressions = impByRank.get(rank) ?? 0;
      const clicks = clicksByRank.get(rank) ?? 0;
      return { rank, impressions, clicks, ctr: safeDiv(clicks, impressions) };
    });
}

// ---------------------------------------------------------------------------
// 漏斗（分层，避免内容数 / 分发数 / 曝光数混算）
// ---------------------------------------------------------------------------

export interface FunnelStep {
  key: string;
  label: string;
  value: number;
  /** 相对本层首步骤的转化率 */
  rateFromTop: number | null;
  /** 相对上一步骤的转化率 */
  rateFromPrev: number | null;
  hint: string;
}

export interface FunnelModel {
  supplyTier: { title: string; unit: string; steps: FunnelStep[] };
  growthTier: { title: string; unit: string; steps: FunnelStep[] };
  context: { label: string; value: number }[];
}

export function buildFunnel(agg: Agg): FunnelModel {
  const supplyRaw: Array<Omit<FunnelStep, 'rateFromTop' | 'rateFromPrev'>> = [
    {
      key: 'contents',
      label: '生成内容',
      value: agg.contentTotal,
      hint: '统计期内生成成功任务产出的内容数',
    },
    {
      key: 'auto',
      label: '机审通过',
      value: agg.stages.auto.pass,
      hint: '自动审核通过，进入人审环节',
    },
    {
      key: 'manual',
      label: '人审通过',
      value: agg.stages.manual.pass,
      hint: '人工审核通过，进入质量审核环节',
    },
    {
      key: 'quality',
      label: '质量审核通过',
      value: agg.stages.quality.pass,
      hint: '可读性与事实性把关通过',
    },
    {
      key: 'distribute',
      label: '分发到手百',
      value: agg.distributedContents,
      hint: '三层全通过并分发到搜索结果页的内容数',
    },
  ];

  const growthRaw: Array<Omit<FunnelStep, 'rateFromTop' | 'rateFromPrev'>> = [
    {
      key: 'distributed',
      label: '分发内容',
      value: agg.distributedContents,
      hint: '进入手百搜索结果页的内容数（同一内容只计一次）',
    },
    {
      key: 'exposed',
      label: '获得曝光',
      value: agg.impressionDistributes,
      hint: '至少在搜索结果页被展示过一次的分发数',
    },
    {
      key: 'clicked',
      label: '被点击',
      value: agg.clickedContents,
      hint: '同一内容多次点击只计一次',
    },
    {
      key: 'jumped',
      label: '成功调起贴吧',
      value: agg.jumpedContents,
      hint: '被点击且成功调起贴吧的内容数',
    },
  ];

  const decorate = (
    rows: Array<Omit<FunnelStep, 'rateFromTop' | 'rateFromPrev'>>,
  ): FunnelStep[] => {
    const top = rows.length > 0 ? rows[0].value : 0;
    return rows.map((r, i) => ({
      ...r,
      rateFromTop: safeDiv(r.value, top),
      rateFromPrev: i === 0 ? null : safeDiv(r.value, rows[i - 1].value),
    }));
  };

  return {
    supplyTier: { title: '供给层（内容数）', unit: '条', steps: decorate(supplyRaw) },
    growthTier: { title: '增长层（内容数）', unit: '条', steps: decorate(growthRaw) },
    context: [
      { label: '搜索事件数（人次）', value: agg.queryEvents },
      { label: '生成任务数（次）', value: agg.tasksTotal },
      { label: '搜索曝光量（次）', value: agg.impressions },
      { label: '点击事件数（次）', value: agg.clicks },
      { label: '调起事件数（次）', value: agg.jumps },
    ],
  };
}

/**
 * 跨贴吧去重提示：各贴吧独立去重后的合计数 vs 全局去重数，
 * 差额即「搜索过多个贴吧的重复用户」。
 */
export function crossBarDedupeNote(sel: SelectedData): {
  sumByBar: number;
  globalUnique: number;
  overlap: number;
} | null {
  const byBar = new Map<string, Set<string>>();
  const global = new Set<string>();
  for (const q of sel.queryEvents) {
    let s = byBar.get(q.barId);
    if (!s) {
      s = new Set<string>();
      byBar.set(q.barId, s);
    }
    s.add(q.userId);
    global.add(q.userId);
  }
  let sumByBar = 0;
  for (const s of byBar.values()) sumByBar += s.size;
  if (byBar.size < 2) return null;
  return { sumByBar, globalUnique: global.size, overlap: sumByBar - global.size };
}

// ---------------------------------------------------------------------------
// AIGC 内容评测
// ---------------------------------------------------------------------------
//
// 归属口径与三层审核一致：评测是内容生成后的质量刻画，统一归因到「内容生成日」。
// 输入统一是「自动评测」集合（SelectedData.evals 已在 selectData 里过滤 source === 'auto'），
// 人工复核记录不参与分档统计，只用于算人机一致率，避免同一条内容被计两次。

/** 综合质量分：只对该内容实际打了分的维度按权重加权，图文帖无「声画一致性」故权重自动归一 */
export function evalOverallScore(e: ContentEval): number | null {
  let sum = 0;
  let weight = 0;
  for (const dim of EVAL_DIMENSIONS) {
    const v = e.scores[dim];
    if (v === undefined) continue;
    const w = DIMENSION_WEIGHTS[dim] ?? 0;
    sum += v * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : null;
}

/** 0~100 分 → 档位：优 ≥85 / 良 70~85 / 中 55~70 / 差 <55（「不合格」= 中及以下） */
export function gradeOf(score: number): GradeKey {
  if (score >= SCORE_GRADES.excellent) return 0;
  if (score >= SCORE_GRADES.good) return 1;
  if (score >= SCORE_GRADES.fair) return 2;
  return 3;
}

export interface EvalDimAgg {
  dim: EvalDimension;
  label: string;
  /** 该维度被打分的内容数（不适用的内容类型不计入） */
  scored: number;
  mean: number | null;
  p10: number | null;
  p90: number | null;
  /** 不合格数：分档为「中」或「差」 */
  failCount: number;
  failRate: number | null;
}

export interface EvalAgg {
  /** 内容总数（评测覆盖率的分母） */
  contents: number;
  /** 有自动评测的内容数 */
  evaluated: number;
  /** 能算出综合分的内容数（与 evaluated 相同，保留字段以便与其他口径对齐） */
  scored: number;
  overallScore: number | null;
  /** 优 / 良 / 中 / 差 四档内容数 */
  gradeDist: number[];
  /** 优 + 良占比，即质量达标率 */
  passRate: number | null;
  /** 中 + 差占比，即质量不合格率 */
  failRate: number | null;
  /** 同时被自动评测与人审复核的内容数 */
  humanSampled: number;
  /** 人机分档一致的内容数 */
  humanAgree: number;
  /** 人机一致率 */
  humanAgreeRate: number | null;
  dimAgg: EvalDimAgg[];
}

/** 单维度画像：均分 / p10 / p90 / 不合格率。不依赖 index，可单独用于维度对比 */
function dimAggOf(evals: ContentEval[]): EvalDimAgg[] {
  return EVAL_DIMENSIONS.map((dim) => {
    const list: number[] = [];
    for (const e of evals) {
      const v = e.scores[dim];
      if (v !== undefined) list.push(v);
    }
    const sorted = [...list].sort((a, b) => a - b);
    const failCount = list.reduce((acc, v) => acc + (gradeOf(v) >= 2 ? 1 : 0), 0);
    return {
      dim,
      label: DIMENSION_LABELS[dim] ?? dim,
      scored: list.length,
      mean: meanOf(list),
      p10: percentile(sorted, 0.1),
      p90: percentile(sorted, 0.9),
      failCount,
      failRate: safeDiv(failCount, list.length),
    };
  });
}

/** 从一组自动评测记录派生全部质量指标 */
export function evalAggregate(evals: ContentEval[], index: ContentIndex): EvalAgg {
  const gradeDist = [0, 0, 0, 0];
  const overalls: number[] = [];
  let humanSampled = 0;
  let humanAgree = 0;

  for (const e of evals) {
    const overall = evalOverallScore(e);
    if (overall === null) continue;
    overalls.push(overall);
    gradeDist[gradeOf(overall)] += 1;

    // 人机一致：同一条内容的自动分档 vs 人工复核分档
    const pair = index.evalByContent.get(e.contentId);
    const human = pair?.find((x) => x.source === 'human');
    const humanScore = human ? evalOverallScore(human) : null;
    if (humanScore !== null) {
      humanSampled += 1;
      if (gradeOf(overall) === gradeOf(humanScore)) humanAgree += 1;
    }
  }

  const evaluated = overalls.length;
  const passCount = gradeDist[0] + gradeDist[1];
  const failCount = gradeDist[2] + gradeDist[3];
  return {
    contents: new Set(evals.map((e) => e.contentId)).size,
    evaluated,
    scored: evaluated,
    overallScore: meanOf(overalls),
    gradeDist,
    passRate: safeDiv(passCount, evaluated),
    failRate: safeDiv(failCount, evaluated),
    humanSampled,
    humanAgree,
    humanAgreeRate: safeDiv(humanAgree, humanSampled),
    dimAgg: dimAggOf(evals),
  };
}

export interface EvalDailyPoint {
  day: string;
  evaluated: number;
  overallScore: number | null;
  passRate: number | null;
  failRate: number | null;
  /** 内容-Query 符合度均值（语义质量的头部指标） */
  relevanceMean: number | null;
  /** 感官维度均值：画面 / 声画 / 素材 */
  visualMean: number | null;
}

const SENSORY_DIMS: EvalDimension[] = ['visual', 'av_sync', 'material'];

function meanOf(list: number[]): number | null {
  return list.length > 0 ? list.reduce((a, b) => a + b, 0) / list.length : null;
}

/** 评测按日趋势（评测与内容同归因到生成日） */
export function evalDailySeries(evals: ContentEval[]): EvalDailyPoint[] {
  const buckets = new Map<string, ContentEval[]>();
  for (const e of evals) {
    const day = dayKey(e.ts);
    const list = buckets.get(day);
    if (list) list.push(e);
    else buckets.set(day, [e]);
  }

  return [...buckets.keys()]
    .sort()
    .map((day) => {
      const list = buckets.get(day)!;
      const gradeDist = [0, 0, 0, 0];
      const relevance: number[] = [];
      const visual: number[] = [];
      let sum = 0;
      for (const e of list) {
        const overall = evalOverallScore(e);
        if (overall === null) continue;
        sum += overall;
        gradeDist[gradeOf(overall)] += 1;
        const rel = e.scores.relevance;
        if (rel !== undefined) relevance.push(rel);
        for (const dim of SENSORY_DIMS) {
          const v = e.scores[dim];
          if (v !== undefined) visual.push(v);
        }
      }
      const n = gradeDist.reduce((a, b) => a + b, 0);
      const pass = gradeDist[0] + gradeDist[1];
      const fail = gradeDist[2] + gradeDist[3];
      return {
        day,
        evaluated: n,
        overallScore: n > 0 ? sum / n : null,
        passRate: safeDiv(pass, n),
        failRate: safeDiv(fail, n),
        relevanceMean: meanOf(relevance),
        visualMean: meanOf(visual),
      };
    });
}

export interface EvalTypeSplit {
  scored: number;
  mean: number | null;
  failRate: number | null;
}

export interface EvalDimRow extends EvalDimAgg {
  /** 均分相对六维平均分的偏离，用于横向对比哪一维最拖后腿 */
  gap: number | null;
  /** 按内容类型拆分：声画一致性只在视频帖一侧有值 */
  img: EvalTypeSplit;
  video: EvalTypeSplit;
}

/** 维度画像：均分 / 分位数 / 不合格率 / 图文与视频对比 */
export function evalDimensionBreakdown(evals: ContentEval[]): EvalDimRow[] {
  const rows = dimAggOf(evals);
  const scored = rows.map((r) => r.mean).filter((v): v is number => v !== null);
  const baseline = meanOf(scored);

  return rows.map((r) => {
    const collect = (type: string): EvalTypeSplit => {
      const list = evals
        .filter((e) => e.contentType === type)
        .map((e) => e.scores[r.dim])
        .filter((v): v is number => v !== undefined);
      const failCount = list.reduce((acc, v) => acc + (gradeOf(v) >= 2 ? 1 : 0), 0);
      return {
        scored: list.length,
        mean: meanOf(list),
        failRate: safeDiv(failCount, list.length),
      };
    };
    return {
      ...r,
      gap: r.mean === null || baseline === null ? null : r.mean - baseline,
      img: collect('CT-IMG'),
      video: collect('CT-VIDEO'),
    };
  });
}

/** Query 意图分类 × 维度 均分热力图 */
export function evalCategoryHeatmap(
  evals: ContentEval[],
  index: ContentIndex,
  dict: Map<string, string>,
): Array<{ key: string; label: string; scored: number; dims: Record<string, number | null> }> {
  const buckets = new Map<string, { total: number; dims: Record<string, number[]> }>();
  for (const e of evals) {
    const cat = index.queryById.get(e.queryId)?.category ?? 'UNKNOWN';
    let slot = buckets.get(cat);
    if (!slot) {
      slot = { total: 0, dims: {} };
      for (const dim of EVAL_DIMENSIONS) slot.dims[dim] = [];
      buckets.set(cat, slot);
    }
    slot.total += 1;
    for (const dim of EVAL_DIMENSIONS) {
      const v = e.scores[dim];
      if (v !== undefined) slot.dims[dim].push(v);
    }
  }

  return [...buckets.entries()]
    .map(([key, slot]) => {
      const dims: Record<string, number | null> = {};
      for (const dim of EVAL_DIMENSIONS) dims[dim] = meanOf(slot.dims[dim]);
      return { key, label: dict.get(key) ?? key, scored: slot.total, dims };
    })
    .sort((a, b) => b.scored - a.scored);
}

export interface EvalBarRow {
  barId: string;
  barName: string;
  category: string;
  tier: string;
  agg: EvalAgg;
}

/** 贴吧维度的质量表现 */
export function evalBarRows(ds: Dataset, sel: SelectedData, index: ContentIndex): EvalBarRow[] {
  const barMap = new Map(ds.bars.map((b) => [b.id, b]));
  const groups = new Map<string, ContentEval[]>();
  for (const e of sel.evals) {
    const list = groups.get(e.barId);
    if (list) list.push(e);
    else groups.set(e.barId, [e]);
  }

  return [...groups.keys()]
    .sort()
    .map((barId) => {
      const bar = barMap.get(barId);
      return {
        barId,
        barName: bar ? bar.name : barId,
        category: bar ? bar.category : '-',
        tier: bar ? bar.tier : '-',
        agg: evalAggregate(groups.get(barId)!, index),
      };
    });
}

export interface EvalGradeConversion {
  grade: GradeKey;
  label: string;
  contents: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  jumps: number;
  jumpSuccess: number;
  jumpRate: number | null;
}

/**
 * 质量分 × 下游转化：按内容档位统计曝光、CTR 与调起成功率。
 * 曝光按内容收敛到「有评测的内容」，分子分母与 Agg.ctr 同口径（点击事件数 / 曝光量）。
 */
export function evalGradeConversion(sel: SelectedData): EvalGradeConversion[] {
  const gradeByContent = new Map<string, GradeKey>();
  for (const e of sel.evals) {
    const overall = evalOverallScore(e);
    if (overall !== null) gradeByContent.set(e.contentId, gradeOf(overall));
  }

  const rows: EvalGradeConversion[] = [0, 1, 2, 3].map((g) => ({
    grade: g as GradeKey,
    label: GRADE_LABELS[g],
    contents: 0,
    impressions: 0,
    clicks: 0,
    ctr: null,
    jumps: 0,
    jumpSuccess: 0,
    jumpRate: null,
  }));

  for (const [, grade] of gradeByContent) rows[grade].contents += 1;
  for (const s of sel.impressionStats) {
    const g = gradeByContent.get(s.contentId);
    if (g === undefined) continue;
    rows[g].impressions += s.impressions;
  }
  for (const c of sel.clicks) {
    const g = gradeByContent.get(c.contentId);
    if (g === undefined) continue;
    rows[g].clicks += 1;
  }
  for (const j of sel.jumpBacks) {
    const g = gradeByContent.get(j.contentId);
    if (g === undefined) continue;
    rows[g].jumps += 1;
    if (j.status === 'success') rows[g].jumpSuccess += 1;
  }
  for (const r of rows) {
    r.ctr = safeDiv(r.clicks, r.impressions);
    r.jumpRate = safeDiv(r.jumpSuccess, r.jumps);
  }
  return rows;
}

export interface EvalIssueRow {
  dim: EvalDimension;
  dimLabel: string;
  reason: string;
  reasonLabel: string;
  count: number;
}

/** 低分原因分布：issues 只在维度分 < 70 时产出，可直接定位扣分点 */
export function evalIssueDist(
  evals: ContentEval[],
  dict: Record<EvalDimension, Map<string, string>>,
  dim?: EvalDimension,
): EvalIssueRow[] {
  const counts = new Map<string, { dim: EvalDimension; reason: string; count: number }>();
  for (const e of evals) {
    for (const it of e.issues) {
      if (dim && it.dim !== dim) continue;
      const key = `${it.dim}::${it.reason}`;
      const cur = counts.get(key);
      if (cur) cur.count += 1;
      else counts.set(key, { dim: it.dim, reason: it.reason, count: 1 });
    }
  }
  return [...counts.values()]
    .map((v) => ({
      dim: v.dim,
      dimLabel: DIMENSION_LABELS[v.dim] ?? v.dim,
      reason: v.reason,
      reasonLabel: dict[v.dim]?.get(v.reason) ?? v.reason,
      count: v.count,
    }))
    .sort((a, b) => b.count - a.count);
}

export interface EvalLowScoreRow {
  contentId: string;
  barId: string;
  barName: string;
  queryId: string;
  queryName: string;
  contentType: string;
  overallScore: number;
  grade: GradeKey;
  gradeLabel: string;
  modelVersion: string;
  issues: Array<{ dim: EvalDimension; dimLabel: string; reasonLabel: string }>;
  /** focusDim 模式下该维度的分；其余模式为 null */
  focusScore: number | null;
}

/**
 * 低分内容 Top N，供下钻查看扣分原因。
 *
 * focusDim 用于 R6-1 这类「单维度不合格率超标」的告警：此时综合分可能仍是「良」，
 * 若只按综合分取样会一条都取不到，因此按该维度自身的分数排序并放宽入选门槛。
 */
export function evalLowScoreContents(
  ds: Dataset,
  sel: SelectedData,
  index: ContentIndex,
  issueDict: Record<EvalDimension, Map<string, string>>,
  limit = 10,
  focusDim?: EvalDimension,
): EvalLowScoreRow[] {
  const barMap = new Map(ds.bars.map((b) => [b.id, b]));
  const rows: EvalLowScoreRow[] = [];

  for (const e of sel.evals) {
    const overall = evalOverallScore(e);
    if (overall === null) continue;
    const grade = gradeOf(overall);
    let focusScore: number | null = null;
    if (focusDim) {
      // 该维度不适用则跳过；只保留在这个维度上确实不合格的内容
      const v = e.scores[focusDim];
      if (v === undefined || gradeOf(v) < 2) continue;
      focusScore = v;
    } else if (grade < 2) {
      continue;
    }
    rows.push({
      contentId: e.contentId,
      barId: e.barId,
      barName: barMap.get(e.barId)?.name ?? e.barId,
      queryId: e.queryId,
      queryName: index.queryById.get(e.queryId)?.name ?? e.queryId,
      contentType: e.contentType,
      overallScore: overall,
      grade,
      gradeLabel: GRADE_LABELS[grade],
      modelVersion: e.modelVersion,
      issues: e.issues.map((it) => ({
        dim: it.dim,
        dimLabel: DIMENSION_LABELS[it.dim] ?? it.dim,
        reasonLabel: issueDict[it.dim]?.get(it.reason) ?? it.reason,
      })),
      focusScore,
    });
  }

  const key = (r: EvalLowScoreRow): number => r.focusScore ?? r.overallScore;
  return rows.sort((a, b) => key(a) - key(b)).slice(0, limit);
}

/** 单条内容的评测明细（自动评测 + 可选的人工复核），供详情抽屉展示 */
export function evalContentDetail(
  index: ContentIndex,
  contentId: string,
): { auto: ContentEval | null; human: ContentEval | null; autoScore: number | null; humanScore: number | null } {
  const list = index.evalByContent.get(contentId) ?? [];
  const auto = list.find((e) => e.source === 'auto') ?? null;
  const human = list.find((e) => e.source === 'human') ?? null;
  return {
    auto,
    human,
    autoScore: auto ? evalOverallScore(auto) : null,
    humanScore: human ? evalOverallScore(human) : null,
  };
}

export type {
  Bar,
  ClickEvent,
  Content,
  ContentType,
  Dataset,
  DateRange,
  DistributeEvent,
  Events,
  Filters,
  GenerationTask,
  ImpressionStat,
  JumpBackEvent,
  QueryDictItem,
  QueryEvent,
  ReviewRecord,
  ReviewStage,
};