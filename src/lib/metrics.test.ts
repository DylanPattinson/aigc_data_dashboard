import { describe, expect, it } from 'vitest';
import type { EvalDimension, GenerationTask, ReviewRecord } from '../types';
import {
  aggregate,
  barBreakdown,
  buildContentIndex,
  buildFunnel,
  contentTypeBreakdown,
  crossBarDedupeNote,
  ctrByRank,
  dailySeries,
  durationHistogram,
  evalAggregate,
  evalBarRows,
  evalCategoryHeatmap,
  evalContentDetail,
  evalDailySeries,
  evalDimensionBreakdown,
  evalGradeConversion,
  evalIssueDist,
  evalLowScoreContents,
  evalOverallScore,
  failureReasonDist,
  gradeOf,
  jumpFailReasonDist,
  queryCategoryRejectDist,
  rejectReasonDist,
  reviewPipeline,
  reviewStateOf,
  selectData,
} from './metrics';
import { ALL_PASS, D1, D2, EVAL_ISSUE_IDS, RANGE, build, dict, ts } from './testData';
import type { Spec } from './testData';

// ---------------------------------------------------------------------------

describe('buildContentIndex / reviewStateOf', () => {
  it('三层全部通过才派生 allPassed，缺失或被拒任一环即为 false', () => {
    const b = build([
      { reviews: ALL_PASS },
      { reviews: { auto: 'pass', manual: 'pass' } },
      { reviews: { auto: 'reject', manual: 'pass', quality: 'pass' } },
      { reviews: { auto: 'pass', manual: 'pass', quality: 'reject' } },
    ]);
    expect(reviewStateOf(b.index, b.ids[0].contentId).allPassed).toBe(true);
    expect(reviewStateOf(b.index, b.ids[1].contentId).allPassed).toBe(false);
    expect(reviewStateOf(b.index, b.ids[2].contentId).allPassed).toBe(false);
    expect(reviewStateOf(b.index, b.ids[3].contentId).allPassed).toBe(false);
  });

  it('审核记录缺失时返回空状态而非抛错', () => {
    const b = build([{}]);
    const st = reviewStateOf(b.index, b.ids[0].contentId);
    expect(st.stages).toEqual([]);
    expect(st.allPassed).toBe(false);
    expect(reviewStateOf(b.index, 'NOT_EXIST').allPassed).toBe(false);
  });
});

describe('aggregate · 生成侧', () => {
  it('成功率分母只算已完成的生成尝试，pending 不进入分母', () => {
    const b = build([
      { status: 'success' },
      { status: 'success' },
      { status: 'success' },
      { status: 'failed', durationMs: null },
      { status: 'pending', durationMs: null },
    ]);
    const agg = aggregate({ ...b.events, tasks: b.events.generationTasks, index: b.index });
    expect(agg.tasksTotal).toBe(5);
    expect(agg.tasksSuccess).toBe(3);
    expect(agg.tasksFailed).toBe(1);
    expect(agg.tasksPending).toBe(1);
    expect(agg.completedTasks).toBe(4);
    expect(agg.successRate).toBeCloseTo(0.75, 10);
  });

  it('生成耗时只统计成功任务，失败任务的耗时不会拉高均值', () => {
    const b = build([
      { status: 'success', durationMs: 2000 },
      { status: 'success', durationMs: 4000 },
      { status: 'failed', durationMs: 60000 },
      { status: 'pending', durationMs: 99000 },
    ]);
    const agg = aggregate({ ...b.events, tasks: b.events.generationTasks, index: b.index });
    expect(agg.avgDurationMs).toBeCloseTo(3000, 10);
  });

  it('全部分母为 0 时返回 null，不产生 NaN', () => {
    const b = build([]);
    const agg = aggregate({ ...b.events, tasks: b.events.generationTasks, index: b.index });
    expect(agg.successRate).toBeNull();
    expect(agg.avgDurationMs).toBeNull();
    expect(agg.ctr).toBeNull();
    expect(agg.jumpRate).toBeNull();
    expect(agg.passRate).toBeNull();
  });
});

