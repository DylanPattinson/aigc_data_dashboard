import { AlertTriangle, ArrowDownRight, ArrowUpRight, Info, Minus } from 'lucide-react';
import type { Agg, EvalAgg } from '../lib/metrics';
import { THRESHOLDS } from '../lib/config';
import { fmtInt, fmtPct, fmtScore, fmtSec } from '../lib/format';
import type { DateRange } from '../types';

type Tone = 'good' | 'warn' | 'bad' | 'primary';

interface DeltaInfo {
  text: string;
  direction: 'up' | 'down' | 'flat';
  good: boolean;
}

function rateDelta(
  cur: number | null,
  prev: number | null,
  better: 'higher' | 'lower',
): DeltaInfo | null {
  if (cur === null || prev === null) return null;
  const d = cur - prev;
  const direction = Math.abs(d) < 1e-9 ? 'flat' : d > 0 ? 'up' : 'down';
  return {
    text: `${d > 0 ? '+' : ''}${(d * 100).toFixed(1)}pp`,
    direction,
    good: direction === 'flat' ? true : better === 'higher' ? d > 0 : d < 0,
  };
}

function secDelta(cur: number | null, prev: number | null): DeltaInfo | null {
  if (cur === null || prev === null) return null;
  const d = (cur - prev) / 1000;
  const direction = Math.abs(d) < 0.005 ? 'flat' : d > 0 ? 'up' : 'down';
  return {
    text: `${d > 0 ? '+' : ''}${d.toFixed(2)}s`,
    direction,
    good: direction === 'flat' ? true : d < 0,
  };
}

function countDelta(cur: number, prev: number): DeltaInfo | null {
  if (prev === 0) return null;
  const d = (cur - prev) / prev;
  const direction = Math.abs(d) < 0.0005 ? 'flat' : d > 0 ? 'up' : 'down';
  return { text: `${d > 0 ? '+' : ''}${(d * 100).toFixed(1)}%`, direction, good: d >= 0 };
}

/** 0~100 分的环比：以「分」为单位而非 pp */
function scoreDelta(cur: number | null, prev: number | null): DeltaInfo | null {
  if (cur === null || prev === null) return null;
  const d = cur - prev;
  const direction = Math.abs(d) < 0.05 ? 'flat' : d > 0 ? 'up' : 'down';
  return {
    text: `${d > 0 ? '+' : ''}${d.toFixed(1)} 分`,
    direction,
    good: direction === 'flat' ? true : d > 0,
  };
}

function DeltaTag({ info }: { info: DeltaInfo | null }) {
  if (!info) return null;
  const Icon = info.direction === 'up' ? ArrowUpRight : info.direction === 'down' ? ArrowDownRight : Minus;
  return (
    <span className={`delta ${info.good ? 'good' : 'bad'}`}>
      <Icon size={12} />
      {info.text}
    </span>
  );
}

function KpiCard({
  label,
  value,
  unit,
  detail,
  delta,
  deltaNote,
  tone,
  foot,
}: {
  label: string;
  value: string;
  unit?: string;
  detail: string;
  delta?: DeltaInfo | null;
  deltaNote?: string;
  tone: Tone;
  foot?: React.ReactNode;
}) {
  return (
    <div className={`kpi-card tone-${tone}`}>
      <div className="kpi-head">
        {label}
        {tone === 'bad' ? <AlertTriangle size={13} color="var(--c-danger)" /> : null}
      </div>
      <div className="kpi-value">
        {value}
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      <div className="kpi-detail">{detail}</div>
      <div className="kpi-foot">
        {delta !== undefined ? (
          delta ? (
            <>
              <DeltaTag info={delta} />
              <span className="kpi-note">{deltaNote ?? '较上一可比周期'}</span>
            </>
          ) : (
            <span className="kpi-note">{deltaNote ?? '上一可比周期无可比数据'}</span>
          )
        ) : (
          <span className="kpi-note">{deltaNote}</span>
        )}
        {foot}
      </div>
    </div>
  );
}

export interface KpiCardsProps {
  agg: Agg;
  /** AIGC 内容评测聚合（综合质量分与达标率） */
  evalAgg: EvalAgg | null;
  prevEvalAgg: EvalAgg | null;
  prev: Agg | null;
  prevRange: DateRange;
  /** 各贴吧独立去重后的合计 vs 全局去重，用于说明搜索人群的重复口径 */
  dedupeNote: { sumByBar: number; globalUnique: number; overlap: number } | null;
  hasPrevData: boolean;
}

