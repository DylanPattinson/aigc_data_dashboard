import { describe, expect, it } from 'vitest';
import type { Spec } from './testData';
import {
  type Anomaly,
  type AnomalyContext,
  buildAnomalyDetail,
  detectAnomalies,
  thresholdTextList,
} from './anomalies';
import { buildDicts } from './data';
import { barBreakdown, selectData } from './metrics';
import { THRESHOLDS } from './config';
import {
  ALL_PASS,
  D1,
  D2,
  D3,
  META,
  RANGE,
  build,
  repeat,
} from './testData';
import type { EvalDimension, Filters } from '../types';

function ctxOf(specs: Spec[], filters: Filters = RANGE): AnomalyContext {
  const b = build(specs);
  const sel = selectData(b.ds, filters);
  return {
    ds: b.ds,
    sel,
    index: b.index,
    filters,
    barRows: barBreakdown(b.ds, sel, b.index),
    dicts: buildDicts(META),
  };
}

const rulesOf = (list: Anomaly[]) => list.map((a) => a.ruleId);
const findRule = (list: Anomaly[], ruleId: Anomaly['ruleId'], barId = 'B1') =>
  list.find((a) => a.ruleId === ruleId && a.barId === barId);

describe('R1 生成成功率', () => {
  it('成功率低于阈值时触发，并带上待验证假设与运营建议', () => {
    const specs: Spec[] = [
      ...repeat(17, { status: 'success' }),
      ...repeat(3, { status: 'failed', durationMs: null, failureReason: 'FR_TIMEOUT' }),
    ];
    const list = detectAnomalies(ctxOf(specs));
    const a = findRule(list, 'R1');
    expect(a).toBeDefined();
    expect(a!.severity).toBe('高');
    expect(a!.granularity).toBe('贴吧·日');
    expect(a!.day).toBe(D1);
    expect(a!.actualText).toBe('85.0%');
    expect(a!.hypotheses.every((h) => h.startsWith('待验证假设'))).toBe(true);
    expect(a!.actions.length).toBeGreaterThan(0);
  });

  it('样本量不足时不触发，避免小样本误报', () => {
    // 3 次尝试中 2 次失败 = 33%，但远低于 genSuccessRateMinSamples
    const list = detectAnomalies(ctxOf([{ status: 'success' }, ...repeat(2, { status: 'failed', durationMs: null })]));
    expect(rulesOf(list)).not.toContain('R1');
  });

  it('成功率跌破 critical 线时升级为「严重」', () => {
    const specs: Spec[] = [
      ...repeat(8, { status: 'success' }),
      ...repeat(12, { status: 'failed', durationMs: null }),
    ];
    const a = findRule(detectAnomalies(ctxOf(specs)), 'R1')!;
    expect(a.severity).toBe('严重');
  });
});

describe('R2 平均生成时长', () => {
  it('均值超阈值时触发，详情给出耗时分桶与最慢任务', () => {
    const specs = repeat(25, { durationMs: 20_000 });
    const ctx = ctxOf(specs);
    const a = findRule(detectAnomalies(ctx), 'R2')!;
    expect(a).toBeDefined();
    expect(a.metricName).toBe('平均生成时长');

    const detail = buildAnomalyDetail(a, ctx);
    expect(detail.facts[0].value).toContain('R2');
    expect(detail.comparison).not.toBeNull();
    expect(detail.distribution?.rows.some((r) => r.value > 0)).toBe(true);
    expect(detail.samples?.rows.length).toBeGreaterThan(0);
  });

  it('耗时正常时不触发', () => {
    const list = detectAnomalies(ctxOf(repeat(25, { durationMs: 3000 })));
    expect(rulesOf(list)).not.toContain('R2');
  });
});