describe('aggregate · 三层审核', () => {
  it('各环节统计与总通过率口径一致：通过率分母为「至少进入机审」的内容数', () => {
    const b = build([
      { reviews: ALL_PASS }, // 1 过三层
      { reviews: ALL_PASS }, // 2 过三层
      { reviews: { auto: 'pass', manual: 'pass', quality: 'reject' } }, // 3 质量被拒
      { reviews: { auto: 'reject' } }, // 4 机审被拒，不再进入后两层
      { reviews: { auto: 'pass', manual: 'pending' } }, // 5 人审积压
    ]);
    const agg = aggregate({ ...b.events, tasks: b.events.generationTasks, index: b.index });

    expect(agg.stages.auto.entered).toBe(5);
    expect(agg.stages.auto.pass).toBe(4);
    expect(agg.stages.auto.reject).toBe(1);
    expect(agg.stages.auto.pending).toBe(0);
    expect(agg.stages.auto.reviewed).toBe(5);
    expect(agg.stages.auto.rejectRate).toBeCloseTo(0.2, 10);

    // 机审被拒的内容不会进入人审；人审积压的内容不会进入质量审核
    expect(agg.stages.manual.entered).toBe(4);
    expect(agg.stages.manual.pass).toBe(3);
    expect(agg.stages.manual.pending).toBe(1);
    expect(agg.stages.quality.entered).toBe(3);
    expect(agg.stages.quality.pass).toBe(2);
    expect(agg.stages.quality.reject).toBe(1);

    expect(agg.allPassedContents).toBe(2);
    expect(agg.reviewedContents).toBe(5);
    expect(agg.passRate).toBeCloseTo(0.4, 10);
  });

  it('累计待审积压按环节分别计数', () => {
    const b = build([
      { reviews: { auto: 'pending' } },
      { reviews: { auto: 'pass', manual: 'pending' } },
      { reviews: { auto: 'pass', manual: 'pass', quality: 'pending' } },
    ]);
    const agg = aggregate({ ...b.events, tasks: b.events.generationTasks, index: b.index });
    expect(agg.stages.auto.pending).toBe(1);
    expect(agg.stages.manual.pending).toBe(1);
    expect(agg.stages.quality.pending).toBe(1);
  });
});

describe('aggregate · 分发与增长', () => {
  it('CTR = 点击事件数 / 曝光量；调起成功率 = 成功次数 / 调起次数', () => {
    const b = build([
      { reviews: ALL_PASS, rankInPage: 1, impressions: { [D1]: 1000 }, clicks: 50, jumpSuccess: 9, jumpFail: 1 },
      { reviews: ALL_PASS, rankInPage: 5, impressions: { [D1]: 500 }, clicks: 10, jumpSuccess: 5, jumpFail: 5 },
    ]);
    const agg = aggregate({ ...b.events, tasks: b.events.generationTasks, index: b.index });
    expect(agg.impressions).toBe(1500);
    expect(agg.clicks).toBe(60);
    expect(agg.ctr).toBeCloseTo(60 / 1500, 10);
    expect(agg.jumps).toBe(20);
    expect(agg.jumpSuccess).toBe(14);
    expect(agg.jumpRate).toBeCloseTo(0.7, 10);
  });

  it('未过审的内容即使被分发也不计入 distributedContents', () => {
    const b = build([
      { reviews: ALL_PASS, rankInPage: 1, impressions: { [D1]: 100 } },
      { reviews: { auto: 'reject' }, rankInPage: 2, impressions: { [D1]: 100 } },
    ]);
    const agg = aggregate({ ...b.events, tasks: b.events.generationTasks, index: b.index });
    expect(agg.distributes).toBe(2);
    expect(agg.distributedContents).toBe(1);
  });

  it('同一分发多次点击只计一个内容，但点击次数全部计入', () => {
    const b = build([
      { reviews: ALL_PASS, rankInPage: 1, impressions: { [D1]: 100 }, clicks: 5, jumpSuccess: 1 },
    ]);
    const agg = aggregate({ ...b.events, tasks: b.events.generationTasks, index: b.index });
    expect(agg.clicks).toBe(5);
    expect(agg.clickedContents).toBe(1);
    expect(agg.jumpedContents).toBe(1);
  });
});