export default function KpiCards({
  agg,
  evalAgg,
  prevEvalAgg,
  prev,
  prevRange,
  dedupeNote,
  hasPrevData,
}: KpiCardsProps) {
  const prevOrNull = hasPrevData ? prev : null;
  const cmpNote = `较 ${prevRange.startDate} ~ ${prevRange.endDate}`;

  const successTone: Tone =
    agg.successRate === null
      ? 'primary'
      : agg.successRate >= 0.95
        ? 'good'
        : agg.successRate >= THRESHOLDS.genSuccessRateMin
          ? 'warn'
          : 'bad';

  const durTone: Tone =
    agg.avgDurationMs === null
      ? 'primary'
      : agg.avgDurationMs <= 8000
        ? 'good'
        : agg.avgDurationMs <= THRESHOLDS.avgDurationMaxMs
          ? 'warn'
          : 'bad';

  const passTone: Tone =
    agg.passRate === null
      ? 'primary'
      : agg.passRate >= 0.85
        ? 'good'
        : agg.passRate >= 0.75
          ? 'warn'
          : 'bad';

  const ctrTone: Tone =
    agg.ctr === null
      ? 'primary'
      : agg.ctr >= THRESHOLDS.ctrMin * 1.5
        ? 'good'
        : agg.ctr >= THRESHOLDS.ctrMin
          ? 'warn'
          : 'bad';

  const jumpTone: Tone =
    agg.jumpRate === null
      ? 'primary'
      : agg.jumpRate >= 0.85
        ? 'good'
        : agg.jumpRate >= THRESHOLDS.jumpRateMin
          ? 'warn'
          : 'bad';

  const pendingTotal = agg.stages.auto.pending + agg.stages.manual.pending + agg.stages.quality.pending;
  const worstRejectRate = Math.max(
    0,
    ...Object.values(agg.stages).map((s) => s.rejectRate ?? 0),
  );

  /** 评测相关派生量：无评测数据时全部降级为 — */
  const score = evalAgg?.overallScore ?? null;
  const scoreTone: Tone =
    score === null
      ? 'primary'
      : score >= 80
        ? 'good'
        : score >= THRESHOLDS.evalScoreMin
          ? 'warn'
          : 'bad';
  const evalRate = evalAgg?.passRate ?? null;
  const agreeRate = evalAgg?.humanAgreeRate ?? null;
  const agreeTone: Tone =
    agreeRate === null ? 'primary' : agreeRate >= 0.85 ? 'good' : agreeRate >= THRESHOLDS.evalAgreeRateMin ? 'warn' : 'bad';
  const worstDim = evalAgg
    ? evalAgg.dimAgg
        .filter((d) => d.scored > 0)
        .reduce<(typeof evalAgg.dimAgg)[number] | null>(
          (acc, d) => (acc === null || (d.mean ?? 100) < (acc.mean ?? 100) ? d : acc),
          null,
        )
    : null;

  return (
    <div className="kpi-grid">
      <KpiCard
        label="搜索用户规模"
        value={fmtInt(agg.searchUsers)}
        unit="人"
        detail={`搜索事件 ${fmtInt(agg.queryEvents)} 人次 · 覆盖 ${agg.coveredBars} 个贴吧 / ${agg.coveredQueries} 个 Query`}
        delta={prevOrNull ? countDelta(agg.searchUsers, prevOrNull.searchUsers) : null}
        deltaNote={hasPrevData ? cmpNote : '上一可比周期无数据'}
        tone="primary"
        foot={
          dedupeNote && dedupeNote.overlap > 0 ? (
            <span
              className="kpi-note"
              title={`各贴吧独立去重合计 ${dedupeNote.sumByBar} 人，全局去重 ${dedupeNote.globalUnique} 人`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <Info size={12} />跨贴吧重复 {dedupeNote.overlap} 人已去重
            </span>
          ) : null
        }
      />

      <KpiCard
        label="AIGC 生成成功率"
        value={fmtPct(agg.successRate)}
        detail={`成功 ${fmtInt(agg.tasksSuccess)} / 已完成 ${fmtInt(agg.completedTasks)} 次（生成中 ${fmtInt(agg.tasksPending)} 次不计入分母）`}
        delta={prevOrNull ? rateDelta(agg.successRate, prevOrNull.successRate, 'higher') : null}
        deltaNote={hasPrevData ? cmpNote : '上一可比周期无数据'}
        tone={successTone}
      />

      <KpiCard
        label="平均生成时长"
        value={fmtSec(agg.avgDurationMs)}
        detail={`成功任务 ${fmtInt(agg.tasksSuccess)} 次 · P95 ${fmtSec(agg.p95DurationMs)} · 超阈值 ${fmtInt(agg.slowTaskCount)} 次`}
        delta={prevOrNull ? secDelta(agg.avgDurationMs, prevOrNull.avgDurationMs) : null}
        deltaNote={hasPrevData ? cmpNote : '上一可比周期无数据'}
        tone={durTone}
      />

      <KpiCard
        label="三层审核通过率"
        value={fmtPct(agg.passRate)}
        detail={`三层全通过 ${fmtInt(agg.allPassedContents)} / 已进入机审 ${fmtInt(agg.reviewedContents)} 条`}
        delta={prevOrNull ? rateDelta(agg.passRate, prevOrNull.passRate, 'higher') : null}
        deltaNote={hasPrevData ? cmpNote : '上一可比周期无数据'}
        tone={passTone}
        foot={
          pendingTotal > 0 ? (
            <span
              className="kpi-note"
              title={`机审 ${agg.stages.auto.pending} / 人审 ${agg.stages.manual.pending} / 质量审核 ${agg.stages.quality.pending}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <Info size={12} />待审积压 {fmtInt(pendingTotal)} 条
            </span>
          ) : null
        }
      />

      <KpiCard
        label="AIGC 综合质量分"
        value={fmtScore(score)}
        detail={`评测 ${fmtInt(evalAgg?.evaluated ?? 0)} 条内容 · 质量达标率 ${fmtPct(evalRate)}（优+良）`}
        delta={prevEvalAgg ? scoreDelta(score, prevEvalAgg.overallScore) : null}
        deltaNote={hasPrevData ? cmpNote : '上一可比周期无数据'}
        tone={scoreTone}
        foot={
          <span
            className="kpi-note"
            style={{ color: agreeTone === 'bad' ? 'var(--c-danger)' : undefined }}
            title="人审按比例抽样复核，与评测模型的分档一致率"
          >
            人机一致 {fmtPct(agreeRate)}
            {worstDim ? ` · 最薄弱 ${worstDim.label}` : ''}
          </span>
        }
      />

      <KpiCard
        label="分发到手百"
        value={fmtInt(agg.distributedContents)}
        unit="条"
        detail={`过审并分发 ${fmtInt(agg.distributedContents)} 条 · 曝光 ${fmtInt(agg.impressions).replace(/,/g, '')} 次`}
        delta={prevOrNull ? countDelta(agg.distributedContents, prevOrNull.distributedContents) : null}
        deltaNote={hasPrevData ? cmpNote : '上一可比周期无数据'}
        tone="primary"
        foot={
          worstRejectRate > THRESHOLDS.reviewRejectRateMax ? (
            <span className="kpi-note" style={{ color: 'var(--c-warn)' }}>
              最高环节拒绝率 {fmtPct(worstRejectRate)}
            </span>
          ) : null
        }
      />

      <KpiCard
        label="搜索结果 CTR"
        value={fmtPct(agg.ctr)}
        detail={`点击 ${fmtInt(agg.clicks)} 次 / 曝光 ${fmtInt(agg.impressions)} 次（同一内容多次点击逐条计数）`}
        delta={prevOrNull ? rateDelta(agg.ctr, prevOrNull.ctr, 'higher') : null}
        deltaNote={hasPrevData ? cmpNote : '上一可比周期无数据'}
        tone={ctrTone}
      />

      <KpiCard
        label="调起贴吧成功率"
        value={fmtPct(agg.jumpRate)}
        detail={`成功调起 ${fmtInt(agg.jumpSuccess)} / 调起 ${fmtInt(agg.jumps)} 次 · 覆盖 ${fmtInt(agg.jumpedContents)} 条内容`}
        delta={prevOrNull ? rateDelta(agg.jumpRate, prevOrNull.jumpRate, 'higher') : null}
        deltaNote={hasPrevData ? cmpNote : '上一可比周期无数据'}
        tone={jumpTone}
      />
    </div>
  );
}