describe('R3 三层审核异常', () => {
  it('只在该环节拒绝率超限时触发，且带上环节名', () => {
    const specs: Spec[] = [
      ...repeat(11, { reviews: { auto: 'pass', manual: 'pass', quality: 'pass' } }),
      ...repeat(9, { reviews: { auto: 'pass', manual: 'reject' }, rejectReason: '人审-低质' }),
    ];
    const list = detectAnomalies(ctxOf(specs));
    const r3 = list.filter((a) => a.ruleId === 'R3');
    expect(r3).toHaveLength(1);
    expect(r3[0].ruleName).toBe('人审环节拒绝率飙升');
    expect(r3[0].metricName).toBe('人审拒绝率');
    expect(r3[0].actualText).toBe('45.0%');
  });

  it('待审积压超限时按「审核积压」定性，且不重复报同一环节', () => {
    const specs: Spec[] = [
      ...repeat(30, { reviews: { auto: 'pass', manual: 'pending' } }),
      ...repeat(30, { reviews: { auto: 'pass', manual: 'pending' } }),
    ];
    const r3 = detectAnomalies(ctxOf(specs)).filter((a) => a.ruleId === 'R3');
    expect(r3).toHaveLength(1);
    expect(r3[0].ruleName).toBe('人审环节审核积压');
    expect(r3[0].actualText).toContain('条待审');
  });

  it('详情给出三层通过率横向对比，并显式标出问题环节', () => {
    const specs: Spec[] = [
      ...repeat(11, { reviews: ALL_PASS }),
      ...repeat(9, { reviews: { auto: 'pass', manual: 'reject' }, rejectReason: '人审-事实错误' }),
    ];
    const ctx = ctxOf(specs);
    const a = findRule(detectAnomalies(ctx), 'R3')!;
    const detail = buildAnomalyDetail(a, ctx);
    expect(detail.comparison?.rows.map((r) => r.name)).toEqual(['机审', '人审', '质量审核']);
    expect(detail.comparison?.rows.filter((r) => r.highlight)).toHaveLength(1);
    expect(detail.samples?.columns).toContain('拒绝原因');
  });
});

describe('R4 Query 分类断供', () => {
  const days7 = [D1, D2, D3, '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19'];
  const range7: Filters = {
    range: { startDate: D1, endDate: '2026-10-19' },
    barId: 'ALL',
    contentType: 'ALL',
  };

  it('某分类连续 3 天供给不足时触发，断供前的历史供给用于对照', () => {
    const specs: Spec[] = [];
    // 前 7 天「学习方法」供给充足（Q1/Q3/Q4 同属该分类）
    for (const d of days7.slice(0, 7)) {
      specs.push(...repeat(3, { queryId: 'Q1', day: d }));
      specs.push(...repeat(3, { queryId: 'Q3', day: d }));
      specs.push(...repeat(2, { queryId: 'Q4', day: d }));
    }
    // 后 3 天改由另一分类供给，「学习方法」断供
    for (const d of days7.slice(7)) specs.push(...repeat(8, { queryId: 'Q2', day: d }));
    const ctx = ctxOf(specs, range7);
    const list = detectAnomalies(ctx);
    const r4 = list.filter((a) => a.ruleId === 'R4');
    expect(r4).toHaveLength(1);
    expect(r4[0].queryCategory).toBe('学习方法');
    expect(r4[0].actualText).toContain('连续 3 天');
    expect(r4[0].sampleText).toContain('断供前日均约 8.0 条');
  });

  it('分类覆盖的 Query 数不足时不判为断供，属结构性低产', () => {
    const specs: Spec[] = [];
    // Q2 是「生活经验」下唯一的 Query，前 7 天每天 4 条、后 3 天每天 1 条
    for (const d of days7.slice(0, 7)) specs.push(...repeat(4, { queryId: 'Q2', day: d }));
    for (const d of days7.slice(7)) specs.push(...repeat(1, { queryId: 'Q2', day: d }));
    const list = detectAnomalies(ctxOf(specs, range7));
    expect(rulesOf(list)).not.toContain('R4');
  });

  it('区间不足 7 天时不触发，避免用短窗口判断供', () => {
    const shortRange: Filters = { range: { startDate: D1, endDate: D3 }, barId: 'ALL', contentType: 'ALL' };
    const specs = [...repeat(8, { queryId: 'Q1', day: D1 }), ...repeat(8, { queryId: 'Q1', day: D2 })];
    const list = detectAnomalies(ctxOf(specs, shortRange));
    expect(rulesOf(list)).not.toContain('R4');
  });
});