describe('selectData', () => {
  const b = build([
    { barId: 'B1', contentType: 'CT-IMG', day: D1, reviews: ALL_PASS, rankInPage: 1, impressions: { [D1]: 100 }, clicks: 5 },
    { barId: 'B1', contentType: 'CT-VIDEO', day: D1, reviews: ALL_PASS, rankInPage: 2, impressions: { [D1]: 100 }, clicks: 5 },
    { barId: 'B2', contentType: 'CT-IMG', day: D2, reviews: ALL_PASS, rankInPage: 3, impressions: { [D2]: 200 }, clicks: 20 },
    { barId: 'B2', contentType: 'CT-IMG', day: D1, reviews: ALL_PASS, rankInPage: 4, impressions: { [D1]: 50 } },
  ]);

  it('按内容类型筛选时，下游曝光/点击/调起同步收敛，不串味', () => {
    const sel = selectData(b.ds, { ...RANGE, contentType: 'CT-VIDEO' });
    expect(sel.contents.map((c) => c.contentId)).toEqual([b.ids[1].contentId]);
    expect(sel.evals.map((e) => e.contentId)).toEqual([b.ids[1].contentId]);
    expect(sel.distributes).toHaveLength(1);
    expect(sel.impressionStats).toHaveLength(1);
    expect(sel.clicks).toHaveLength(5);
  });

  it('按贴吧 + 区间筛选，跨天数据按内容生成日归因', () => {
    const sel = selectData(b.ds, { range: { startDate: D2, endDate: D2 }, barId: 'B2', contentType: 'ALL' });
    expect(sel.contents.map((c) => c.contentId)).toEqual([b.ids[2].contentId]);
    expect(sel.impressionStats).toHaveLength(1);
    expect(sel.clicks).toHaveLength(20);
  });

  it('空筛选结果 hasAnyData 为 false', () => {
    const sel = selectData(b.ds, {
      range: { startDate: '2026-01-01', endDate: '2026-01-02' },
      barId: 'ALL',
      contentType: 'ALL',
    });
    expect(sel.hasAnyData).toBe(false);
  });
});

describe('分组序列', () => {
  it('dailySeries 按自然日切分，分发归因到内容生成日', () => {
    const b = build([
      { day: D1, reviews: ALL_PASS, rankInPage: 1, impressions: { [D1]: 100, [D2]: 50 }, clicks: 3 },
      { day: D2, reviews: ALL_PASS, rankInPage: 2, impressions: { [D2]: 200 }, clicks: 9 },
    ]);
    const sel = selectData(b.ds, RANGE);
    const series = dailySeries(sel, b.index);
    expect(series.map((p) => p.day)).toEqual([D1, D2]);
    // 第 2 天的分发归属到第 2 天生成的内容
    expect(series[0].distributes).toBe(1);
    expect(series[1].distributes).toBe(1);
    expect(series[0].impressions).toBe(100);
    // 第 2 天曝光 = 第 1 天生成内容的跨日曝光 50 + 第 2 天内容的曝光 200
    expect(series[1].impressions).toBe(250);
  });

  it('barBreakdown 各吧指标互不重叠，求和等于整体', () => {
    const b = build([
      { barId: 'B1', reviews: ALL_PASS, rankInPage: 1, impressions: { [D1]: 100 }, clicks: 4 },
      { barId: 'B2', reviews: ALL_PASS, rankInPage: 2, impressions: { [D1]: 300 }, clicks: 12 },
    ]);
    const sel = selectData(b.ds, RANGE);
    const rows = barBreakdown(b.ds, sel, b.index);
    const total = aggregate({ ...sel, index: b.index });
    expect(rows.map((r) => r.barId).sort()).toEqual(['B1', 'B2']);
    expect(rows.reduce((s, r) => s + r.agg.impressions, 0)).toBe(total.impressions);
    expect(rows.reduce((s, r) => s + r.agg.clicks, 0)).toBe(total.clicks);
  });

  it('contentTypeBreakdown 固定包含「全部内容」行', () => {
    const b = build([
      { contentType: 'CT-IMG', reviews: ALL_PASS, rankInPage: 1, impressions: { [D1]: 100 } },
      { contentType: 'CT-VIDEO', reviews: ALL_PASS, rankInPage: 2, impressions: { [D1]: 400 } },
    ]);
    const sel = selectData(b.ds, RANGE);
    const rows = contentTypeBreakdown(b.ds, sel, b.index);
    expect(rows.map((r) => r.contentType)).toEqual(['ALL', 'CT-IMG', 'CT-VIDEO']);
    expect(rows[0].agg.impressions).toBe(500);
    expect(rows[1].agg.impressions).toBe(100);
    expect(rows[2].agg.impressions).toBe(400);
  });
});

