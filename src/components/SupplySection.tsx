import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Layers } from 'lucide-react';
import type { BarRow, ContentTypeRow, DailyPoint, FunnelModel } from '../lib/metrics';
import { COLORS, THRESHOLDS } from '../lib/config';
import { fmtInt, fmtPct, fmtSec } from '../lib/format';
import { shortDay } from '../lib/time';
import { ChartCard, ChartTooltip, RatioBar, renderTooltip } from './ui';

/* ------------------------------- 漏斗组件 -------------------------------- */

function FunnelView({ model }: { model: FunnelModel }) {
  const renderTier = (
    tier: { title: string; unit: string; steps: FunnelModel['supplyTier']['steps'] },
    baseColor: string,
  ) => (
    <div className="funnel-tier">
      <div className="funnel-tier-title">
        <span>{tier.title}</span>
        <span>单位：{tier.unit}</span>
      </div>
      {tier.steps.map((s, i) => {
        const ratio = s.rateFromTop ?? 0;
        return (
          <div className="funnel-step" key={s.key}>
            <div className="funnel-step-head">
              <span className="name">{s.label}</span>
              <span className="val">
                {fmtInt(s.value)} {tier.unit}
                {s.rateFromPrev !== null ? (
                  <span style={{ color: 'var(--c-text-weak)', fontWeight: 400, marginLeft: 8 }}>
                    上一步转化 {fmtPct(s.rateFromPrev)}
                  </span>
                ) : null}
              </span>
            </div>
            <div className="funnel-bar-wrap">
              <div
                className="funnel-bar"
                style={{
                  width: `${Math.max(1.5, ratio * 100)}%`,
                  background: baseColor,
                  opacity: 1 - i * 0.13,
                }}
              />
            </div>
            <div className="funnel-note">
              <span className="funnel-note-rate">占本层首步 {fmtPct(ratio)}</span>
              <span className="funnel-note-hint">{s.hint}</span>
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <div>
      {renderTier(model.supplyTier, COLORS.primary)}
      <hr className="funnel-divider" />
      {renderTier(model.growthTier, COLORS.purple)}
      <div className="context-row">
        {model.context.map((c) => (
          <span key={c.label}>
            {c.label}：<b>{fmtInt(c.value)}</b>
          </span>
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--c-text-weak)' }}>
        <div>供给层统计「内容条数」，增长层同样统计「内容条数」，两层不与曝光量、点击量混算转化率。</div>
        <div>曝光量、点击事件数、调起事件数是量级最大的过程量，只在上方作为上下文展示，不进入漏斗。</div>
      </div>
    </div>
  );
}

/* -------------------------------- 主区块 --------------------------------- */

export interface SupplySectionProps {
  daily: DailyPoint[];
  funnel: FunnelModel;
  barRows: BarRow[];
  typeRows: ContentTypeRow[];
  onSelectBar: (barId: string) => void;
  activeBarId: string;
}

type SortKey = 'contentTotal' | 'successRate' | 'avgDurationMs' | 'passRate';

export default function SupplySection({
  daily,
  funnel,
  barRows,
  typeRows,
  onSelectBar,
  activeBarId,
}: SupplySectionProps) {
  const [sortKey, setSortKey] = useState<SortKey>('contentTotal');

  const chartData = useMemo(
    () =>
      daily.map((d) => ({
        day: shortDay(d.day),
        fullDay: d.day,
        tasksSuccess: d.tasksSuccess,
        tasksFailed: d.tasksFailed,
        successRate: d.successRate === null ? null : Number((d.successRate * 100).toFixed(2)),
        contentTotal: d.contentTotal,
      })),
    [daily],
  );

  const barChartData = useMemo(
    () =>
      [...barRows]
        .sort((a, b) => b.agg.contentTotal - a.agg.contentTotal)
        .map((r) => ({
          name: r.barName,
          barId: r.barId,
          contentTotal: r.agg.contentTotal,
          successRateText: fmtPct(r.agg.successRate, 0),
        })),
    [barRows],
  );

  const typeChartData = useMemo(
    () =>
      typeRows
        .filter((r) => r.contentType !== 'ALL')
        .map((r) => ({
          name: r.contentTypeName,
          contentType: r.contentType,
          contentTotal: r.agg.contentTotal,
          distributed: r.agg.distributedContents,
          avgDurationMs: r.agg.avgDurationMs,
        })),
    [typeRows],
  );

  const sortedRows = useMemo(() => {
    const val = (r: BarRow): number => {
      if (sortKey === 'contentTotal') return r.agg.contentTotal;
      if (sortKey === 'successRate') return r.agg.successRate ?? -1;
      if (sortKey === 'avgDurationMs') return r.agg.avgDurationMs ?? -1;
      return r.agg.passRate ?? -1;
    };
    return [...barRows].sort((a, b) => val(b) - val(a));
  }, [barRows, sortKey]);

  const isEmpty = daily.length === 0;
  const maxContent = Math.max(1, ...barRows.map((r) => r.agg.contentTotal));

  const th = (key: SortKey, label: string) => (
    <th
      style={{ cursor: 'pointer', color: sortKey === key ? COLORS.primary : undefined }}
      onClick={() => setSortKey(key)}
      title="点击按该列排序"
    >
      {label} {sortKey === key ? '↓' : ''}
    </th>
  );

  return (
    <div className="section" id="sec-supply">
      <div className="section-head">
        <h2 className="section-title">
          <span className="idx">1</span> 内容供给与生成质量
        </h2>
        <p className="section-desc">
          AIGC 针对搜索 Query 批量生产图文帖 / 视频帖的规模、成功率与耗时表现
        </p>
      </div>

      <div className="grid-2">
        <ChartCard
          title="每日内容产出趋势"
          subtitle="按内容生成日归属（条）"
          isEmpty={isEmpty}
          height={250}
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gradContent" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLORS.primary} stopOpacity={0.32} />
                  <stop offset="100%" stopColor={COLORS.primary} stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#8a9099' }} minTickGap={16} />
              <YAxis tick={{ fontSize: 11, fill: '#8a9099' }} width={48} />
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v) => (v === null ? '—' : `${fmtInt(v)} 条`)}
                    labelFormatter={(l) => {
                      const hit = chartData.find((d) => d.day === l);
                      return hit ? hit.fullDay : String(l ?? '');
                    }}
                  />
                }
              />
              <Area
                type="monotone"
                dataKey="contentTotal"
                name="产出内容"
                stroke={COLORS.primary}
                strokeWidth={2}
                fill="url(#gradContent)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="生成成功 / 失败与成功率"
          subtitle="柱：任务次数（生成中不入柱）；线：当日成功率（%）"
          isEmpty={isEmpty}
          height={250}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#8a9099' }} minTickGap={16} />
              <YAxis yAxisId="left" tick={{ fontSize: 11, fill: '#8a9099' }} width={48} />
              <YAxis
                yAxisId="right"
                orientation="right"
                domain={[50, 100]}
                tick={{ fontSize: 11, fill: '#8a9099' }}
                width={52}
                unit="%"
              />
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v, k) =>
                      v === null ? '—' : k === 'successRate' ? `${v.toFixed(1)}%` : `${fmtInt(v)} 次`
                    }
                    labelFormatter={(l) => {
                      const hit = chartData.find((d) => d.day === l);
                      return hit ? hit.fullDay : String(l ?? '');
                    }}
                  />
                }
              />
              <Bar yAxisId="left" dataKey="tasksSuccess" name="生成成功" stackId="a" fill={COLORS.success} />
              <Bar yAxisId="left" dataKey="tasksFailed" name="生成失败" stackId="a" fill={COLORS.danger} />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="successRate"
                name="成功率"
                stroke={COLORS.primary}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid-2" style={{ marginTop: 12 }}>
        <ChartCard
          title="Query → 生成 → 三层审核 → 分发到手百"
          subtitle="分层漏斗：供给层与增长层均以内容条数计量"
          isEmpty={funnel.supplyTier.steps[0].value === 0}
          height="auto"
        >
          <FunnelView model={funnel} />
        </ChartCard>

        <ChartCard
          title="各贴吧内容产出对比"
          subtitle="条形：产出内容数（条）；标签：生成成功率"
          isEmpty={barChartData.length === 0}
          height={392}
          note={
            <div style={{ fontSize: 11.5, color: 'var(--c-text-weak)' }}>
              <div>点击条形或下方表格行可下钻到该贴吧。</div>
              <div>
                产出高但三层通过率低的贴吧，说明质量控制卡住了供给，详见「三层审核」；产出低的贴吧需先确认是否属于
                Query 分类断供（R4）。
              </div>
            </div>
          }
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={barChartData}
              layout="vertical"
              margin={{ top: 8, right: 68, left: 4, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: '#8a9099' }} />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 11, fill: '#646a73' }}
                width={84}
              />
              <Tooltip
                cursor={{ fill: '#f5f7fa' }}
                content={renderTooltip(({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const d = payload[0].payload as unknown as {
                    name: string;
                    contentTotal: number;
                    successRateText: string;
                  };
                  return (
                    <div className="chart-tooltip">
                      <div className="t-title">{d.name}</div>
                      <div className="t-row">
                        <span>产出内容</span>
                        <b>{fmtInt(d.contentTotal)} 条</b>
                      </div>
                      <div className="t-row">
                        <span>生成成功率</span>
                        <b>{d.successRateText}</b>
                      </div>
                    </div>
                  );
                })}
              />
              <Bar
                dataKey="contentTotal"
                name="产出内容"
                radius={[0, 4, 4, 0]}
                onClick={(d: unknown) => {
                  const row = d as { barId?: string };
                  if (row?.barId) onSelectBar(row.barId);
                }}
              >
                {barChartData.map((d) => (
                  <Cell
                    key={d.barId}
                    fill={d.barId === activeBarId ? COLORS.primary : '#93aaf0'}
                    cursor="pointer"
                  />
                ))}
                <LabelList
                  dataKey="successRateText"
                  position="right"
                  style={{ fontSize: 11, fill: '#646a73' }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid-2" style={{ marginTop: 12 }}>
        <ChartCard
          title="图文帖 vs 视频帖"
          subtitle="视频帖生成耗时通常显著高于图文帖，供给配比直接影响产能"
          isEmpty={typeChartData.length === 0}
          height={250}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={typeChartData} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#8a9099' }} />
              <YAxis yAxisId="left" tick={{ fontSize: 11, fill: '#8a9099' }} width={48} />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 11, fill: '#8a9099' }}
                width={56}
                unit="s"
              />
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v, k) =>
                      v === null ? '—' : k === 'avgDurationMs' ? fmtSec(v) : `${fmtInt(v)} 条`
                    }
                  />
                }
              />
              <Bar yAxisId="left" dataKey="contentTotal" name="产出内容" fill={COLORS.primary} radius={[4, 4, 0, 0]} />
              <Bar yAxisId="left" dataKey="distributed" name="分发到手百" fill={COLORS.purple} radius={[4, 4, 0, 0]} />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="avgDurationMs"
                name="平均生成时长"
                stroke={COLORS.warn}
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="各贴吧供给明细（点击行下钻）"
          subtitle="按所选统计区间计算；点击表头可切换排序"
          isEmpty={sortedRows.length === 0}
          height="auto"
        >
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>贴吧</th>
                  {th('contentTotal', '产出内容')}
                  {th('successRate', '生成成功率')}
                  {th('avgDurationMs', '平均时长')}
                  {th('passRate', '三层通过率')}
                  <th>分发到手百</th>
                  <th style={{ width: 90 }}>供给占比</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => (
                  <tr
                    key={r.barId}
                    className="clickable"
                    onClick={() => onSelectBar(r.barId)}
                    style={r.barId === activeBarId ? { background: 'var(--c-primary-soft)' } : undefined}
                  >
                    <td>
                      <div style={{ fontWeight: 600 }}>{r.barName}</div>
                      <div style={{ color: 'var(--c-text-weak)', fontSize: 11.5 }}>
                        {r.category} · {r.tier} 级
                      </div>
                    </td>
                    <td className="num">{fmtInt(r.agg.contentTotal)}</td>
                    <td className="num">
                      <span
                        style={{
                          color: (r.agg.successRate ?? 1) < THRESHOLDS.genSuccessRateMin ? COLORS.danger : undefined,
                          fontWeight: (r.agg.successRate ?? 1) < THRESHOLDS.genSuccessRateMin ? 700 : 400,
                        }}
                      >
                        {fmtPct(r.agg.successRate)}
                      </span>
                      <div style={{ color: 'var(--c-text-weak)', fontSize: 11 }}>
                        失败 {fmtInt(r.agg.tasksFailed)} 次
                      </div>
                    </td>
                    <td className="num">
                      <span
                        style={{
                          color:
                            (r.agg.avgDurationMs ?? 0) > THRESHOLDS.avgDurationMaxMs ? COLORS.danger : undefined,
                        }}
                      >
                        {fmtSec(r.agg.avgDurationMs)}
                      </span>
                    </td>
                    <td className="num">{fmtPct(r.agg.passRate)}</td>
                    <td className="num">{fmtInt(r.agg.distributedContents)}</td>
                    <td>
                      <RatioBar value={r.agg.contentTotal / maxContent} color={COLORS.primary} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-head">
          <div>
            <h3 className="card-title">
              <Layers size={14} /> 供给口径说明
            </h3>
          </div>
        </div>
        <div className="card-body">
          <div style={{ fontSize: 12.5, color: 'var(--c-text-sub)', lineHeight: 1.9 }}>
            <div>· 「产出内容」按内容生成日归属；同一任务的多个版本各自计一条内容。</div>
            <div>· 生成成功率分母为 success + failed，生成中的任务不计入，避免口径虚高。</div>
            <div>· 平均生成时长只统计成功任务，失败与生成中任务不会拉高均值。</div>
            <div>· 三层通过率 = 三层全部 pass 的内容数 / 至少进入机审的内容数。</div>
          </div>
        </div>
      </div>
    </div>
  );
}