describe('R5 分发转化下滑', () => {
  it('CTR 低于阈值时触发，详情附位次 CTR 衰减', () => {
    const specs: Spec[] = [
      { reviews: ALL_PASS, rankInPage: 1, impressions: { [D1]: 40_000 }, clicks: 1200, jumpSuccess: 1000, jumpFail: 10 },
      { reviews: ALL_PASS, rankInPage: 6, impressions: { [D1]: 20_000 }, clicks: 600, jumpSuccess: 500, jumpFail: 5 },
    ];
    const ctx = ctxOf(specs);
    const list = detectAnomalies(ctx);
    const r5 = list.filter((a) => a.ruleId === 'R5');
    expect(r5).toHaveLength(1);
    expect(r5[0].ruleName).toBe('搜索结果 CTR 显著下滑');
    expect(r5[0].severity).toBe('中');

    const detail = buildAnomalyDetail(r5[0], ctx);
    expect(detail.facts.some((f) => f.label === '位次 CTR 衰减')).toBe(true);
    expect(detail.comparison?.rows).toHaveLength(1);
    expect(detail.distribution?.title).toContain('调起贴吧');
  });

  it('曝光量不足时不触发，避免小样本误报', () => {
    const specs: Spec[] = [
      { reviews: ALL_PASS, rankInPage: 1, impressions: { [D1]: 100 }, clicks: 1 },
    ];
    const list = detectAnomalies(ctxOf(specs));
    expect(rulesOf(list)).not.toContain('R5');
  });

  it('调起成功率跌破阈值时按调起维度定性', () => {
    const specs: Spec[] = [
      {
        reviews: ALL_PASS,
        rankInPage: 1,
        impressions: { [D1]: 40_000 },
        clicks: 2600,
        jumpSuccess: 200,
        jumpFail: 800,
      },
    ];
    const r5 = detectAnomalies(ctxOf(specs)).filter((a) => a.ruleId === 'R5');
    expect(r5).toHaveLength(1);
    expect(r5[0].ruleName).toBe('调起贴吧成功率显著下滑');
    expect(r5[0].actualText).toBe('20.0%');
  });
});