describe('分布与分桶', () => {
  it('failureReasonDist 只统计失败任务且带字典名称', () => {
    const b = build([
      { status: 'failed', durationMs: null, failureReason: 'FR_TIMEOUT' },
      { status: 'failed', durationMs: null, failureReason: 'FR_TIMEOUT' },
      { status: 'success' },
    ]);
    const rows = failureReasonDist(selectData(b.ds, RANGE), dict({ FR_TIMEOUT: '模型推理超时' }));
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(2);
    expect(rows[0].label).toBe('模型推理超时');
    expect(rows[0].percent).toBeCloseTo(1, 10);
  });

  it('rejectReasonDist 只统计指定环节的拒绝', () => {
    const b = build([
      { reviews: { auto: 'reject' }, rejectReason: '机审-低质' },
      { reviews: { auto: 'reject' }, rejectReason: '机审-违规' },
      { reviews: { auto: 'pass', manual: 'reject' }, rejectReason: '人审-低质' },
      { reviews: ALL_PASS },
    ]);
    const sel = selectData(b.ds, RANGE);
    const auto = rejectReasonDist(sel, b.index, 'auto', dict({ '机审-低质': '低质', '机审-违规': '违规' }));
    expect(auto.reduce((s, r) => s + r.value, 0)).toBe(2);
    expect(auto.map((r) => r.key).sort()).toEqual(['机审-低质', '机审-违规']);
    // 人审字典与机审字典互不串用
    const manual = rejectReasonDist(sel, b.index, 'manual', dict({ '人审-低质': '低质' }));
    expect(manual).toHaveLength(1);
    expect(manual[0].value).toBe(1);
    const quality = rejectReasonDist(sel, b.index, 'quality', dict({}));
    expect(quality).toEqual([]);
  });

  it('jumpFailReasonDist 统计调起失败原因', () => {
    const b = build([
      { reviews: ALL_PASS, rankInPage: 1, impressions: { [D1]: 100 }, clicks: 3, jumpFail: 2 },
      { reviews: ALL_PASS, rankInPage: 2, impressions: { [D1]: 100 }, clicks: 1, jumpSuccess: 1 },
    ]);
    const rows = jumpFailReasonDist(selectData(b.ds, RANGE), dict({ 未安装贴吧App: '未安装贴吧App' }));
    expect(rows[0].value).toBe(2);
  });

  it('durationHistogram 按固定分桶累加，只计成功任务', () => {
    const tasks: GenerationTask[] = [
      { taskId: 'a', ts: ts(D1), barId: 'B1', queryId: 'Q1', contentType: 'CT-IMG', userId: 'U1', status: 'success', durationMs: 1000, failureReason: null },
      { taskId: 'b', ts: ts(D1), barId: 'B1', queryId: 'Q1', contentType: 'CT-IMG', userId: 'U2', status: 'success', durationMs: 5000, failureReason: null },
      { taskId: 'c', ts: ts(D1), barId: 'B1', queryId: 'Q1', contentType: 'CT-IMG', userId: 'U3', status: 'success', durationMs: 26000, failureReason: null },
      { taskId: 'd', ts: ts(D1), barId: 'B1', queryId: 'Q1', contentType: 'CT-IMG', userId: 'U4', status: 'failed', durationMs: null, failureReason: 'FR_TIMEOUT' },
    ];
    const hist = durationHistogram(tasks);
    const byBucket = Object.fromEntries(hist.map((h) => [h.bucket, h.count]));
    expect(byBucket).toEqual({ '0-3s': 1, '3-6s': 1, '6-10s': 0, '10-15s': 0, '15-25s': 0, '>25s': 1 });
  });

  it('ctrByRank 位次 CTR 之和与整体 CTR 口径一致', () => {
    const b = build([
      { reviews: ALL_PASS, rankInPage: 1, impressions: { [D1]: 1000 }, clicks: 50 },
      { reviews: ALL_PASS, rankInPage: 5, impressions: { [D1]: 500 }, clicks: 10 },
    ]);
    const sel = selectData(b.ds, RANGE);
    const agg = aggregate({ ...sel, index: b.index });
    const ranks = ctrByRank(sel);
    expect(ranks.map((r) => r.rank)).toEqual([1, 5]);
    const sumImpressions = ranks.reduce((s, r) => s + r.impressions, 0);
    const sumClicks = ranks.reduce((s, r) => s + r.clicks, 0);
    expect(sumImpressions).toBe(agg.impressions);
    expect(sumClicks).toBe(agg.clicks);
    expect(ranks[0].ctr!).toBeGreaterThan(ranks[1].ctr!);
  });
});

describe('queryCategoryRejectDist', () => {
  it('excessRate 剔除日级效应，按审核样本量加权', () => {
    const specs: Spec[] = [];
    // 「学习方法」全部被拒；「生活经验」全部通过；同一天
    for (let i = 0; i < 6; i += 1) {
      specs.push({ queryId: 'Q1', reviews: { auto: 'pass', manual: 'reject' }, rejectReason: '人审-低质' });
      specs.push({ queryId: 'Q2', reviews: { auto: 'pass', manual: 'pass' } });
    }
    const b = build(specs);
    const rows = queryCategoryRejectDist(
      selectData(b.ds, RANGE),
      b.index,
      dict({ 学习方法: '学习方法', 生活经验: '生活经验' }),
    );
    const study = rows.find((r) => r.key === '学习方法')!;
    const life = rows.find((r) => r.key === '生活经验')!;
    expect(study.rejected).toBe(6);
    expect(study.rejectRate).toBeCloseTo(1, 10);
    expect(life.rejectRate).toBeCloseTo(0, 10);
    expect(study.excessRate!).toBeCloseTo(0.5, 10);
    expect(life.excessRate!).toBeCloseTo(-0.5, 10);
    expect(study.excessDays).toBe(1);
  });
});

