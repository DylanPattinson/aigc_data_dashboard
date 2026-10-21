import { useMemo } from 'react';
import { AlertTriangle, Layers, ShieldCheck, Sparkles } from 'lucide-react';
import type { Anomaly } from '../lib/anomalies';
import type { Agg, ContentTypeRow, DistRow, ReviewState } from '../lib/metrics';
import { COLORS, REVIEW_STAGES, STAGE_COLORS, STAGE_LABELS, THRESHOLDS } from '../lib/config';
import { fmtInt, fmtPct, fmtSec } from '../lib/format';
import { fullTs } from '../lib/time';
import type { Bar, Content, ReviewStage } from '../types';
import { Badge, RatioBar } from './ui';

export interface BarDrawerProps {
  bar: Bar;
  agg: Agg;
  /** 该吧图文帖 / 视频帖的拆分 */
  typeRows: ContentTypeRow[];
  /** 搜索结果页位次 CTR 衰减 */
  rankRows: Array<{ rank: number; impressions: number; clicks: number; ctr: number | null }>;
  jumpFailRows: DistRow[];
  /** 命中筛选条件的内容样例（用于展示三层审核的逐条状态） */
  samples: Content[];
  reviewOf: (contentId: string) => ReviewState;
  queryNameOf: (queryId: string) => string;
  anomalies: Anomaly[];
  onOpenAnomaly: (a: Anomaly) => void;
}

function StageCell({ state, stage }: { state: ReviewState; stage: ReviewStage }) {
  const rec = state.byStage[stage];
  if (!rec) {
    return <span style={{ color: 'var(--c-text-weak)' }}>未进入</span>;
  }
  const map = {
    pass: { text: '通过', color: COLORS.success },
    reject: { text: '拒绝', color: COLORS.danger },
    pending: { text: '待审', color: COLORS.gray },
  } as const;
  const m = map[rec.status];
  return (
    <span style={{ color: m.color, fontWeight: 600 }} title={rec.rejectReason ?? undefined}>
      {m.text}
      {rec.rejectReason ? `（${rec.rejectReason}）` : ''}
    </span>
  );
}

