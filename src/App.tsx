import { useCallback, useEffect, useMemo, useState } from 'react';
import { Database, MessageSquareText, RefreshCw, ShieldAlert } from 'lucide-react';
import type { Dataset, DateRange, Filters } from './types';
import type { Anomaly } from './lib/anomalies';
import { buildAnomalyDetail, detectAnomalies } from './lib/anomalies';
import { buildDicts, loadDataset } from './lib/data';
import type { RangePresetKey } from './lib/config';
import {
  aggFromSelection,
  barBreakdown,
  buildContentIndex,
  buildFunnel,
  contentTypeBreakdown,
  crossBarDedupeNote,
  ctrByRank,
  dailySeries,
  evalAggregate,
  evalBarRows,
  evalCategoryHeatmap,
  evalDailySeries,
  evalDimensionBreakdown,
  evalGradeConversion,
  evalIssueDist,
  evalLowScoreContents,
  jumpFailReasonDist,
  queryCategoryRejectDist,
  rejectReasonDist,
  reviewPipeline,
  reviewStateOf,
  selectData,
} from './lib/metrics';
import { addDays, previousRange } from './lib/time';
import { fmtInt, fmtPct } from './lib/format';
import FilterBar from './components/FilterBar';
import KpiCards from './components/KpiCards';
import SupplySection from './components/SupplySection';
import EvalSection from './components/EvalSection';
import ReviewSection from './components/ReviewSection';
import DistributionSection from './components/DistributionSection';
import AnomalySection from './components/AnomalySection';
import CaseSection from './components/CaseSection';
import MetricsNoteSection from './components/MetricsNoteSection';
import Drawer from './components/Drawer';
import AnomalyDetailPanel from './components/AnomalyDetailPanel';
import EvalDetailPanel from './components/EvalDetailPanel';
import BarDrawer from './components/BarDrawer';
import { Badge, LoadingBlock } from './components/ui';

const NAV = [
  { href: '#sec-supply', label: '内容供给' },
  { href: '#sec-eval', label: 'AIGC内容评测' },
  { href: '#sec-review', label: '三层审核' },
  { href: '#sec-distribution', label: '分发与增长' },
  { href: '#sec-anomaly', label: '异常监控' },
  { href: '#sec-cases', label: '演示案例' },
  { href: '#sec-metrics', label: '指标口径' },
];