describe('reviewPipeline', () => {
  it('四步串行，每步同时给出本步通过率与相对链路首的通过率', () => {
    const b = build([
      { reviews: ALL_PASS, rankInPage: 1 },
      { reviews: ALL_PASS, rankInPage: 2 },
      { reviews: { auto: 'pass', manual: 'reject' } },
      { reviews: { auto: 'reject' } },
      { reviews: { auto: 'pass', manual: 'pass', quality: 'reject' } },
    ]);
    const agg = aggregate({ ...b.events, tasks: b.events.generationTasks, index: b.index });
    const p = reviewPipeline(agg);

    expect(p.steps.map((s) => s.label)).toEqual(['机审', '人审', '质量审核', '可分发']);
    expect(p.steps[0].value).toBe(4);
    expect(p.steps[1].value).toBe(3);
    expect(p.steps[2].value).toBe(2);
    expect(p.steps[3].value).toBe(2);
    expect(p.steps[0].rateFromTop).toBeCloseTo(1, 10);
    expect(p.steps[1].rateFromTop).toBeCloseTo(0.75, 10);
    expect(p.steps[2].rateFromTop).toBeCloseTo(0.5, 10);
    expect(p.steps[3].rateFromPrev).toBeCloseTo(1, 10);
    expect(p.pendingByStage).toEqual({ auto: 0, manual: 0, quality: 0 });
  });
});

describe('buildFunnel', () => {
  it('供给层与增长层分开计量，不混用内容数与曝光数', () => {
    const b = build([
      { reviews: ALL_PASS, rankInPage: 1, impressions: { [D1]: 1000 }, clicks: 60, jumpSuccess: 45, jumpFail: 15 },
      { reviews: { auto: 'reject' } },
    ]);
    const agg = aggregate({ ...b.events, tasks: b.events.generationTasks, index: b.index });
    const f = buildFunnel(agg);

    expect(f.supplyTier.steps.map((s) => s.key)).toEqual(['contents', 'auto', 'manual', 'quality', 'distribute']);
    expect(f.growthTier.steps.map((s) => s.key)).toEqual(['distributed', 'exposed', 'clicked', 'jumped']);
    expect(f.supplyTier.steps[0].value).toBe(2);
    expect(f.supplyTier.steps[1].value).toBe(1);
    expect(f.supplyTier.steps[4].value).toBe(1);
    expect(f.growthTier.steps[0].value).toBe(1);
    expect(f.growthTier.steps[1].value).toBe(1);
    expect(f.growthTier.steps[2].value).toBe(1);
    expect(f.growthTier.steps[3].value).toBe(1);
    expect(f.context.map((c) => c.value)).toContain(1000);
  });
});

describe('crossBarDedupeNote', () => {
  it('多吧时给出重复用户数，单吧时返回 null', () => {
    const multi = build([
      { barId: 'B1' },
      { barId: 'B2' },
      { barId: 'B2' },
    ]);
    // QE1 -> U1(B1), QE2/QE3 -> U2/U3(B2)，无重叠
    const note = crossBarDedupeNote(selectData(multi.ds, RANGE))!;
    expect(note.sumByBar).toBe(3);
    expect(note.globalUnique).toBe(3);
    expect(note.overlap).toBe(0);

    const single = build([{ barId: 'B1' }]);
    expect(crossBarDedupeNote(selectData(single.ds, RANGE))).toBeNull();
  });
});

