import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { MousePointerClick, MousePointerSquareDashed, PhoneCall } from 'lucide-react';
import type { Agg, BarRow, DailyPoint, DistRow } from '../lib/metrics';
import { COLORS, THRESHOLDS } from '../lib/config';
import { fmtInt, fmtPct } from '../lib/format';
import { shortDay } from '../lib/time';
import { ChartCard, ChartTooltip, RatioBar, renderTooltip } from './ui';

/* ------------------------------ 位次 CTR 组件 ---------------------------- */

function RankCtrChart({ rows }: { rows: Array<{ rank: number; impressions: number; clicks: number; ctr: number | null }> }) {
  const data = useMemo(
    () =>
      rows.map((r) => ({
        rank: `第${r.rank}位`,
        rankNo: r.rank,
        impressions: r.impressions,
        clicks: r.clicks,
        ctrText: fmtPct(r.ctr),
        ctrNum: r.ctr === null ? null : Number((r.ctr * 100).toFixed(2)),
      })),
    [rows],
  );

  if (data.length === 0) return null;

  // 第 1 位作为对比基准：低位次的 CTR 若与它接近，说明不是位次问题
  const top = data[0].ctrNum;
  return (
    <>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={data} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
          <XAxis dataKey="rank" tick={{ fontSize: 11, fill: '#8a9099' }} />
          <YAxis yAxisId="left" tick={{ fontSize: 11, fill: '#8a9099' }} width={52} />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 11, fill: '#8a9099' }}
            width={56}
            unit="%"
          />
          <Legend wrapperStyle={{ fontSize: 11.5 }} />
          <Tooltip
            content={
              <ChartTooltip
                valueFormatter={(v, k) =>
                  v === null ? '—' : k === 'ctrNum' ? `${v.toFixed(2)}%` : `${fmtInt(v)} 次`
                }
              />
            }
          />
          <Bar yAxisId="left" dataKey="impressions" name="曝光量" fill="#c7d4f7" radius={[4, 4, 0, 0]} />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="ctrNum"
            name="位次 CTR"
            stroke={COLORS.primary}
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
      {top !== null ? (
        <div style={{ fontSize: 11.5, color: 'var(--c-text-weak)', marginTop: 6 }}>
          第 1 位 CTR {top.toFixed(2)}% 作为基准：低位次与其差距越小，说明用户并不依赖首位，内容本身吸引力才是关键。
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------ 分布条形组件 ----------------------------- */

function DistList({ rows, color }: { rows: DistRow[]; color: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {rows.map((r) => (
        <div
          key={r.key}
          style={{ display: 'grid', gridTemplateColumns: '190px 1fr 118px', gap: 10, alignItems: 'center' }}
        >
          <span style={{ fontSize: 12.5, color: 'var(--c-text-sub)' }}>{r.label}</span>
          <div className="ratio-bar">
            <span style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: color }} />
          </div>
          <span style={{ fontSize: 12.5, textAlign: 'right' }}>
            {fmtInt(r.value)} 次
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

export interface DistributionSectionProps {
  daily: DailyPoint[];
  barRows: BarRow[];
  agg: Agg;
  /** 搜索结果页位次 CTR 衰减，分母口径与 Agg.ctr 一致 */
  rankRows: Array<{ rank: number; impressions: number; clicks: number; ctr: number | null }>;
  jumpFailRows: DistRow[];
  onSelectBar: (barId: string) => void;
  activeBarId: string;
}

export default function DistributionSection({
  daily,
  barRows,
  agg,
  rankRows,
  jumpFailRows,
  onSelectBar,
  activeBarId,
}: DistributionSectionProps) {
  const trendData = useMemo(
    () =>
      daily.map((d) => ({
        day: shortDay(d.day),
        fullDay: d.day,
        distributes: d.distributes,
        impressions: d.impressions,
        clicks: d.clicks,
        jumpSuccess: d.jumpSuccess,
        jumpFailed: d.jumpFailed,
        ctr: d.ctr === null ? null : Number((d.ctr * 100).toFixed(2)),
        jumpRate: d.jumpRate === null ? null : Number((d.jumpRate * 100).toFixed(2)),
      })),
    [daily],
  );

  const ctrChartData = useMemo(
    () =>
      [...barRows]
        .filter((r) => r.agg.impressions > 0)
        .sort((a, b) => (b.agg.ctr ?? 0) - (a.agg.ctr ?? 0))
        .map((r) => ({
          name: r.barName,
          barId: r.barId,
          ctrNum: r.agg.ctr === null ? null : Number((r.agg.ctr * 100).toFixed(2)),
          ctrText: fmtPct(r.agg.ctr),
        })),
    [barRows],
  );

  const sortedRows = useMemo(
    () => [...barRows].sort((a, b) => b.agg.impressions - a.agg.impressions),
    [barRows],
  );

  const maxImpressions = Math.max(1, ...barRows.map((r) => r.agg.impressions));
  const isEmpty = daily.length === 0;

  return (
    <div className="section" id="sec-distribution">
      <div className="section-head">
        <h2 className="section-title">
          <span className="idx">4</span> 分发与用户增长
        </h2>
        <p className="section-desc">
          优质内容到手百搜索结果页后的曝光、点击与调起贴吧表现——链接条链路的最终结果
        </p>
      </div>

      <div className="grid-2">
        <ChartCard
          title="搜索结果页曝光 → 点击 → 调起趋势"
          subtitle="柱：曝光与点击次数；线：当日 CTR（%）。曝光按曝光日归属，点击与调起归因到内容生成日"
          isEmpty={isEmpty}
          height={280}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={trendData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#8a9099' }} minTickGap={16} />
              <YAxis yAxisId="left" tick={{ fontSize: 11, fill: '#8a9099' }} width={54} />
              <YAxis
                yAxisId="right"
                orientation="right"
                domain={[0, 30]}
                tick={{ fontSize: 11, fill: '#8a9099' }}
                width={52}
                unit="%"
              />
              <Legend wrapperStyle={{ fontSize: 11.5 }} />
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v, k) =>
                      v === null ? '—' : k === 'ctr' ? `${v.toFixed(2)}%` : `${fmtInt(v)} 次`
                    }
                    labelFormatter={(l) => {
                      const hit = trendData.find((d) => d.day === l);
                      return hit ? hit.fullDay : String(l ?? '');
                    }}
                  />
                }
              />
              <Bar yAxisId="left" dataKey="impressions" name="曝光量" fill="#c7d4f7" radius={[4, 4, 0, 0]} />
              <Bar yAxisId="left" dataKey="clicks" name="点击次数" fill={COLORS.primary} radius={[4, 4, 0, 0]} />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="ctr"
                name="CTR"
                stroke={COLORS.purple}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="调起贴吧成功率趋势"
          subtitle="柱：成功 / 失败调起次数；线：当日调起成功率（%）"
          isEmpty={isEmpty}
          height={280}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={trendData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#8a9099' }} minTickGap={16} />
              <YAxis yAxisId="left" tick={{ fontSize: 11, fill: '#8a9099' }} width={48} />
              <YAxis
                yAxisId="right"
                orientation="right"
                domain={[0, 100]}
                tick={{ fontSize: 11, fill: '#8a9099' }}
                width={48}
                unit="%"
              />
              <Legend wrapperStyle={{ fontSize: 11.5 }} />
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v, k) =>
                      v === null ? '—' : k === 'jumpRate' ? `${v.toFixed(1)}%` : `${fmtInt(v)} 次`
                    }
                    labelFormatter={(l) => {
                      const hit = trendData.find((d) => d.day === l);
                      return hit ? hit.fullDay : String(l ?? '');
                    }}
                  />
                }
              />
              <Bar yAxisId="left" dataKey="jumpSuccess" name="成功调起" stackId="j" fill={COLORS.success} />
              <Bar yAxisId="left" dataKey="jumpFailed" name="调起失败" stackId="j" fill={COLORS.danger} />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="jumpRate"
                name="调起成功率"
                stroke={COLORS.warn}
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
          title="搜索结果页位次 CTR 衰减"
          subtitle="柱：各位次曝光量；线：位次 CTR（%，口径同 CTR 卡）"
          isEmpty={rankRows.length === 0}
          height={320}
          note={
            <div style={{ fontSize: 11.5, color: 'var(--c-text-weak)' }}>
              位次按分发的最小展示位次归类。R5 告警会引用该曲线：低位次 CTR 与首位接近即说明不是位次问题。
            </div>
          }
        >
          <RankCtrChart rows={rankRows} />
        </ChartCard>

        <ChartCard
          title="各分吧搜索结果 CTR 对比"
          subtitle="用于区分「内容本身吸引力不足」与「该吧流量结构问题」"
          isEmpty={ctrChartData.length === 0}
          height={320}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={ctrChartData}
              layout="vertical"
              margin={{ top: 8, right: 64, left: 4, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: '#8a9099' }} unit="%" />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#646a73' }} width={84} />
              <Tooltip
                cursor={{ fill: '#f5f7fa' }}
                content={renderTooltip(({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const d = payload[0].payload as unknown as { name: string; ctrText: string };
                  return (
                    <div className="chart-tooltip">
                      <div className="t-title">{d.name}</div>
                      <div className="t-row">
                        <span>搜索结果 CTR</span>
                        <b>{d.ctrText}</b>
                      </div>
                    </div>
                  );
                })}
              />
              <Bar
                dataKey="ctrNum"
                name="CTR"
                radius={[0, 4, 4, 0]}
                onClick={(d: unknown) => {
                  const row = d as { barId?: string };
                  if (row?.barId) onSelectBar(row.barId);
                }}
              >
                {ctrChartData.map((d) => (
                  <Cell
                    key={d.barId}
                    fill={d.barId === activeBarId ? COLORS.primary : '#93aaf0'}
                    cursor="pointer"
                  />
                ))}
                <LabelList
                  dataKey="ctrText"
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
          title="调起贴吧失败原因分布"
          subtitle="点击后未成功拉起贴吧的原因，指向落地页、App 安装与网络链路"
          isEmpty={jumpFailRows.length === 0}
          height="auto"
          emptyText="当前筛选下没有调起失败记录"
        >
          <DistList rows={jumpFailRows} color={COLORS.danger} />
        </ChartCard>

        <ChartCard
          title="各贴吧分发明细（点击行下钻）"
          subtitle="按所选统计区间计算；按曝光量降序"
          isEmpty={sortedRows.length === 0}
          height="auto"
        >
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>贴吧</th>
                  <th>分发内容</th>
                  <th>曝光量</th>
                  <th>点击次数</th>
                  <th>CTR</th>
                  <th>调起成功率</th>
                  <th style={{ width: 90 }}>曝光占比</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => {
                  const ctrLow = r.agg.ctr !== null && r.agg.ctr < THRESHOLDS.ctrMin;
                  const jumpLow = r.agg.jumpRate !== null && r.agg.jumpRate < THRESHOLDS.jumpRateMin;
                  return (
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
                      <td className="num">{fmtInt(r.agg.distributedContents)}</td>
                      <td className="num">{fmtInt(r.agg.impressions)}</td>
                      <td className="num">{fmtInt(r.agg.clicks)}</td>
                      <td className="num">
                        <span style={{ color: ctrLow ? COLORS.danger : undefined, fontWeight: ctrLow ? 700 : 400 }}>
                          {fmtPct(r.agg.ctr)}
                        </span>
                      </td>
                      <td className="num">
                        <span style={{ color: jumpLow ? COLORS.danger : undefined, fontWeight: jumpLow ? 700 : 400 }}>
                          {fmtPct(r.agg.jumpRate)}
                        </span>
                        <div style={{ color: 'var(--c-text-weak)', fontSize: 11 }}>
                          失败 {fmtInt(r.agg.jumpFailed)} 次
                        </div>
                      </td>
                      <td>
                        <RatioBar value={r.agg.impressions / maxImpressions} color={COLORS.primary} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ChartCard>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-head">
          <div>
            <h3 className="card-title">
              <MousePointerSquareDashed size={14} /> 分发口径说明
            </h3>
          </div>
        </div>
        <div className="card-body">
          <div style={{ fontSize: 12.5, color: 'var(--c-text-sub)', lineHeight: 1.9 }}>
            <div>
              · <b>CTR</b> = 点击事件数 / 搜索结果页曝光量，分子分母与本页所有位次、对比图同源，可直接横向比对。
            </div>
            <div>
              · <b>调起贴吧成功率</b> = 成功调起次数 / 调起次数；分母为 0 时展示 <b>—</b>，不按 0 处理。
            </div>
            <div>
              · <b>曝光</b>按曝光日归属并按「内容 × 分发 × 日 × 位次」聚合计数；<b>点击、调起</b>逐条记录并归因到内容生成日，
              以保证链路各步口径一致。
            </div>
            <div>
              · 当前筛选下共分发 <b>{fmtInt(agg.distributedContents)}</b> 条内容、获得{' '}
              <b>{fmtInt(agg.impressions)}</b> 次曝光、<b>{fmtInt(agg.clicks)}</b> 次点击。
            </div>
          </div>
          <div className="context-row" style={{ marginTop: 10 }}>
            <span>
              <MousePointerClick size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              CTR 阈值 {fmtPct(THRESHOLDS.ctrMin, 0)} · 调起率阈值 {fmtPct(THRESHOLDS.jumpRateMin, 0)}
            </span>
            <span>
              <PhoneCall size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              越限即在「异常监控」以 R5 规则告警
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
