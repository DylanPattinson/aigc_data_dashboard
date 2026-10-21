import { useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  Legend,
  Line,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ShieldCheck } from 'lucide-react';
import type { DailyPoint, DistRow, QueryCategoryRow, ReviewPipeline } from '../lib/metrics';
import { COLORS, REVIEW_STAGES, STAGE_COLORS, STAGE_LABELS, THRESHOLDS } from '../lib/config';
import { fmtInt, fmtPct, fmtSec } from '../lib/format';
import { shortDay } from '../lib/time';
import type { ReviewStage } from '../types';
import { ChartCard, ChartTooltip, RatioBar } from './ui';

/* ------------------------------ 流水线组件 ------------------------------- */

function PipelineView({ pipeline }: { pipeline: ReviewPipeline }) {
  return (
    <div>
      {pipeline.steps.map((s, i) => {
        const ratio = s.rateFromTop ?? 0;
        const color = s.stage === 'distribute' ? COLORS.success : STAGE_COLORS[s.stage];
        return (
          <div className="funnel-step" key={s.stage}>
            <div className="funnel-step-head">
              <span className="name">
                {i + 1}. {s.label}
              </span>
              <span className="val">
                {fmtInt(s.value)} 条
                {s.rateFromPrev !== null ? (
                  <span style={{ color: 'var(--c-text-weak)', fontWeight: 400, marginLeft: 8 }}>
                    本环通过率 {fmtPct(s.rateFromPrev)}
                  </span>
                ) : (
                  <span style={{ color: 'var(--c-text-weak)', fontWeight: 400, marginLeft: 8 }}>
                    链路入口
                  </span>
                )}
              </span>
            </div>
            <div className="funnel-bar-wrap">
              <div
                className="funnel-bar"
                style={{
                  width: `${Math.max(1.5, ratio * 100)}%`,
                  background: color,
                  opacity: 1 - i * 0.12,
                }}
              />
            </div>
            <div className="funnel-note">
              <span className="funnel-note-rate">链路留存 {fmtPct(ratio)}</span>
              <span className="funnel-note-hint">{s.hint}</span>
            </div>
          </div>
        );
      })}
      <div className="context-row" style={{ marginTop: 10 }}>
        <span>
          当前待审积压：机审 <b>{fmtInt(pipeline.pendingByStage.auto)}</b> · 人审{' '}
          <b>{fmtInt(pipeline.pendingByStage.manual)}</b> · 质量审核{' '}
          <b>{fmtInt(pipeline.pendingByStage.quality)}</b>
        </span>
      </div>
    </div>
  );
}

/* ------------------------------ 分布条形组件 ----------------------------- */