describe('审核记录防御性处理', () => {
  it('同一内容同一环节出现多条时只保留第一条，不污染通过率', () => {
    const b = build([{ reviews: ALL_PASS }]);
    const dup: ReviewRecord = {
      reviewId: 'dup',
      contentId: b.ids[0].contentId,
      stage: 'auto',
      ts: ts(D1, 13),
      status: 'reject',
      rejectReason: 'RR',
      costMs: 1000,
    };
    const events = { ...b.events, reviews: [...b.events.reviews, dup] };
    const idx = buildContentIndex(events, b.ds.queries);
    expect(reviewStateOf(idx, b.ids[0].contentId).allPassed).toBe(true);
  });

  it('曝光为 0 时点击不计入 CTR 分子', () => {
    const b = build([{ reviews: ALL_PASS, rankInPage: 1, impressions: {}, clicks: 3 }]);
    const agg = aggregate({ ...b.events, tasks: b.events.generationTasks, index: b.index });
    expect(agg.impressions).toBe(0);
    expect(agg.clicks).toBe(3);
    expect(agg.ctr).toBeNull();
    expect(agg.impressionDistributes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AIGC 内容评测
// ---------------------------------------------------------------------------

/** 六维全 90 分，用于构造「优」档内容 */
const HIGH: Partial<Record<EvalDimension, number>> = {
  visual: 90,
  relevance: 90,
  material: 90,
  readability: 90,
  factuality: 90,
};
/** 六维全 40 分，用于构造「差」档内容 */
const LOW: Partial<Record<EvalDimension, number>> = {
  visual: 40,
  relevance: 40,
  material: 40,
  readability: 40,
  factuality: 40,
};

/**
 * 评测函数的输入约定是「自动评测集合」——selectData() 已过滤掉 source = 'human'，
 * 人工复核只经 index.evalByContent 参与人机一致率计算。
 * 这里统一走 selectData 取，避免测试绕过该约定把人工记录当成自动分重复计入。
 */
const autoEvals = (b: ReturnType<typeof build>) => selectData(b.ds, RANGE).evals;

describe('gradeOf / evalOverallScore', () => {
  it('分档阈值：优 ≥85 / 良 70~85 / 中 55~70 / 差 <55', () => {
    expect(gradeOf(85)).toBe(0);
    expect(gradeOf(84.9)).toBe(1);
    expect(gradeOf(70)).toBe(1);
    expect(gradeOf(69.9)).toBe(2);
    expect(gradeOf(55)).toBe(2);
    expect(gradeOf(54.9)).toBe(3);
  });

  it('不适用的维度缺键时权重自动归一，图文帖与视频帖综合分可直接比', () => {
    const b = build([
      { contentType: 'CT-IMG', scores: { visual: 80, relevance: 80, material: 80, readability: 80, factuality: 80 } },
      { contentType: 'CT-VIDEO', scores: { visual: 80, av_sync: 80, relevance: 80, material: 80, readability: 80, factuality: 80 } },
    ]);
    const s = evalOverallScore(autoEvals(b)[0])!;
    const v = evalOverallScore(autoEvals(b)[1])!;
    // 全维度同为 80 分时，加权平均仍为 80，不因维度数不同而偏移
    expect(s).toBeCloseTo(80, 10);
    expect(v).toBeCloseTo(80, 10);
  });

  it('打分权重高的维度拉开差距时综合分更靠近该维度', () => {
    const b = build([{ scores: { visual: 90, relevance: 50, material: 70, readability: 70, factuality: 70 } }]);
    // relevance 权重（0.24）高于 visual（0.16），综合分应低于 70
    expect(evalOverallScore(autoEvals(b)[0])!).toBeLessThan(70);
  });

  it('一条评测没有任何维度分时综合分为 null，不产生 NaN', () => {
    const b = build([{ scores: {} }]);
    expect(evalOverallScore(autoEvals(b)[0])).toBeNull();
  });
});

describe('evalAggregate', () => {
  it('综合分、分档、达标率与内容数口径自洽', () => {
    const b = build([
      { scores: HIGH },
      { scores: HIGH },
      { scores: LOW },
      { scores: {} },
    ]);
    const a = evalAggregate(autoEvals(b), b.index);
    expect(a.contents).toBe(4);
    // 无任何维度分的记录不计入 evaluated
    expect(a.evaluated).toBe(3);
    expect(a.gradeDist[0]).toBe(2);
    expect(a.gradeDist[3]).toBe(1);
    expect(a.passRate).toBeCloseTo(2 / 3, 10);
    expect(a.failRate).toBeCloseTo(1 / 3, 10);
    expect(a.overallScore).toBeCloseTo((90 + 90 + 40) / 3, 10);
  });

  it('人机一致率只统计被人工复核过的内容，且按分档而非分数比对', () => {
    const b = build([
      // 自动 90（优）→ 人工 80（良）：分数差 10 分但档位不同
      { scores: HIGH, humanScores: { visual: 80, relevance: 80, material: 80, readability: 80, factuality: 80 } },
      // 自动 80（良）→ 人工 81（良）：分数不同但同档
      { scores: { visual: 80, relevance: 80, material: 80, readability: 80, factuality: 80 }, humanScores: { visual: 81, relevance: 81, material: 81, readability: 81, factuality: 81 } },
      // 未被抽中人工复核
      { scores: HIGH },
    ]);
    const a = evalAggregate(autoEvals(b), b.index);
    expect(a.humanSampled).toBe(2);
    expect(a.humanAgree).toBe(1);
    expect(a.humanAgreeRate).toBeCloseTo(0.5, 10);
  });

  it('dimAgg 对不适用维度给出 scored = 0 与 null 均值，不计为不合格', () => {
    const b = build([{ contentType: 'CT-IMG', scores: HIGH }, { contentType: 'CT-IMG', scores: HIGH }]);
    const a = evalAggregate(autoEvals(b), b.index);
    const avSync = a.dimAgg.find((d) => d.dim === 'av_sync')!;
    expect(avSync.scored).toBe(0);
    expect(avSync.mean).toBeNull();
    expect(avSync.failRate).toBeNull();
    // 适用维度的打分量应等于已评测内容数
    expect(a.dimAgg.find((d) => d.dim === 'visual')!.scored).toBe(2);
  });

  it('维度不合格率只把「中」及以下计入', () => {
    const b = build([
      { scores: { visual: 90, relevance: 90, material: 90, readability: 90, factuality: 90 } },
      { scores: { visual: 60, relevance: 90, material: 90, readability: 90, factuality: 90 } },
      { scores: { visual: 40, relevance: 90, material: 90, readability: 90, factuality: 90 } },
      { scores: { visual: 70, relevance: 90, material: 90, readability: 90, factuality: 90 } },
    ]);
    const a = evalAggregate(autoEvals(b), b.index);
    const v = a.dimAgg.find((d) => d.dim === 'visual')!;
    expect(v.scored).toBe(4);
    // 60（中）与 40（差）计入，70（良）与 90（优）不计入
    expect(v.failCount).toBe(2);
    expect(v.failRate).toBeCloseTo(0.5, 10);
  });
});

describe('evalDailySeries / evalDimensionBreakdown', () => {
  it('按自然日切分，感官分只汇总画面/声画/素材三维', () => {
    const b = build([
      { day: D1, contentType: 'CT-VIDEO', scores: { visual: 60, av_sync: 60, material: 60, relevance: 90, readability: 90, factuality: 90 } },
      { day: D2, scores: HIGH },
    ]);
    const series = evalDailySeries(autoEvals(b));
    expect(series.map((p) => p.day)).toEqual([D1, D2]);
    expect(series[0].visualMean).toBeCloseTo(60, 10);
    expect(series[0].relevanceMean).toBeCloseTo(90, 10);
    expect(series[1].evaluated).toBe(1);
    expect(series[1].passRate).toBe(1);
  });

  it('维度画像给出相对六维均值的偏离，且图文/视频拆分只在适用侧有值', () => {
    const b = build([
      { contentType: 'CT-IMG', scores: { visual: 90, relevance: 90, material: 90, readability: 90, factuality: 90 } },
      { contentType: 'CT-VIDEO', scores: { visual: 50, av_sync: 50, material: 90, relevance: 90, readability: 90, factuality: 90 } },
    ]);
    const rows = evalDimensionBreakdown(autoEvals(b));
    const visual = rows.find((r) => r.dim === 'visual')!;
    expect(visual.scored).toBe(2);
    expect(visual.img.scored).toBe(1);
    expect(visual.video.scored).toBe(1);
    // 偏离值为负，说明该维低于六维均值
    expect(visual.gap!).toBeLessThan(0);

    const avSync = rows.find((r) => r.dim === 'av_sync')!;
    expect(avSync.img.scored).toBe(0);
    expect(avSync.img.mean).toBeNull();
    expect(avSync.video.mean).toBeCloseTo(50, 10);
  });
});

describe('evalBarRows / evalCategoryHeatmap / evalGradeConversion', () => {
  it('各吧评测互不重叠，内容数求和等于整体', () => {
    const b = build([
      { barId: 'B1', scores: HIGH },
      { barId: 'B1', scores: LOW },
      { barId: 'B2', scores: HIGH },
    ]);
    const sel = selectData(b.ds, RANGE);
    const rows = evalBarRows(b.ds, sel, b.index);
    const total = evalAggregate(sel.evals, b.index);
    expect(rows.map((r) => r.barId)).toEqual(['B1', 'B2']);
    expect(rows.reduce((s, r) => s + r.agg.evaluated, 0)).toBe(total.evaluated);
    expect(rows[0].barName).toBe('甲吧');
  });

  it('Query 分类 × 维度热力图按分类聚合并取字典名', () => {
    const b = build([
      { queryId: 'Q1', scores: HIGH },
      { queryId: 'Q1', scores: HIGH },
      { queryId: 'Q2', scores: LOW },
    ]);
    const rows = evalCategoryHeatmap(autoEvals(b), b.index, dict({ 学习方法: '学习方法', 生活经验: '生活经验' }));
    expect(rows[0].key).toBe('学习方法');
    expect(rows[0].scored).toBe(2);
    expect(rows[0].label).toBe('学习方法');
    expect(rows[0].dims.visual).toBeCloseTo(90, 10);
    expect(rows[1].scored).toBe(1);
  });

  it('质量分档的曝光/点击求和等于有评测内容的总量，CTR 口径与 Agg 一致', () => {
    const b = build([
      { scores: HIGH, reviews: ALL_PASS, rankInPage: 1, impressions: { [D1]: 1000 }, clicks: 100, jumpSuccess: 8, jumpFail: 2 },
      { scores: LOW, reviews: ALL_PASS, rankInPage: 2, impressions: { [D1]: 500 }, clicks: 10, jumpSuccess: 5, jumpFail: 5 },
    ]);
    const sel = selectData(b.ds, RANGE);
    const rows = evalGradeConversion(sel);
    expect(rows[0].contents).toBe(1);
    expect(rows[0].impressions).toBe(1000);
    expect(rows[0].ctr).toBeCloseTo(0.1, 10);
    expect(rows[0].jumpRate).toBeCloseTo(0.8, 10);
    expect(rows[3].contents).toBe(1);
    expect(rows[3].ctr).toBeCloseTo(0.02, 10);
    expect(rows[1].contents).toBe(0);
    expect(rows[1].ctr).toBeNull();
    // 各档求和 = 有评测内容的全部曝光
    expect(rows.reduce((s, r) => s + r.impressions, 0)).toBe(1500);
    expect(rows.reduce((s, r) => s + r.clicks, 0)).toBe(110);
  });
});

describe('evalIssueDist / evalLowScoreContents / evalContentDetail', () => {
  const issueDict = Object.fromEntries(
    Object.entries(EVAL_ISSUE_IDS).map(([dim, id]) => [dim, dict({ [id]: `${dim}-中文原因` })]),
  ) as Record<EvalDimension, Map<string, string>>;

  it('低分原因按维度聚合并带字典名，可按维度筛选', () => {
    const b = build([
      { scores: { visual: 40, relevance: 40, material: 80, readability: 80, factuality: 80 } },
      { scores: { visual: 30, relevance: 80, material: 80, readability: 80, factuality: 80 } },
    ]);
    const rows = evalIssueDist(autoEvals(b), issueDict);
    expect(rows[0].dim).toBe('visual');
    expect(rows[0].count).toBe(2);
    expect(rows[0].reasonLabel).toBe('visual-中文原因');
    const onlyVisual = evalIssueDist(autoEvals(b), issueDict, 'visual');
    expect(onlyVisual).toHaveLength(1);
    expect(evalIssueDist(autoEvals(b), issueDict, 'relevance')[0].count).toBe(1);
  });

  it('低分内容榜只收「中」及以下并按综合分升序', () => {
    const b = build([
      { scores: HIGH },
      { scores: { visual: 50, relevance: 50, material: 50, readability: 50, factuality: 50 } },
      { scores: { visual: 30, relevance: 30, material: 30, readability: 30, factuality: 30 } },
    ]);
    const sel = selectData(b.ds, RANGE);
    const rows = evalLowScoreContents(b.ds, sel, b.index, issueDict, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0].overallScore).toBeLessThan(rows[1].overallScore);
    expect(rows[0].issues.length).toBeGreaterThan(0);
    expect(rows[0].issues[0].reasonLabel).toContain('中文原因');
  });

  it('单条明细同时给出自动评测与人工复核，无复核时 human 为 null', () => {
    const b = build([
      { scores: HIGH, humanScores: { visual: 70, relevance: 70, material: 70, readability: 70, factuality: 70 } },
      { scores: HIGH },
    ]);
    const withHuman = evalContentDetail(b.index, b.ids[0].contentId);
    expect(withHuman.autoScore).toBeCloseTo(90, 10);
    expect(withHuman.humanScore).toBeCloseTo(70, 10);
    const noHuman = evalContentDetail(b.index, b.ids[1].contentId);
    expect(noHuman.human).toBeNull();
    expect(noHuman.humanScore).toBeNull();
    expect(evalContentDetail(b.index, 'NOT_EXIST').auto).toBeNull();
  });
});
