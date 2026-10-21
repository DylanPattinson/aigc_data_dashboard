import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Award, ClipboardCheck, Gauge } from 'lucide-react';
import type {
  EvalAgg,
  EvalBarRow,
  EvalDailyPoint,
  EvalDimAgg,
  EvalDimRow,
  EvalGradeConversion,
  EvalIssueRow,
  EvalLowScoreRow,
} from '../lib/metrics';
import type { EvalDimension } from '../types';
import {
  COLORS,
  DIMENSION_COLORS,
  DIMENSION_LABELS,
  DIMENSION_SHORT,
  DIMENSION_WEIGHTS,
  EVAL_DIMENSIONS,
  GRADE_LABELS,
  SCORE_GRADES,
  THRESHOLDS,
} from '../lib/config';
import { fmtInt, fmtPct, fmtScore } from '../lib/format';
import { shortDay } from '../lib/time';
import { ChartCard, ChartTooltip, RatioBar, renderTooltip } from './ui';

const GRADE_COLORS = [COLORS.success, '#5B9BF5', COLORS.warn, COLORS.danger];

/* ------------------------------- 分档分布环 ------------------------------- */

function GradeDonut({ agg }: { agg: EvalAgg }) {
  const total = agg.gradeDist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let acc = 0;
  const arcs = agg.gradeDist.map((v, i) => {
    const start = acc;
    acc += v;
    return { grade: i, value: v, ratio: v / total, start, end: acc / total };
  });

  const r = 74;
  const cx = 88;
  const cy = 88;
  const arcPath = (from: number, to: number): string => {
    const a0 = from * Math.PI * 2 - Math.PI / 2;
    const a1 = to * Math.PI * 2 - Math.PI / 2;
    const large = to - from > 0.5 ? 1 : 0;
    return `M ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${
      cx + r * Math.cos(a1)
    } ${cy + r * Math.sin(a1)}`;
  };

  return (
    <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg width={176} height={176} style={{ flexShrink: 0 }}>
        {arcs.map((a) =>
          a.value === 0 ? null : (
            <path
              key={a.grade}
              d={arcPath(a.start, a.end)}
              stroke={GRADE_COLORS[a.grade]}
              strokeWidth={26}
              fill="none"
            />
          ),
        )}
        <text x={cx} y={cy - 4} textAnchor="middle" style={{ fontSize: 26, fontWeight: 700, fill: COLORS.text }}>
          {fmtScore(agg.overallScore)}
        </text>
        <text x={cx} y={cy + 16} textAnchor="middle" style={{ fontSize: 11.5, fill: COLORS.textSub }}>
          综合质量分
        </text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 190 }}>
        {arcs.map((a) => (
          <div key={a.grade} style={{ display: 'grid', gridTemplateColumns: '14px 1fr 116px', gap: 8, alignItems: 'center' }}>
            <span className="legend-dot" style={{ background: GRADE_COLORS[a.grade] }} />
            <span style={{ fontSize: 12.5, color: COLORS.textSub }}>
              {GRADE_LABELS[a.grade]}
              <span style={{ color: 'var(--c-text-weak)' }}>
                {' '}
                ≥{a.grade === 0 ? SCORE_GRADES.excellent : a.grade === 1 ? SCORE_GRADES.good : a.grade === 2 ? SCORE_GRADES.fair : 0} 分
              </span>
            </span>
            <span style={{ fontSize: 12.5, textAlign: 'right' }}>
              {fmtInt(a.value)} 条
              <span style={{ color: 'var(--c-text-weak)' }}> · {fmtPct(a.ratio, 1)}</span>
            </span>
          </div>
        ))}
        <div style={{ fontSize: 11.5, color: 'var(--c-text-weak)', marginTop: 2 }}>
          达标率（优+良）{fmtPct(agg.passRate)} · 不合格率（中+差）{fmtPct(agg.failRate)}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 主区块 ---------------------------------- */

