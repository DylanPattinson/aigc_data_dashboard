import { ClipboardCheck, Gauge, Sparkles } from 'lucide-react';
import type { ContentIndex } from '../lib/metrics';
import { evalContentDetail } from '../lib/metrics';
import type { EvalDimension } from '../types';
import {
  COLORS,
  DIMENSION_COLORS,
  DIMENSION_LABELS,
  DIMENSION_WEIGHTS,
  EVAL_DIMENSIONS,
  GRADE_LABELS,
  SCORE_GRADES,
} from '../lib/config';
import { fmtPct, fmtScore } from '../lib/format';
import { fullTs } from '../lib/time';
import { Badge, RatioBar } from './ui';

const GRADE_COLORS = ['#17A673', '#5B9BF5', '#E08A1E', '#E0483C'];

/** 与 metrics.gradeOf 同一套阈值，抽屉内只在本地判色，不参与指标口径 */
function gradeOf(score: number): 0 | 1 | 2 | 3 {
  if (score >= SCORE_GRADES.excellent) return 0;
  if (score >= SCORE_GRADES.good) return 1;
  if (score >= SCORE_GRADES.fair) return 2;
  return 3;
}

export interface EvalDetailPanelProps {
  index: ContentIndex;
  contentId: string;
  barName: string;
  queryName: string;
  contentTypeName: string;
  contentTs: string;
  issueDict: Record<EvalDimension, Map<string, string>>;
}

function ScoreBar({ score, color }: { score: number | undefined; color: string }) {
  return (
    <div className="ratio-bar" style={{ marginTop: 3 }}>
      <span style={{ width: `${Math.max(2, score ?? 0)}%`, background: color }} />
    </div>
  );
}