function DistList({ rows, unit = '条' }: { rows: DistRow[]; unit?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {rows.map((r) => (
        <div
          key={r.key}
          style={{ display: 'grid', gridTemplateColumns: '180px 1fr 110px', gap: 10, alignItems: 'center' }}
        >
          <span style={{ fontSize: 12.5, color: 'var(--c-text-sub)' }}>{r.label}</span>
          <div className="ratio-bar">
            <span style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: COLORS.danger }} />
          </div>
          <span style={{ fontSize: 12.5, textAlign: 'right' }}>
            {fmtInt(r.value)} {unit}
            {r.percent !== null ? (
              <span style={{ color: 'var(--c-text-weak)' }}> · {fmtPct(r.percent, 0)}</span>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------- 主区块 --------------------------------- */

export interface ReviewSectionProps {
  daily: DailyPoint[];
  pipeline: ReviewPipeline;
  /** 各环节拒绝原因字典名下的分布 */
  stageRejectRows: Record<ReviewStage, DistRow[]>;
  queryCategoryRows: QueryCategoryRow[];
  /** 各环节的待审积压 */
  pendingByStage: Record<ReviewStage, number>;
}

export default function ReviewSection({
  daily,
  pipeline,
  stageRejectRows,
  queryCategoryRows,
  pendingByStage,
}: ReviewSectionProps) {
  const [stage, setStage] = useState<ReviewStage>('auto');

  const trendData = useMemo(
    () =>
      daily.map((d) => ({
        day: shortDay(d.day),
        fullDay: d.day,
        autoPass: d.autoPass,
        autoReject: d.autoReject,
        autoPending: d.autoPending,
        manualPass: d.manualPass,
        manualReject: d.manualReject,
        manualPending: d.manualPending,
        qualityPass: d.qualityPass,
        qualityReject: d.qualityReject,
        qualityPending: d.qualityPending,
      })),
    [daily],
  );

  const stageSummary = useMemo(
    () =>
      REVIEW_STAGES.map((s) => {
        const step = pipeline.steps.find((p) => p.stage === s);
        return {
          stage: s,
          label: STAGE_LABELS[s],
          passed: step?.value ?? 0,
          rate: step?.rateFromPrev ?? null,
          pending: pendingByStage[s],
          avgCostMs: step?.avgCostMs ?? null,
        };
      }),
    [pipeline, pendingByStage],
  );

  const isEmpty = daily.length === 0;
  const rejectRows = stageRejectRows[stage];
  const catMax = Math.max(0.001, ...queryCategoryRows.map((r) => Math.abs(r.excessRate ?? 0)));

  return (
    <div className="section" id="sec-review">
      <div className="section-head">
        <h2 className="section-title">
          <span className="idx">3</span> 三层审核与质量控制
        </h2>
        <p className="section-desc">
          机审 → 人审 → 质量审核串行把关，决定有多少内容有资格进入手百搜索结果页
        </p>
      </div>

      <div className="grid-2">
        <ChartCard
          title="三层审核流水线"
          subtitle="每一环的通过量、本环通过率与相对链路入口的留存"
          isEmpty={pipeline.steps[0].value === 0}
          height="auto"
        >
          <PipelineView pipeline={pipeline} />
        </ChartCard>

        <ChartCard
          title="各环节通过 / 拒绝 / 待审趋势"
          subtitle="柱：通过与拒绝条数；线：累计待审积压"
          isEmpty={isEmpty}
          height="auto"
          extra={
            <div className="segmented">
              {REVIEW_STAGES.map((s) => (
                <button key={s} className={stage === s ? 'active' : ''} onClick={() => setStage(s)}>
                  {STAGE_LABELS[s]}
                </button>
              ))}
            </div>
          }
        >
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={trendData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#8a9099' }} minTickGap={16} />
              <YAxis yAxisId="left" tick={{ fontSize: 11, fill: '#8a9099' }} width={48} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: '#8a9099' }} width={48} />
              <Legend wrapperStyle={{ fontSize: 11.5 }} />
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v) => (v === null ? '—' : `${fmtInt(v)} 条`)}
                    labelFormatter={(l) => {
                      const hit = trendData.find((d) => d.day === l);
                      return hit ? String(hit.fullDay) : String(l ?? '');
                    }}
                  />
                }
              />
              <Bar yAxisId="left" dataKey={`${stage}Pass`} name={`${STAGE_LABELS[stage]}通过`} stackId="a" fill={COLORS.success} />
              <Bar yAxisId="left" dataKey={`${stage}Reject`} name={`${STAGE_LABELS[stage]}拒绝`} stackId="a" fill={COLORS.danger} />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey={`${stage}Pending`}
                name="待审积压"
                stroke={COLORS.warn}
                strokeWidth={2}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid-2" style={{ marginTop: 12 }}>
        <ChartCard
          title={`${STAGE_LABELS[stage]}拒绝原因分布`}
          subtitle="原因直接来自审核记录，集中在单一原因时优先修策略或提示词"
          isEmpty={rejectRows.length === 0}
          height="auto"
          emptyText={`${STAGE_LABELS[stage]}在当前筛选下没有拒绝记录`}
        >
          <DistList rows={rejectRows} />
        </ChartCard>

        <ChartCard
          title="各 Query 意图分类的人审拒绝偏离度"
          subtitle="剔除「某天整体审核变严」的日级效应后，分类自身的差异（百分点）"
          isEmpty={queryCategoryRows.length === 0}
          height="auto"
          note={
            <div style={{ fontSize: 11.5, color: 'var(--c-text-weak)' }}>
              正值表示该分类比当日大盘更容易被人审拒绝。仅纳入当日已审核内容 ≥ 5 条的日期。
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {queryCategoryRows.map((r) => (
              <div
                key={r.key}
                style={{ display: 'grid', gridTemplateColumns: '110px 1fr 128px', gap: 10, alignItems: 'center' }}
              >
                <span style={{ fontSize: 12.5, color: 'var(--c-text-sub)' }}>{r.label}</span>
                <div className="ratio-bar" title={`原始拒绝率 ${fmtPct(r.rejectRate)}`}>
                  <span
                    style={{
                      width: `${Math.max(2, (Math.abs(r.excessRate ?? 0) / catMax) * 100)}%`,
                      background: (r.excessRate ?? 0) > 0 ? COLORS.danger : '#93aaf0',
                    }}
                  />
                </div>
                <span style={{ fontSize: 12, textAlign: 'right', color: 'var(--c-text-sub)' }}>
                  {r.excessRate === null ? '—' : `${r.excessRate > 0 ? '+' : ''}${(r.excessRate * 100).toFixed(1)}pp`}
                  <span style={{ color: 'var(--c-text-weak)' }}> · 拒 {fmtPct(r.rejectRate, 0)}</span>
                </span>
              </div>
            ))}
          </div>
        </ChartCard>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-head">
          <div>
            <h3 className="card-title">
              <ShieldCheck size={14} /> 审核环节健康度
            </h3>
            <p className="card-sub">任一环节的拒绝率或积压越过阈值，即在「异常监控」以 R3 规则告警</p>
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>审核环节</th>
                  <th>通过条数</th>
                  <th>本环通过率</th>
                  <th>平均耗时</th>
                  <th>待审积压</th>
                  <th style={{ width: 160 }}>积压水位（阈值 {THRESHOLDS.reviewPendingMaxCount} 条）</th>
                </tr>
              </thead>
              <tbody>
                {stageSummary.map((s) => {
                  const high = (s.rate ?? 1) < 1 - THRESHOLDS.reviewRejectRateMax;
                  return (
                    <tr key={s.stage}>
                      <td>
                        <span
                          className="legend-dot"
                          style={{ background: STAGE_COLORS[s.stage], marginRight: 6, display: 'inline-block' }}
                        />
                        <b>{s.label}</b>
                      </td>
                      <td className="num">{fmtInt(s.passed)}</td>
                      <td className="num">
                        <span style={{ color: high ? COLORS.danger : undefined, fontWeight: high ? 700 : 400 }}>
                          {fmtPct(s.rate)}
                        </span>
                      </td>
                      <td className="num">{fmtSec(s.avgCostMs)}</td>
                      <td className="num">
                        <span style={{ color: s.pending > THRESHOLDS.reviewPendingMaxCount ? COLORS.danger : undefined }}>
                          {fmtInt(s.pending)} 条
                        </span>
                      </td>
                      <td>
                        <RatioBar
                          value={s.pending / THRESHOLDS.reviewPendingMaxCount}
                          color={s.pending > THRESHOLDS.reviewPendingMaxCount ? COLORS.danger : STAGE_COLORS[s.stage]}
                        />
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