export default function App() {
  const [ds, setDs] = useState<Dataset | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [preset, setPreset] = useState<RangePresetKey | 'custom'>('30d');
  const [range, setRange] = useState<DateRange>({ startDate: '2026-10-01', endDate: '2026-10-30' });
  const [barId, setBarId] = useState('ALL');
  const [contentType, setContentType] = useState('ALL');
  const [openAnomaly, setOpenAnomaly] = useState<Anomaly | null>(null);
  const [openBarId, setOpenBarId] = useState<string | null>(null);
  const [openEvalContentId, setOpenEvalContentId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadDataset()
      .then((data) => {
        if (cancelled) return;
        setDs(data);
        const end = data.meta.endDate;
        setRange({ startDate: addDays(end, -29), endDate: end });
        setLoadState('ready');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePreset = useCallback(
    (p: RangePresetKey | 'custom') => {
      setPreset(p);
      if (p === 'custom' || !ds) return;
      const end = ds.meta.endDate;
      const days = p === 'today' ? 1 : p === '7d' ? 7 : 30;
      setRange({ startDate: addDays(end, -(days - 1)), endDate: end });
    },
    [ds],
  );

  const handleRangeChange = useCallback((r: DateRange) => {
    setRange(r);
    setPreset('custom');
  }, []);

  const handleReset = useCallback(() => {
    if (!ds) return;
    setBarId('ALL');
    setContentType('ALL');
    setPreset('30d');
    setRange({ startDate: addDays(ds.meta.endDate, -29), endDate: ds.meta.endDate });
  }, [ds]);

  const filters: Filters = useMemo(() => ({ range, barId, contentType }), [range, barId, contentType]);

  const computed = useMemo(() => {
    if (!ds) return null;
    const index = buildContentIndex(ds.events, ds.queries);
    const sel = selectData(ds, filters);
    const agg = aggFromSelection(sel, index);

    const prev = previousRange(range);
    const prevSel = selectData(ds, { ...filters, range: prev });
    const prevAgg = aggFromSelection(prevSel, index);
    const hasPrevData =
      prevSel.queryEvents.length + prevSel.tasks.length + prevSel.contents.length > 0;

    const daily = dailySeries(sel, index);
    const barRows = barBreakdown(ds, sel, index);
    const typeRows = contentTypeBreakdown(ds, sel, index);
    const dicts = buildDicts(ds.meta);
    const funnel = buildFunnel(agg);
    const pipeline = reviewPipeline(agg);
    const rankRows = ctrByRank(sel);
    const dedupeNote = crossBarDedupeNote(sel);

    // AIGC 内容评测：与业务指标同源（同一批内容 / 同一份筛选结果），保证跨区块数值可对照
    const evalAgg = evalAggregate(sel.evals, index);
    const prevEvalAgg = evalAggregate(prevSel.evals, index);
    const evalDaily = evalDailySeries(sel.evals);
    const evalDims = evalDimensionBreakdown(sel.evals);
    const evalHeat = evalCategoryHeatmap(sel.evals, index, dicts.queryCategories);
    const evalBars = evalBarRows(ds, sel, index);
    const evalConv = evalGradeConversion(sel);
    const evalIssues = evalIssueDist(sel.evals, dicts.evalIssueReasons);
    const evalLow = evalLowScoreContents(ds, sel, index, dicts.evalIssueReasons, 10);

    // 异常上下文固定基于「当前筛选」，避免下钻时 R1-R6 的对照基准随抽屉开关漂移
    const ctx = { ds, sel, index, filters, barRows, dicts };
    const anomalies = detectAnomalies(ctx);

    return {
      index,
      sel,
      agg,
      prevAgg,
      prevRange: prev,
      hasPrevData,
      daily,
      barRows,
      typeRows,
      dicts,
      funnel,
      pipeline,
      rankRows,
      dedupeNote,
      evalAgg,
      prevEvalAgg,
      evalDaily,
      evalDims,
      evalHeat,
      evalBars,
      evalConv,
      evalIssues,
      evalLow,
      ctx,
      anomalies,
      hitRecords:
        sel.queryEvents.length +
        sel.tasks.length +
        sel.contents.length +
        sel.evals.length +
        sel.distributes.length +
        sel.impressionStats.length +
        sel.clicks.length +
        sel.jumpBacks.length,
    };
  }, [ds, filters]);

  const anomalyDetail = useMemo(
    () => (computed && openAnomaly ? buildAnomalyDetail(openAnomaly, computed.ctx) : null),
    [computed, openAnomaly],
  );

  /** 评测详情抽屉：内容元信息与词典取自全局 index / meta，不受当前筛选影响 */
  const evalContent = useMemo(() => {
    if (!ds || !computed || !openEvalContentId) return null;
    const c = computed.index.byId.get(openEvalContentId);
    if (!c) return null;
    const typeName =
      ds.meta.dictionaries.contentTypes.find((t) => t.id === c.contentType)?.name ?? c.contentType;
    return {
      content: c,
      barName: ds.bars.find((b) => b.id === c.barId)?.name ?? c.barId,
      queryName: computed.index.queryById.get(c.queryId)?.name ?? c.queryId,
      typeName,
    };
  }, [ds, computed, openEvalContentId]);

  /** 贴吧抽屉内的指标不受「当前内容类型筛选」影响，按该吧单独重算一次 */
  const barDrawerData = useMemo(() => {
    if (!ds || !computed || !openBarId) return null;
    const bar = ds.bars.find((b) => b.id === openBarId);
    if (!bar) return null;

    const bSel = selectData(ds, { range, barId: openBarId, contentType: 'ALL' });
    const bAgg = aggFromSelection(bSel, computed.index);
    const bTypes = contentTypeBreakdown(ds, bSel, computed.index);
    const bRank = ctrByRank(bSel);
    const bJumpFail = jumpFailReasonDist(bSel, computed.dicts.jumpFailReasons);
    const bAnomalies = computed.anomalies.filter((a) => a.barId === openBarId);

    return {
      bar,
      agg: bAgg,
      typeRows: bTypes,
      rankRows: bRank,
      jumpFailRows: bJumpFail,
      samples: bSel.contents.slice(0, 12),
      reviewOf: (contentId: string) => reviewStateOf(computed.index, contentId),
      queryNameOf: (queryId: string) => computed.index.queryById.get(queryId)?.name ?? queryId,
      anomalies: bAnomalies,
    };
  }, [ds, computed, openBarId, range]);

  if (loadState === 'loading') {
    return <LoadingBlock text="正在加载模拟数据（事件级原始数据 + 曝光聚合记录，首次加载约 1-2 秒）…" />;
  }

  if (loadState === 'error' || !ds || !computed) {
    return (
      <div className="error-box">
        <h3 style={{ marginTop: 0 }}>数据加载失败</h3>
        <p style={{ color: 'var(--c-text-sub)', fontSize: 13 }}>{errorMsg}</p>
        <p style={{ fontSize: 13 }}>
          请先确认 <code>public/data/</code> 下存在
          <code>mock_bars.json / mock_queries.json / mock_events.json / mock_meta.json</code>；若缺失，在项目根目录执行：
        </p>
        <pre style={{ background: '#f5f6f8', padding: 10, borderRadius: 6, fontSize: 12 }}>
          python3 scripts/generate_mock_data.py
        </pre>
      </div>
    );
  }

  const barName = barId === 'ALL' ? '全部贴吧' : (ds.bars.find((b) => b.id === barId)?.name ?? barId);
  const eventTotal =
    (ds.meta.counts.queryEvents ?? 0) +
    (ds.meta.counts.generationTasks ?? 0) +
    (ds.meta.counts.contents ?? 0) +
    (ds.meta.counts.reviews ?? 0) +
    (ds.meta.counts.distributes ?? 0) +
    (ds.meta.counts.clicks ?? 0) +
    (ds.meta.counts.jumpBacks ?? 0);

  return (
    <div className="app">
      <header className="header">
        <div className="container">
          <div className="header-main">
            <div className="brand">
              <div className="brand-logo">
                <MessageSquareText size={19} />
              </div>
              <div>
                <div className="brand-title">AIGC生成数据看板</div>
                <div className="brand-sub">
                  贴吧 AIGC 内容生产 → 三层审核 → 手百搜索分发 → 用户增长 · {ds.bars.length} 个贴吧 ·{' '}
                  {ds.queries.length} 个搜索 Query · {ds.meta.businessDays} 天模拟数据
                </div>
              </div>
            </div>
            <div className="header-meta">
              <span className="meta-chip mock">
                <ShieldAlert size={13} /> 模拟数据 · 非真实业务数据
              </span>
              <span className="meta-chip">
                <Database size={13} /> 事件记录 {eventTotal.toLocaleString('zh-CN')} 条
              </span>
              <span className="meta-chip">数据更新时间 {ds.meta.dataUpdateTime.replace('T', ' ')}</span>
              <span className="meta-chip">随机种子 {ds.meta.seed}</span>
            </div>
          </div>
          <nav className="nav">
            {NAV.map((n) => (
              <a key={n.href} href={n.href}>
                {n.label}
              </a>
            ))}
            <a href="#top" onClick={handleReset} style={{ color: 'var(--c-primary)' }}>
              <RefreshCw size={12} style={{ verticalAlign: -1 }} /> 重置
            </a>
          </nav>
        </div>
      </header>

      <main className="container" id="top">
        <FilterBar
          meta={ds.meta}
          preset={preset}
          onPreset={handlePreset}
          range={range}
          onRangeChange={handleRangeChange}
          barId={barId}
          onBarChange={setBarId}
          bars={ds.bars}
          contentType={contentType}
          onContentTypeChange={setContentType}
          contentTypes={ds.meta.dictionaries.contentTypes}
          onReset={handleReset}
          hitRecords={computed.hitRecords}
        />

        <div className="section">
          <div className="section-head">
            <h2 className="section-title">核心指标概览</h2>
            <p className="section-desc">
              对比上一可比周期：{computed.prevRange.startDate} ~ {computed.prevRange.endDate}
              {computed.hasPrevData ? '' : '（无可比数据）'}
            </p>
          </div>
          <KpiCards
            agg={computed.agg}
            evalAgg={computed.evalAgg}
            prevEvalAgg={computed.hasPrevData ? computed.prevEvalAgg : null}
            prev={computed.prevAgg}
            prevRange={computed.prevRange}
            dedupeNote={computed.dedupeNote}
            hasPrevData={computed.hasPrevData}
          />
        </div>

        <SupplySection
          daily={computed.daily}
          funnel={computed.funnel}
          barRows={computed.barRows}
          typeRows={computed.typeRows}
          onSelectBar={setBarId}
          activeBarId={barId}
        />

        <EvalSection
          agg={computed.evalAgg}
          daily={computed.evalDaily}
          dims={computed.evalDims}
          heatmap={computed.evalHeat}
          barRows={computed.evalBars}
          conversion={computed.evalConv}
          issueRows={computed.evalIssues}
          lowRows={computed.evalLow}
          onSelectBar={setBarId}
          activeBarId={barId}
          onOpenContent={setOpenEvalContentId}
        />

        <ReviewSection
          daily={computed.daily}
          pipeline={computed.pipeline}
          stageRejectRows={{
            auto: rejectReasonDist(computed.sel, computed.index, 'auto', computed.dicts.reviewRejectReasons.auto),
            manual: rejectReasonDist(
              computed.sel,
              computed.index,
              'manual',
              computed.dicts.reviewRejectReasons.manual,
            ),
            quality: rejectReasonDist(
              computed.sel,
              computed.index,
              'quality',
              computed.dicts.reviewRejectReasons.quality,
            ),
          }}
          queryCategoryRows={queryCategoryRejectDist(
            computed.sel,
            computed.index,
            computed.dicts.queryCategories,
          )}
          pendingByStage={computed.pipeline.pendingByStage}
        />

        <DistributionSection
          daily={computed.daily}
          barRows={computed.barRows}
          agg={computed.agg}
          rankRows={computed.rankRows}
          jumpFailRows={jumpFailReasonDist(computed.sel, computed.dicts.jumpFailReasons)}
          onSelectBar={setBarId}
          activeBarId={barId}
        />

        <div className="card" style={{ marginTop: 12 }}>
          <div className="card-head">
            <div>
              <h3 className="card-title">各贴吧一览（点击「详情」打开下钻抽屉）</h3>
              <p className="card-sub">
                供给、三层审核、分发转化三段指标并列；详情抽屉内含位次 CTR、失败原因与审核状态原始样例
              </p>
            </div>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>贴吧</th>
                    <th>产出内容</th>
                    <th>三层通过率</th>
                    <th>分发到手百</th>
                    <th>曝光量</th>
                    <th>CTR</th>
                    <th>调起成功率</th>
                    <th style={{ width: 90 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {computed.barRows.map((r) => (
                    <tr key={r.barId}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.barName}</div>
                        <div style={{ color: 'var(--c-text-weak)', fontSize: 11.5 }}>
                          {r.category} · {r.tier} 级
                        </div>
                      </td>
                      <td className="num">{fmtInt(r.agg.contentTotal)}</td>
                      <td className="num">{fmtPct(r.agg.passRate)}</td>
                      <td className="num">{fmtInt(r.agg.distributedContents)}</td>
                      <td className="num">{fmtInt(r.agg.impressions)}</td>
                      <td className="num">{fmtPct(r.agg.ctr, 2)}</td>
                      <td className="num">{fmtPct(r.agg.jumpRate)}</td>
                      <td>
                        <button className="btn" onClick={() => setOpenBarId(r.barId)}>
                          详情
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <AnomalySection
          anomalies={computed.anomalies}
          onOpen={setOpenAnomaly}
          barName={barName}
          rangeLabel={`${range.startDate} ~ ${range.endDate}`}
        />

        <CaseSection
          onApply={(bid, r) => {
            setBarId(bid);
            setRange(r);
            setPreset('custom');
          }}
        />

        <MetricsNoteSection />
      </main>

      <Drawer
        open={evalContent !== null}
        title={evalContent ? 'AIGC 内容评测明细' : ''}
        subtitle={
          evalContent ? `${evalContent.barName} · ${evalContent.queryName} · ${evalContent.typeName}` : ''
        }
        onClose={() => setOpenEvalContentId(null)}
      >
        {evalContent && computed ? (
          <EvalDetailPanel
            index={computed.index}
            contentId={evalContent.content.contentId}
            barName={evalContent.barName}
            queryName={evalContent.queryName}
            contentTypeName={evalContent.typeName}
            contentTs={evalContent.content.ts}
            issueDict={computed.dicts.evalIssueReasons}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={openAnomaly !== null}
        title={openAnomaly ? `${openAnomaly.ruleId} ${openAnomaly.ruleName}` : ''}
        subtitle={openAnomaly ? `${openAnomaly.barName ?? '—'} · ${openAnomaly.periodLabel}` : ''}
        badge={
          openAnomaly ? (
            <Badge
              tone={
                openAnomaly.severity === '严重' ? 'danger' : openAnomaly.severity === '高' ? 'warn' : 'primary'
              }
            >
              {openAnomaly.severity}
            </Badge>
          ) : null
        }
        onClose={() => setOpenAnomaly(null)}
      >
        {openAnomaly && anomalyDetail ? (
          <AnomalyDetailPanel
            anomaly={openAnomaly}
            detail={anomalyDetail}
            onFocusBar={(bid) => {
              setBarId(bid);
              setOpenAnomaly(null);
            }}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={barDrawerData !== null}
        title={barDrawerData ? `贴吧详情 ${barDrawerData.bar.name}` : ''}
        subtitle={
          barDrawerData
            ? `${barDrawerData.bar.category} · ${barDrawerData.bar.tier} 级 · 接入 AIGC 生产 ${barDrawerData.bar.openedAt}`
            : ''
        }
        badge={
          barDrawerData ? (
            <Badge tone={barDrawerData.bar.tier === 'S' ? 'danger' : 'primary'}>
              {barDrawerData.bar.tier} 级
            </Badge>
          ) : null
        }
        onClose={() => setOpenBarId(null)}
      >
        {barDrawerData ? (
          <BarDrawer
            bar={barDrawerData.bar}
            agg={barDrawerData.agg}
            typeRows={barDrawerData.typeRows}
            rankRows={barDrawerData.rankRows}
            jumpFailRows={barDrawerData.jumpFailRows}
            samples={barDrawerData.samples}
            reviewOf={barDrawerData.reviewOf}
            queryNameOf={barDrawerData.queryNameOf}
            anomalies={barDrawerData.anomalies}
            onOpenAnomaly={(a) => {
              setOpenBarId(null);
              setOpenAnomaly(a);
            }}
          />
        ) : null}
      </Drawer>
    </div>
  );
}