describe('R6 内容质量异常', () => {
  /** 全部维度打 90 分，用于构造质量正常的基线 */
  const good: Partial<Record<EvalDimension, number>> = {
    visual: 90,
    relevance: 90,
    material: 90,
    readability: 90,
    factuality: 90,
  };
  /** 仅画面质量崩坏，其余维度正常——用于只触发 R6-1 的单维度场景 */
  const badVisual: Partial<Record<EvalDimension, number>> = {
    visual: 30,
    relevance: 90,
    material: 90,
    readability: 90,
    factuality: 90,
  };

  it('维度不合格率超阈值时触发，且只对表现最差的那个吧告警', () => {
    const specs: Spec[] = [
      ...repeat(220, { barId: 'B1', scores: badVisual }),
      ...repeat(220, { barId: 'B2', scores: good }),
    ];
    const r6 = detectAnomalies(ctxOf(specs)).filter((a) => a.ruleId === 'R6');
    expect(r6).toHaveLength(1);
    expect(r6[0].ruleName).toBe('画面质量维度不合格率偏高');
    expect(r6[0].category).toBe('内容质量');
    expect(r6[0].granularity).toBe('贴吧·区间');
    expect(r6[0].barId).toBe('B1');
    expect(r6[0].actualText).toBe('100.0%');
    // 假设文案必须按维度区分：画面问题指向渲染链路，不应说成提示词问题
    expect(r6[0].hypotheses.join('')).toContain('渲染');
  });

  it('样本量不足 evalMinSamples 时不触发，避免小样本误报', () => {
    // 20 条全低分 = 100% 不合格率，但样本量远低于 200
    const list = detectAnomalies(ctxOf(repeat(20, { scores: badVisual })));
    expect(rulesOf(list)).not.toContain('R6');
  });

  it('综合分跌破下限才触发 R6-2，单维劣化不会误报综合分告警', () => {
    // 全维度 30 分 → 综合分 30，低于 evalScoreMin
    const allBad: Partial<Record<EvalDimension, number>> = {
      visual: 30,
      relevance: 30,
      material: 30,
      readability: 30,
      factuality: 30,
    };
    const ctx = ctxOf(repeat(220, { scores: allBad }));
    const r6 = detectAnomalies(ctx).filter((a) => a.ruleId === 'R6');
    expect(r6.some((a) => a.ruleName === 'AIGC 综合质量分低于阈值')).toBe(true);

    // 仅画面崩坏时综合分仍在阈值以上，不应出现 R6-2
    const only = detectAnomalies(ctxOf(repeat(220, { scores: badVisual }))).filter(
      (a) => a.ruleName === 'AIGC 综合质量分低于阈值',
    );
    expect(only).toHaveLength(0);
  });

  it('人机一致率过低时触发 R6-3，说明自动评测本身不可信', () => {
    // 自动 90（优）→ 人工 65（中），档位必然不一致
    const disagree: Partial<Record<EvalDimension, number>> = {
      visual: 65,
      relevance: 65,
      material: 65,
      readability: 65,
      factuality: 65,
    };
    const specs = repeat(60, { scores: good, humanScores: disagree });
    const ctx = ctxOf(specs);
    const r6 = detectAnomalies(ctx).filter((a) => a.ruleId === 'R6');
    const agree = r6.find((a) => a.ruleName.includes('一致'));
    expect(agree).toBeDefined();
    expect(agree!.actualText).toBe('0.0%');

    const detail = buildAnomalyDetail(agree!, ctx);
    expect(detail.facts.some((f) => f.label === '人机分档一致率')).toBe(true);
  });

  it('人审抽样量不足时不触发 R6-3', () => {
    // 只有 5 条被人工复核，低于 evalAgreeMinSamples(40)
    const specs = repeat(5, { scores: good, humanScores: good });
    const agree = detectAnomalies(ctxOf(specs)).filter((a) => a.ruleName.includes('一致'));
    expect(agree).toHaveLength(0);
  });

  it('质量正常时不触发任何 R6', () => {
    const list = detectAnomalies(ctxOf(repeat(220, { scores: good })));
    expect(rulesOf(list)).not.toContain('R6');
  });

  it('详情给出六维均分对比、低分原因分布与低分内容样例', () => {
    const ctx = ctxOf(repeat(220, { scores: badVisual }));
    const a = findRule(detectAnomalies(ctx), 'R6')!;
    const detail = buildAnomalyDetail(a, ctx);
    expect(detail.comparison?.rows).toHaveLength(6);
    expect(detail.comparison?.rows.some((r) => r.highlight)).toBe(true);
    expect(detail.distribution?.rows.length).toBeGreaterThan(0);
    // 单维劣化时综合分仍是「良」，样例必须按该维度自身排序取样，否则一条都取不到
    expect(detail.samples?.columns).toContain('画面质量');
    expect(detail.samples?.rows.length).toBeGreaterThan(0);
    expect(detail.samples?.rows[0][3]).toBe('30.0');
    expect(detail.samples?.rows[0].join(' ')).toContain('画面模糊');
  });
});

describe('detectAnomalies 整体行为', () => {
  it('结果按「严重 > 高 > 中」排序', () => {
    const specs: Spec[] = [
      ...repeat(15, { barId: 'B1', status: 'success' }),
      ...repeat(5, { barId: 'B1', status: 'failed', durationMs: null }),
      ...repeat(8, { barId: 'B2', status: 'success' }),
      ...repeat(12, { barId: 'B2', status: 'failed', durationMs: null }),
    ];
    const list = detectAnomalies(ctxOf(specs));
    const rank = { 严重: 0, 高: 1, 中: 2 } as const;
    for (let i = 1; i < list.length; i += 1) {
      expect(rank[list[i - 1].severity]).toBeLessThanOrEqual(rank[list[i].severity]);
    }
  });

  it('异常 id 唯一，可直接作为 React key 与详情面板索引', () => {
    const specs: Spec[] = [
      ...repeat(15, { status: 'success' }),
      ...repeat(5, { status: 'failed', durationMs: null }),
      ...repeat(25, { durationMs: 20_000 }),
    ];
    const list = detectAnomalies(ctxOf(specs));
    expect(new Set(list.map((a) => a.id)).size).toBe(list.length);
  });

  it('thresholdTextList 覆盖 R1-R6 六条规则且与配置一致', () => {
    const texts = thresholdTextList();
    expect(texts).toHaveLength(6);
    expect(texts.map((t) => t.rule.slice(0, 2))).toEqual([
      'R1',
      'R2',
      'R3',
      'R4',
      'R5',
      'R6',
    ]);
    expect(texts[0].text).toContain(String(Math.round(THRESHOLDS.genSuccessRateMin * 100)));
    expect(texts[5].text).toContain(String(THRESHOLDS.evalScoreMin));
  });
});