export default function BarDrawer({
  bar,
  agg,
  typeRows,
  rankRows,
  jumpFailRows,
  samples,
  reviewOf,
  queryNameOf,
  anomalies,
  onOpenAnomaly,
}: BarDrawerProps) {
  const tierTone = bar.tier === 'S' ? 'danger' : bar.tier === 'A' ? 'warn' : 'primary';

  const topRank = rankRows[0];
  const rankSpan = useMemo(() => {
    const valid = rankRows.filter((r) => r.ctr !== null);
    if (valid.length < 2) return null;
    const first = valid[0];
    const last = valid[valid.length - 1];
    if (first.ctr === null || last.ctr === null) return null;
    return { first, last, ratio: last.ctr / first.ctr };
  }, [rankRows]);

  const cards = [
    {
      icon: <Sparkles size={13} />,
      title: '供给与生成',
      items: [
        `产出内容 ${fmtInt(agg.contentTotal)} 条，覆盖 ${agg.coveredQueries} 个 Query`,
        `生成成功率 ${fmtPct(agg.successRate)}（成功 ${fmtInt(agg.tasksSuccess)} / 失败 ${fmtInt(agg.tasksFailed)} 次）`,
        `平均生成时长 ${fmtSec(agg.avgDurationMs)}，P95 ${fmtSec(agg.p95DurationMs)}`,
      ],
    },
    {
      icon: <ShieldCheck size={13} />,
      title: '质量控制',
      items: [
        `三层全通过 ${fmtInt(agg.allPassedContents)} / 已进入机审 ${fmtInt(agg.reviewedContents)} 条（${fmtPct(agg.passRate)}）`,
        ...REVIEW_STAGES.map(
          (s) =>
            `${STAGE_LABELS[s]}：通过 ${fmtInt(agg.stages[s].pass)} / 拒绝 ${fmtInt(agg.stages[s].reject)} / 待审 ${fmtInt(agg.stages[s].pending)} 条`,
        ),
      ],
    },
    {
      icon: <Layers size={13} />,
      title: '分发与增长',
      items: [
        `分发到手百 ${fmtInt(agg.distributedContents)} 条，曝光 ${fmtInt(agg.impressions)} 次`,
        `搜索结果 CTR ${fmtPct(agg.ctr)}（点击 ${fmtInt(agg.clicks)} 次）`,
        `调起贴吧成功率 ${fmtPct(agg.jumpRate)}（成功 ${fmtInt(agg.jumpSuccess)} / 调起 ${fmtInt(agg.jumps)} 次）`,
      ],
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card">
        <div className="card-body">
          <div className="facts">
            <span className="k">一级分类</span>
            <span className="v">{bar.category}</span>
            <span className="k">贴吧分级</span>
            <span className="v">
              <Badge tone={tierTone}>{bar.tier} 级</Badge>
            </span>
            <span className="k">接入 AIGC 生产</span>
            <span className="v">{bar.openedAt}</span>
            <span className="k">搜索用户规模</span>
            <span className="v">
              {fmtInt(agg.searchUsers)} 人（{fmtInt(agg.queryEvents)} 人次）
            </span>
            <span className="k">分发位次</span>
            <span className="v">
              {topRank ? `首位 CTR ${fmtPct(topRank.ctr)}` : '暂无曝光'}
              {rankSpan ? ` · 末位/首位 = ${(rankSpan.ratio * 100).toFixed(0)}%` : ''}
            </span>
          </div>
        </div>
      </div>

      <div className="grid-2">
        {cards.map((c) => (
          <div className="card" key={c.title}>
            <div className="card-head">
              <div>
                <h3 className="card-title">
                  {c.icon} {c.title}
                </h3>
              </div>
            </div>
            <div className="card-body">
              <ul className="hypo-list" style={{ margin: 0, fontSize: 12.5 }}>
                {c.items.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">图文帖 vs 视频帖</h3>
            <p className="card-sub">视频帖生成耗时长，是该吧产能的主要约束</p>
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>内容类型</th>
                  <th>产出内容</th>
                  <th>三层通过率</th>
                  <th>分发到手百</th>
                  <th>平均生成时长</th>
                  <th>CTR</th>
                  <th style={{ width: 90 }}>供给占比</th>
                </tr>
              </thead>
              <tbody>
                {typeRows
                  .filter((r) => r.contentType !== 'ALL')
                  .map((r) => (
                    <tr key={r.contentType}>
                      <td style={{ fontWeight: 600 }}>{r.contentTypeName}</td>
                      <td className="num">{fmtInt(r.agg.contentTotal)}</td>
                      <td className="num">{fmtPct(r.agg.passRate)}</td>
                      <td className="num">{fmtInt(r.agg.distributedContents)}</td>
                      <td className="num">{fmtSec(r.agg.avgDurationMs)}</td>
                      <td className="num">{fmtPct(r.agg.ctr)}</td>
                      <td>
                        <RatioBar
                          value={r.agg.contentTotal / Math.max(1, agg.contentTotal)}
                          color={COLORS.primary}
                        />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">位次 CTR 衰减</h3>
            <p className="card-sub">
              末位 CTR 与首位接近时，说明不是位次问题，而是内容本身吸引力不足
            </p>
          </div>
        </div>
        <div className="card-body">
          {rankRows.length === 0 ? (
            <div className="empty" style={{ minHeight: 120 }}>
              该吧在当前筛选下没有搜索结果页曝光
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>展示位次</th>
                    <th>曝光量</th>
                    <th>点击次数</th>
                    <th>位次 CTR</th>
                    <th style={{ width: 150 }}>相对首位</th>
                  </tr>
                </thead>
                <tbody>
                  {rankRows.map((r) => (
                    <tr key={r.rank}>
                      <td style={{ fontWeight: 600 }}>第 {r.rank} 位</td>
                      <td className="num">{fmtInt(r.impressions)}</td>
                      <td className="num">{fmtInt(r.clicks)}</td>
                      <td
                        className="num"
                        style={{
                          color:
                            r.ctr !== null && r.ctr < THRESHOLDS.ctrMin ? COLORS.danger : undefined,
                        }}
                      >
                        {fmtPct(r.ctr)}
                      </td>
                      <td>
                        <RatioBar
                          value={topRank?.ctr ? (r.ctr ?? 0) / topRank.ctr : null}
                          color={COLORS.primary}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">调起贴吧失败原因</h3>
          </div>
        </div>
        <div className="card-body">
          {jumpFailRows.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--c-text-weak)' }}>当前筛选下没有调起失败记录。</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {jumpFailRows.map((r) => (
                <div
                  key={r.key}
                  style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 10, alignItems: 'center' }}
                >
                  <div>
                    <div style={{ fontSize: 12.5 }}>{r.label}</div>
                    <div className="ratio-bar" style={{ marginTop: 3 }}>
                      <span
                        style={{
                          width: `${Math.max(
                            2,
                            (r.value / Math.max(1, ...jumpFailRows.map((x) => x.value))) * 100,
                          )}%`,
                          background: COLORS.danger,
                        }}
                      />
                    </div>
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
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">内容审核状态样例</h3>
            <p className="card-sub">
              直接取自原始内容与审核记录，三层结论由运行时按 contentId 归拢派生
            </p>
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          {samples.length === 0 ? (
            <div className="empty" style={{ minHeight: 120 }}>
              当前筛选下没有内容记录
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>内容 ID</th>
                    <th>生成时间</th>
                    <th>内容类型</th>
                    <th>Query</th>
                    {REVIEW_STAGES.map((s) => (
                      <th key={s}>
                        <span
                          className="legend-dot"
                          style={{ background: STAGE_COLORS[s], marginRight: 5, display: 'inline-block' }}
                        />
                        {STAGE_LABELS[s]}
                      </th>
                    ))}
                    <th>可分发</th>
                  </tr>
                </thead>
                <tbody>
                  {samples.map((c) => {
                    const st = reviewOf(c.contentId);
                    return (
                      <tr key={c.contentId}>
                        <td style={{ fontFamily: 'monospace', fontSize: 11.5 }}>{c.contentId}</td>
                        <td style={{ fontSize: 12 }}>{fullTs(c.ts)}</td>
                        <td style={{ fontSize: 12 }}>{c.contentType}</td>
                        <td style={{ fontSize: 12 }}>{queryNameOf(c.queryId)}</td>
                        {REVIEW_STAGES.map((s) => (
                          <td key={s} style={{ fontSize: 12 }}>
                            <StageCell state={st} stage={s} />
                          </td>
                        ))}
                        <td style={{ fontSize: 12 }}>
                          <span style={{ color: st.allPassed ? COLORS.success : 'var(--c-text-weak)' }}>
                            {st.allPassed ? '是' : '否'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">
              <AlertTriangle size={14} /> 该吧相关异常（{anomalies.length}）
            </h3>
          </div>
        </div>
        <div className="card-body">
          {anomalies.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--c-text-weak)' }}>
              当前筛选区间内，该吧没有触发任何异常规则。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {anomalies.map((a) => (
                <button
                  key={a.id}
                  className="btn"
                  style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                  onClick={() => onOpenAnomaly(a)}
                >
                  <Badge tone={a.severity === '严重' ? 'danger' : a.severity === '高' ? 'warn' : 'primary'}>
                    {a.severity}
                  </Badge>
                  <span style={{ fontSize: 12.5 }}>
                    {a.ruleId} {a.ruleName} · {a.periodLabel} · {a.actualText}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