export interface EvalSectionProps {
  agg: EvalAgg;
  daily: EvalDailyPoint[];
  dims: EvalDimRow[];
  heatmap: Array<{ key: string; label: string; scored: number; dims: Record<string, number | null> }>;
  barRows: EvalBarRow[];
  conversion: EvalGradeConversion[];
  issueRows: EvalIssueRow[];
  lowRows: EvalLowScoreRow[];
  onSelectBar: (barId: string) => void;
  activeBarId: string;
  onOpenContent: (contentId: string) => void;
}

export default function EvalSection({
  agg,
  daily,
  dims,
  heatmap,
  barRows,
  conversion,
  issueRows,
  lowRows,
  onSelectBar,
  activeBarId,
  onOpenContent,
}: EvalSectionProps) {
  const [focusDim, setFocusDim] = useState<EvalDimension | 'ALL'>('ALL');

  const trendData = useMemo(
    () =>
      daily.map((d) => ({
        day: shortDay(d.day),
        fullDay: d.day,
        overallScore: d.overallScore,
        passRate: d.passRate,
        relevanceMean: d.relevanceMean,
        visualMean: d.visualMean,
        evaluated: d.evaluated,
      })),
    [daily],
  );

  const heatData = useMemo(
    () =>
      heatmap.map((r) => ({
        key: r.key,
        label: r.label,
        scored: r.scored,
        ...Object.fromEntries(EVAL_DIMENSIONS.map((d) => [d, r.dims[d] ?? null])),
      })),
    [heatmap],
  );

  const heatValues = EVAL_DIMENSIONS.flatMap((d) =>
    heatmap.map((r) => r.dims[d]).filter((v): v is number => v !== null),
  );
  const heatMin = heatValues.length > 0 ? Math.floor(Math.min(...heatValues) / 5) * 5 : 0;
  const heatMax = heatValues.length > 0 ? Math.ceil(Math.max(...heatValues) / 5) * 5 : 100;

  const heatColor = (v: number | null): string => {
    if (v === null) return 'var(--c-bg)';
    const t = Math.max(0, Math.min(1, (v - heatMin) / Math.max(1, heatMax - heatMin)));
    // 低分偏红、高分偏绿，中间过渡到蓝；用于「一眼看出哪一格最红」
    if (t < 0.5) {
      const k = t / 0.5;
      return `rgb(${Math.round(224 - 44 * k)}, ${Math.round(72 + 123 * k)}, ${Math.round(60 + 31 * k)})`;
    }
    const k = (t - 0.5) / 0.5;
    return `rgb(${Math.round(180 - 133 * k)}, ${Math.round(195 + 18 * k)}, ${Math.round(91 - 44 * k)})`;
  };

  const shownIssues = focusDim === 'ALL' ? issueRows.slice(0, 10) : issueRows.slice(0, 8);

  return (
    <div className="section" id="sec-eval">
      <div className="section-head">
        <h2 className="section-title">
          <span className="idx">2</span> AIGC 内容评测
        </h2>
        <p className="section-desc">
          评测模型对每条产出内容在 6 个质量维度打 0~100 分并自动分档，人审按比例抽样复核用于校准自动评测；
          任一维度不合格率、综合质量分或人机一致率越过阈值，即在「异常监控」以 R6 规则告警
        </p>
      </div>

      {/* 综合分档 + 人机一致 */}
      <div className="grid-2">
        <ChartCard
          title="综合质量分与档位分布"
          subtitle="综合分 = 适用维度按权重加权；分档：优 ≥85 / 良 70~85 / 中 55~70 / 差 <55"
          isEmpty={agg.evaluated === 0}
          height="auto"
        >
          <GradeDonut agg={agg} />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 10,
              marginTop: 14,
              paddingTop: 12,
              borderTop: '1px solid var(--c-border)',
            }}
          >
            <div>
              <div style={{ fontSize: 11.5, color: 'var(--c-text-sub)' }}>评测覆盖率</div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>
                {fmtPct(agg.contents > 0 ? agg.evaluated / agg.contents : null)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--c-text-weak)' }}>
                已评测 {fmtInt(agg.evaluated)} / 产出 {fmtInt(agg.contents)} 条
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11.5, color: 'var(--c-text-sub)' }}>人机分档一致率</div>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color:
                    agg.humanAgreeRate !== null && agg.humanAgreeRate < THRESHOLDS.evalAgreeRateMin
                      ? COLORS.danger
                      : COLORS.text,
                }}
              >
                {fmtPct(agg.humanAgreeRate)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--c-text-weak)' }}>
                抽样 {fmtInt(agg.humanSampled)} 条 · 一致 {fmtInt(agg.humanAgree)} 条
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11.5, color: 'var(--c-text-sub)' }}>最薄弱维度</div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>
                {(() => {
                  const worst = dims.reduce<EvalDimRow | null>(
                    (acc, d) => (acc === null || (d.failRate ?? 0) > (acc.failRate ?? 0) ? d : acc),
                    null,
                  );
                  return worst ? DIMENSION_SHORT[worst.dim] : '—';
                })()}
              </div>
              <div style={{ fontSize: 11, color: 'var(--c-text-weak)' }}>
                不合格率{' '}
                {(() => {
                  const worst = dims.reduce<EvalDimRow | null>(
                    (acc, d) => (acc === null || (d.failRate ?? 0) > (acc.failRate ?? 0) ? d : acc),
                    null,
                  );
                  return fmtPct(worst?.failRate ?? null);
                })()}
              </div>
            </div>
          </div>
        </ChartCard>

        <ChartCard
          title="质量趋势：综合分 / 达标率 / 语义与感官分"
          subtitle="折线均为 0~100 分制；横轴为内容生成日，与审核、分发同口径"
          isEmpty={daily.length === 0}
          height={318}
          note={
            <div style={{ fontSize: 11.5, color: 'var(--c-text-weak)' }}>
              「内容-Query 符合度」代表语义质量，「感官分」为画面 / 声画 / 素材三维均值：
              两线背离说明是感官链路劣化，两线同步下滑说明是生成模型或提示词问题。
            </div>
          }
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={trendData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#8a9099' }} minTickGap={16} />
              <YAxis domain={[40, 100]} tick={{ fontSize: 11, fill: '#8a9099' }} width={40} />
              <Legend wrapperStyle={{ fontSize: 11.5 }} />
              <ReferenceLine
                y={THRESHOLDS.evalScoreMin}
                stroke={COLORS.danger}
                strokeDasharray="4 4"
                label={{ value: '告警阈值', fontSize: 10, fill: COLORS.danger, position: 'right' }}
              />
              <Tooltip
                content={renderTooltip(({ label, payload }) => (
                  <ChartTooltip
                    payload={payload}
                    label={String(label ?? '')}
                    labelFormatter={(l) => {
                      const hit = trendData.find((d) => d.day === l);
                      return hit ? `${hit.fullDay} · 评测 ${hit.evaluated} 条` : String(l ?? '');
                    }}
                    valueFormatter={(v, k) =>
                      k === 'evaluated' ? (v === null ? '—' : `${fmtInt(v)} 条`) : fmtScore(v)
                    }
                  />
                ))}
              />
              <Bar dataKey="evaluated" name="评测条数" fill="#dfe5f7" radius={[3, 3, 0, 0]} />
              <Line type="monotone" dataKey="overallScore" name="综合质量分" stroke={COLORS.primary} strokeWidth={2.2} dot={false} />
              <Line type="monotone" dataKey="passRate" name="达标率" stroke={COLORS.success} strokeWidth={1.8} dot={false} />
              <Line type="monotone" dataKey="relevanceMean" name="内容-Query 符合度" stroke={DIMENSION_COLORS.relevance} strokeWidth={1.6} dot={false} />
              <Line type="monotone" dataKey="visualMean" name="感官分（画面/声画/素材）" stroke={DIMENSION_COLORS.av_sync} strokeWidth={1.6} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* 维度画像 —— 板块主体 */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-head">
          <div>
            <h3 className="card-title">
              <Gauge size={14} /> 六维质量画像
            </h3>
            <p className="card-sub">
              每个维度的均分、P10~P90 分布区间与不合格率；「偏离六维均值」为负说明该维度相对更弱，是优先改进项
            </p>
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 124 }}>评测维度</th>
                  <th style={{ width: 200 }}>权重</th>
                  <th style={{ width: 120 }}>均分</th>
                  <th style={{ width: 130 }}>P10 ~ P90</th>
                  <th style={{ width: 110 }}>不合格率</th>
                  <th style={{ width: 120 }}>偏离六维均值</th>
                  <th style={{ width: 110 }}>打分量</th>
                  <th>判读</th>
                </tr>
              </thead>
              <tbody>
                {dims.map((d) => {
                  const over = d.failRate !== null && d.failRate > THRESHOLDS.evalFailRateMax;
                  return (
                    <tr key={d.dim}>
                      <td>
                        <span className="legend-dot" style={{ background: DIMENSION_COLORS[d.dim], marginRight: 6, display: 'inline-block' }} />
                        <b>{DIMENSION_LABELS[d.dim]}</b>
                      </td>
                      <td className="num">{(DIMENSION_WEIGHTS[d.dim] * 100).toFixed(0)}%</td>
                      <td className="num">
                        <span style={{ fontSize: 15, fontWeight: 700, color: DIMENSION_COLORS[d.dim] }}>
                          {fmtScore(d.mean)}
                        </span>
                      </td>
                      <td className="num" style={{ fontSize: 12 }}>
                        {fmtScore(d.p10)} ~ {fmtScore(d.p90)}
                      </td>
                      <td className="num">
                        <span style={{ color: over ? COLORS.danger : undefined, fontWeight: over ? 700 : 400 }}>
                          {fmtPct(d.failRate)}
                        </span>
                      </td>
                      <td className="num" style={{ color: (d.gap ?? 0) < 0 ? COLORS.danger : COLORS.textSub }}>
                        {d.gap === null ? '—' : `${d.gap > 0 ? '+' : ''}${d.gap.toFixed(1)}`}
                      </td>
                      <td className="num">{fmtInt(d.scored)}</td>
                      <td style={{ fontSize: 11.5, color: 'var(--c-text-sub)' }}>
                        {over
                          ? `不合格率越过 R6 阈值 ${pctText(THRESHOLDS.evalFailRateMax)}，已在「异常监控」告警`
                          : d.gap !== null && d.gap < -2
                            ? '相对弱于其他维度，改进优先级高'
                            : '处于正常水位'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card-body" style={{ paddingTop: 0 }}>
          <div style={{ fontSize: 11.5, color: 'var(--c-text-weak)' }}>
            权重说明：内容-Query 符合度与事实性合规权重最高（决定是否答非所问、有无风险）；
            画面与素材质量对转化影响大但可通过换素材快速修复，权重略低。
          </div>
        </div>
      </div>

      {/* 图文 vs 视频 */}
      <div className="grid-2" style={{ marginTop: 12 }}>
        <ChartCard
          title="各维度均分：图文帖 vs 视频帖"
          subtitle="声画一致性仅视频帖适用；柱高为该内容类型在该维度的均分"
          isEmpty={dims.every((d) => d.img.scored === 0 && d.video.scored === 0)}
          height={300}
          note={
            <div style={{ fontSize: 11.5, color: 'var(--c-text-weak)' }}>
              同一维度下两根柱差距越大，说明该维度的短板来自内容形态本身（视频的音轨/画面链路），
              而不是模型对该 Query 的理解能力。
            </div>
          }
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={dims} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
              <XAxis
                dataKey="dim"
                tickFormatter={(v: string) => DIMENSION_SHORT[v] ?? v}
                tick={{ fontSize: 11, fill: '#8a9099' }}
              />
              <YAxis domain={[40, 100]} tick={{ fontSize: 11, fill: '#8a9099' }} width={40} />
              <Legend wrapperStyle={{ fontSize: 11.5 }} />
              <Tooltip
                content={renderTooltip(({ payload }) => (
                  <ChartTooltip
                    payload={payload}
                    label={String(payload?.[0]?.payload?.dim ?? '')}
                    labelFormatter={(l) => DIMENSION_LABELS[String(l)] ?? String(l)}
                    valueFormatter={(v) => fmtScore(v)}
                  />
                ))}
              />
              <Bar dataKey="img.mean" name="图文帖均分" fill="#93aaf0" radius={[3, 3, 0, 0]} />
              <Bar dataKey="video.mean" name="视频帖均分" fill={DIMENSION_COLORS.av_sync} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Query 意图分类 × 评测维度 均分热力图"
          subtitle="颜色越红表示该分类在该维度上越弱，可定位「哪类搜索意图产出的内容质量最差」"
          isEmpty={heatmap.length === 0}
          height="auto"
          note={
            <div style={{ fontSize: 11.5, color: 'var(--c-text-weak)' }}>
              色阶范围 {heatMin} ~ {heatMax} 分（按当前筛选内的实际极值取整）。声画一致性列仅统计视频帖。
            </div>
          }
        >
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ minWidth: 92 }}>Query 分类</th>
                  {EVAL_DIMENSIONS.map((d) => (
                    <th key={d} style={{ textAlign: 'center', padding: '6px 4px' }}>
                      {DIMENSION_SHORT[d]}
                    </th>
                  ))}
                  <th className="num">内容数</th>
                </tr>
              </thead>
              <tbody>
                {heatData.map((r) => (
                  <tr key={r.key}>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.label}</td>
                    {EVAL_DIMENSIONS.map((d) => {
                      const v = (r as Record<string, number | null | string>)[d];
                      return (
                        <td
                          key={d}
                          style={{
                            textAlign: 'center',
                            padding: '6px 4px',
                            background: heatColor(typeof v === 'number' ? v : null),
                            color: v !== null && typeof v === 'number' && v - heatMin < (heatMax - heatMin) * 0.55 ? '#fff' : COLORS.text,
                            fontWeight: 600,
                          }}
                        >
                          {typeof v === 'number' ? v.toFixed(0) : '—'}
                        </td>
                      );
                    })}
                    <td className="num">{fmtInt(r.scored)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>
      </div>

      {/* 质量分 × 下游转化 */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-head">
          <div>
            <h3 className="card-title">
              <Award size={14} /> 质量分 × 下游转化关联分析
            </h3>
            <p className="card-sub">
              按内容档位统计曝光、CTR 与调起贴吧成功率：这是「为什么要控质量」的直接证据——
              高质量内容在搜索结果页的点击与调起表现是否真的更好
            </p>
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>质量档位</th>
                  <th style={{ width: 100 }}>内容数</th>
                  <th style={{ width: 190 }}>内容占比</th>
                  <th className="num">曝光量</th>
                  <th className="num">点击</th>
                  <th style={{ width: 110 }}>CTR</th>
                  <th style={{ width: 220 }}>CTR 对比（对齐最低档）</th>
                  <th className="num">调起成功率</th>
                </tr>
              </thead>
              <tbody>
                {conversion.map((r, i) => {
                  const base = conversion[3].ctr;
                  const lift = r.ctr !== null && base !== null && base > 0 && i < 3 ? r.ctr / base : null;
                  return (
                    <tr key={r.grade}>
                      <td>
                        <span className="legend-dot" style={{ background: GRADE_COLORS[r.grade], marginRight: 6, display: 'inline-block' }} />
                        <b>{r.label}</b>
                      </td>
                      <td className="num">{fmtInt(r.contents)}</td>
                      <td>
                        <RatioBar
                          value={
                            conversion.reduce((a, b) => a + b.contents, 0) > 0
                              ? r.contents / conversion.reduce((a, b) => a + b.contents, 0)
                              : null
                          }
                          color={GRADE_COLORS[r.grade]}
                        />
                      </td>
                      <td className="num">{fmtInt(r.impressions)}</td>
                      <td className="num">{fmtInt(r.clicks)}</td>
                      <td className="num" style={{ fontWeight: 700 }}>
                        {fmtPct(r.ctr, 2)}
                      </td>
                      <td>
                        {lift === null ? (
                          <span style={{ color: 'var(--c-text-weak)', fontSize: 12 }}>基准档</span>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <RatioBar value={lift / 3} color={lift >= 1 ? COLORS.success : COLORS.gray} />
                            <span style={{ fontSize: 12, color: lift >= 1 ? COLORS.success : 'var(--c-text-weak)', whiteSpace: 'nowrap' }}>
                              {lift.toFixed(2)}x
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="num">{fmtPct(r.jumpRate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card-body" style={{ paddingTop: 0 }}>
          <div style={{ fontSize: 11.5, color: 'var(--c-text-weak)' }}>
            「差」档样本量小、噪声大，其 CTR 仅作基准参考；结论请以「优 / 良 / 中」三档的梯度是否单调为准。
            分档口径与顶部综合质量分卡完全一致，均由同一份评测记录派生。
          </div>
        </div>
      </div>

      {/* 低分原因 + 低分内容 */}
      <div className="grid-2" style={{ marginTop: 12 }}>
        <ChartCard
          title="低分原因分布"
          subtitle="评测模型只在维度分 < 70 时产出低分原因，可直接定位扣分环节"
          isEmpty={issueRows.length === 0}
          height="auto"
          emptyText="当前筛选下没有触发低分记录的内容"
          extra={
            <div className="segmented">
              <button className={focusDim === 'ALL' ? 'active' : ''} onClick={() => setFocusDim('ALL')}>
                全部
              </button>
              {EVAL_DIMENSIONS.map((d) => (
                <button key={d} className={focusDim === d ? 'active' : ''} onClick={() => setFocusDim(d)}>
                  {DIMENSION_SHORT[d]}
                </button>
              ))}
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {shownIssues.map((r) => {
              const max = Math.max(1, ...shownIssues.map((x) => x.count));
              return (
                <div
                  key={`${r.dim}-${r.reason}`}
                  style={{ display: 'grid', gridTemplateColumns: '92px 1fr 74px', gap: 10, alignItems: 'center' }}
                >
                  <span style={{ fontSize: 12, color: DIMENSION_COLORS[r.dim], fontWeight: 600 }}>
                    {DIMENSION_SHORT[r.dim]}
                  </span>
                  <div>
                    <div style={{ fontSize: 12.5, marginBottom: 3 }}>{r.reasonLabel}</div>
                    <div className="ratio-bar">
                      <span
                        style={{
                          width: `${Math.max(2, (r.count / max) * 100)}%`,
                          background: DIMENSION_COLORS[r.dim],
                        }}
                      />
                    </div>
                  </div>
                  <span style={{ fontSize: 12, textAlign: 'right', color: 'var(--c-text-sub)' }}>
                    {fmtInt(r.count)} 条
                  </span>
                </div>
              );
            })}
          </div>
        </ChartCard>

        <ChartCard
          title="低分内容 Top 10"
          subtitle="综合分最低的内容及其扣分原因，点击可下钻查看该条内容的完整评测"
          isEmpty={lowRows.length === 0}
          height="auto"
          emptyText="当前筛选下没有综合分为「中」或「差」的内容"
        >
          <div className="table-wrap" style={{ maxHeight: 356, overflowY: 'auto' }}>
            <table className="data-table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ width: 62 }}>档位</th>
                  <th style={{ width: 66 }}>综合分</th>
                  <th>内容 / Query</th>
                  <th>扣分原因</th>
                </tr>
              </thead>
              <tbody>
                {lowRows.map((r) => (
                  <tr key={r.contentId} style={{ cursor: 'pointer' }} onClick={() => onOpenContent(r.contentId)}>
                    <td>
                      <span className="badge" style={{ background: `${GRADE_COLORS[r.grade]}1a`, color: GRADE_COLORS[r.grade] }}>
                        {r.gradeLabel}
                      </span>
                    </td>
                    <td className="num" style={{ fontWeight: 700 }}>
                      {fmtScore(r.overallScore)}
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{r.queryName}</div>
                      <div style={{ color: 'var(--c-text-weak)', fontSize: 11 }}>
                        {r.barName} · {r.modelVersion}
                      </div>
                    </td>
                    <td style={{ fontSize: 11.5, color: 'var(--c-text-sub)' }}>
                      {r.issues.length > 0
                        ? r.issues.map((i) => `${DIMENSION_SHORT[i.dim]}：${i.reasonLabel}`).join('；')
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>
      </div>

      {/* 各贴吧质量表现 */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-head">
          <div>
            <h3 className="card-title">
              <ClipboardCheck size={14} /> 各贴吧 AIGC 质量表现
            </h3>
            <p className="card-sub">
              同一套评测口径下的横向对比；「不合格率（最高维度）」取该吧六个维度里最差的一维，与 R6 告警口径一致
            </p>
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 120 }}>贴吧</th>
                  <th className="num">评测内容数</th>
                  <th className="num">综合质量分</th>
                  <th style={{ width: 130 }}>达标率</th>
                  <th style={{ width: 200 }}>档位分布（优/良/中/差）</th>
                  <th className="num">不合格率（最高维度）</th>
                  <th style={{ width: 170 }}>最弱维度</th>
                  <th className="num">人机一致率</th>
                  <th style={{ width: 80 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {barRows.map((r) => {
                  const worst = r.agg.dimAgg.reduce<EvalDimAgg | null>(
                    (acc, d) => (acc === null || (d.failRate ?? 0) > (acc.failRate ?? 0) ? d : acc),
                    null,
                  );
                  const over = worst !== null && (worst.failRate ?? 0) > THRESHOLDS.evalFailRateMax;
                  const gd = r.agg.gradeDist;
                  const gdTotal = gd.reduce((a, b) => a + b, 0);
                  return (
                    <tr key={r.barId} style={{ background: activeBarId === r.barId ? 'var(--c-primary-soft)' : undefined }}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.barName}</div>
                        <div style={{ color: 'var(--c-text-weak)', fontSize: 11.5 }}>
                          {r.category} · {r.tier} 级
                        </div>
                      </td>
                      <td className="num">{fmtInt(r.agg.evaluated)}</td>
                      <td className="num" style={{ fontWeight: 700 }}>
                        {fmtScore(r.agg.overallScore)}
                      </td>
                      <td className="num">{fmtPct(r.agg.passRate)}</td>
                      <td>
                        <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--c-bg)' }}>
                          {GRADE_LABELS.map((label, gi) =>
                            gd[gi] > 0 ? (
                              <span
                                key={label}
                                style={{
                                  width: `${(gd[gi] / gdTotal) * 100}%`,
                                  background: GRADE_COLORS[gi],
                                }}
                                title={`${label} ${gd[gi]} 条`}
                              />
                            ) : null,
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--c-text-weak)', marginTop: 3 }}>
                          {gd.map((v, gi) => `${GRADE_LABELS[gi]} ${fmtInt(v)}`).join(' / ')}
                        </div>
                      </td>
                      <td className="num">
                        <span style={{ color: over ? COLORS.danger : undefined, fontWeight: over ? 700 : 400 }}>
                          {fmtPct(worst?.failRate ?? null)}
                        </span>
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {worst ? (
                          <span style={{ color: DIMENSION_COLORS[worst.dim], fontWeight: 600 }}>
                            {DIMENSION_LABELS[worst.dim]}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="num">{fmtPct(r.agg.humanAgreeRate)}</td>
                      <td>
                        <button className="btn" onClick={() => onSelectBar(r.barId)}>
                          筛选
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function pctText(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}