export default function EvalDetailPanel({
  index,
  contentId,
  barName,
  queryName,
  contentTypeName,
  contentTs,
  issueDict,
}: EvalDetailPanelProps) {
  const { auto, human, autoScore, humanScore } = evalContentDetail(index, contentId);

  if (!auto) {
    return <div className="empty" style={{ minHeight: 160 }}>该内容没有评测记录</div>;
  }

  const autoGrade = autoScore === null ? null : gradeOf(autoScore);
  const humanGrade = humanScore === null ? null : gradeOf(humanScore);
  const agree = autoGrade !== null && humanGrade !== null ? autoGrade === humanGrade : null;

  const compare = EVAL_DIMENSIONS.filter((d) => d in auto.scores);

  const metaRows: Array<[string, string]> = [
    ['评测 ID', auto.evalId],
    ['评测时间', fullTs(auto.ts)],
    ['评测来源', '评测模型（全量）'],
    ['评测模型版本', auto.modelVersion],
  ];
  if (human) {
    metaRows.push(['复核 ID', human.evalId], ['复核时间', fullTs(human.ts)]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 基本信息 */}
      <div className="card">
        <div className="card-body">
          <div className="facts">
            <span className="k">内容 ID</span>
            <span className="v" style={{ fontFamily: 'monospace', fontSize: 12 }}>
              {contentId}
            </span>
            <span className="k">所属贴吧</span>
            <span className="v">{barName}</span>
            <span className="k">目标 Query</span>
            <span className="v">{queryName}</span>
            <span className="k">内容类型</span>
            <span className="v">{contentTypeName}</span>
            <span className="k">生成时间</span>
            <span className="v">{fullTs(contentTs)}</span>
            {metaRows.map(([k, v]) => (
              <span key={k} style={{ display: 'contents' }}>
                <span className="k">{k}</span>
                <span className="v">{v}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* 自动评测 vs 人工复核 */}
      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">
              <Gauge size={14} /> 自动评测与人工复核对照
            </h3>
            <p className="card-sub">
              评测模型对全量内容打分，人审按比例抽样复核同一内容；分档一致即视为人工认可
            </p>
          </div>
          {agree !== null ? (
            <Badge tone={agree ? 'success' : 'warn'}>{agree ? '分档一致' : '分档不一致'}</Badge>
          ) : null}
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>来源</th>
                  <th>综合质量分</th>
                  <th>档位</th>
                  <th style={{ width: 150 }}>分档位置</th>
                  <th>与自动分差</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ fontWeight: 600 }}>
                    <Sparkles size={12} style={{ verticalAlign: -1, marginRight: 4 }} />
                    自动评测
                  </td>
                  <td className="num" style={{ fontWeight: 700 }}>
                    {fmtScore(autoScore)}
                  </td>
                  <td>
                    {autoGrade !== null ? (
                      <span style={{ color: GRADE_COLORS[autoGrade], fontWeight: 600 }}>
                        {GRADE_LABELS[autoGrade]}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <RatioBar value={autoScore === null ? null : autoScore / 100} color={DIMENSION_COLORS.visual} />
                  </td>
                  <td className="num" style={{ color: 'var(--c-text-weak)' }}>
                    基准
                  </td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>
                    <ClipboardCheck size={12} style={{ verticalAlign: -1, marginRight: 4 }} />
                    人工复核
                  </td>
                  <td className="num" style={{ fontWeight: 700 }}>
                    {fmtScore(humanScore)}
                  </td>
                  <td>
                    {humanGrade !== null ? (
                      <span style={{ color: GRADE_COLORS[humanGrade], fontWeight: 600 }}>
                        {GRADE_LABELS[humanGrade]}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--c-text-weak)' }}>未抽中</span>
                    )}
                  </td>
                  <td>
                    <RatioBar
                      value={humanScore === null ? null : humanScore / 100}
                      color={DIMENSION_COLORS.relevance}
                    />
                  </td>
                  <td className="num">
                    {autoScore !== null && humanScore !== null
                      ? `${humanScore - autoScore > 0 ? '+' : ''}${(humanScore - autoScore).toFixed(1)} 分`
                      : '—'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 维度明细 */}
      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">维度打分明细</h3>
            <p className="card-sub">
              不适用的维度不参与打分与加权（图文帖无「声画一致性」），综合分按适用维度权重归一后计算
            </p>
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>维度</th>
                  <th>权重</th>
                  <th className="num">自动分</th>
                  <th className="num">人工分</th>
                  <th className="num">分差</th>
                  <th>档位</th>
                  <th style={{ width: 130 }}>相对满分</th>
                </tr>
              </thead>
              <tbody>
                {compare.map((dim) => {
                  const a = auto.scores[dim];
                  const h = human?.scores[dim];
                  const color = DIMENSION_COLORS[dim];
                  const g = a === undefined ? null : gradeOf(a);
                  const low = a !== undefined && a < SCORE_GRADES.good;
                  return (
                    <tr key={dim}>
                      <td>
                        <span className="legend-dot" style={{ background: color, marginRight: 6 }} />
                        <span style={{ fontWeight: 600 }}>{DIMENSION_LABELS[dim]}</span>
                      </td>
                      <td className="num">{fmtPct(DIMENSION_WEIGHTS[dim], 0)}</td>
                      <td className="num" style={{ fontWeight: 700, color: low ? color : undefined }}>
                        {a === undefined ? '—' : fmtScore(a)}
                      </td>
                      <td className="num">{h === undefined ? '—' : fmtScore(h)}</td>
                      <td className="num">
                        {a !== undefined && h !== undefined
                          ? `${h - a > 0 ? '+' : ''}${(h - a).toFixed(1)}`
                          : '—'}
                      </td>
                      <td>
                        {g !== null ? (
                          <span
                            style={{
                              color: g >= 2 ? COLORS.danger : GRADE_COLORS[g],
                              fontWeight: 600,
                            }}
                          >
                            {GRADE_LABELS[g]}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <ScoreBar score={a} color={color} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 扣分原因 */}
      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">扣分原因</h3>
            <p className="card-sub">仅记录低于 70 分的维度；无扣分记录说明该内容各维度均达到「良」以上</p>
          </div>
        </div>
        <div className="card-body">
          {auto.issues.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--c-text-weak)' }}>
              无扣分记录，各维度均不低于 70 分。
            </div>
          ) : (
            <ul className="hypo-list" style={{ margin: 0, fontSize: 12.5 }}>
              {auto.issues.map((it, i) => (
                <li key={`${it.dim}-${i}`}>
                  <span
                    className="legend-dot"
                    style={{ background: DIMENSION_COLORS[it.dim], marginRight: 6 }}
                  />
                  <span style={{ fontWeight: 600 }}>{DIMENSION_LABELS[it.dim]}</span>
                  ：{issueDict[it.dim]?.get(it.reason) ?? it.reason}
                  <span style={{ color: 'var(--c-text-weak)' }}>
                    （{fmtScore(auto.scores[it.dim] ?? null)} 分）
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* 下游转化 */}
      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">评测结论与下游的关系</h3>
          </div>
        </div>
        <div className="card-body">
          <div style={{ fontSize: 12.5, color: 'var(--c-text-sub)', lineHeight: 1.7 }}>
            该内容综合 <b>{fmtScore(autoScore)}</b> 分、档位「
            {autoGrade !== null ? GRADE_LABELS[autoGrade] : '—'}
            」。板块内「质量分 × 下游转化关联分析」按档位汇总了全部内容的曝光、点击与调起成功率，
            可据此判断该档位内容在搜索结果页的实际表现。
          </div>
        </div>
      </div>
    </div>
  );
}