import { useState } from 'react';
import { BookOpen, ChevronDown, ChevronUp } from 'lucide-react';
import { THRESHOLDS } from '../lib/config';

const ROWS: { name: string; def: string; formula: string; note: string }[] = [
  {
    name: '搜索用户规模',
    def: '统计期内发起搜索事件的去重用户数',
    formula: 'count(distinct userId where 搜索事件在区间内)',
    note: '跨贴吧重复用户只计一次；各贴吧独立去重之和与全局去重的差额即跨贴吧重复人数',
  },
  {
    name: 'AIGC 生成成功率',
    def: '成功生成任务占已完成生成尝试的比例',
    formula: '成功任务数 / (成功 + 失败)；生成中(pending)不计入分母',
    note: '失败原因分为模型推理超时 / 模型服务异常 / Query 改写失败 / 素材检索为空，属于生成链路问题',
  },
  {
    name: '平均生成时长',
    def: '成功任务生成耗时的算术平均值',
    formula: 'mean(durationMs where status = success)',
    note: `同时展示 P95 与超 ${(THRESHOLDS.avgDurationMaxMs / 1000).toFixed(0)}s 任务占比，用于识别长尾而非只看均值；视频帖耗时天然高于图文帖`,
  },
  {
    name: '三层审核通过率',
    def: '三层审核全部通过的内容占已进入机审内容的比例',
    formula: '三层全 pass 内容数 / 至少进入机审的内容数；各环待审不计入分母',
    note: '三层结论在运行时由 buildContentIndex() 按 contentId 归拢 reviews 派生，不在内容上预存布尔字段',
  },
  {
    name: '本环通过率',
    def: '某个审核环节通过数占该环已完成审核数的比例',
    formula: '该环 pass / (该环 pass + 该环 reject)；pending 不计入分母',
    note: '三环串行，任一环拒绝都会使后续环不再进入该内容，因此「本环通过率」与「链路留存率」是两个不同口径',
  },
  {
    name: '搜索结果 CTR',
    def: '手百搜索结果页的点击事件数与曝光量之比',
    formula: '点击事件数 / 搜索曝光量',
    note: '位次 CTR 与各分吧 CTR 使用同一分母口径，可直接横向比对；曝光按「内容 × 分发 × 日 × 位次」聚合计数',
  },
  {
    name: '调起贴吧成功率',
    def: '点击后成功调起贴吧的次数占调起尝试次数的比例',
    formula: '成功调起次数 / 调起次数；分母为 0 时返回 null，页面展示 —',
    note: '失败原因分为未安装贴吧 App / App 版本过低 / 网络失败 / 用户取消，指向用户构成与跳转链路',
  },
  {
    name: 'AIGC 综合质量分',
    def: '评测模型对每条内容在 6 个维度打分后按权重加权的综合分（0~100）',
    formula: 'Σ(维度分 × 维度权重) / Σ(实际被打分的维度权重)',
    note: '不适用的维度不参与加权（图文帖无「声画一致性」），分母按实际适用维度归一，因此图文帖与视频帖的综合分可直接横向比对',
  },
  {
    name: '质量分档与达标率',
    def: '按综合分切四档：优 ≥85 / 良 70~85 / 中 55~70 / 差 <55',
    formula: '质量达标率 =（优 + 良）内容数 / 已评测内容数；不合格率 =（中 + 差）占比',
    note: '分档阈值固定在 config.SCORE_GRADES，页面所有分档、达标率、异常规则共用同一套阈值',
  },
  {
    name: '人机一致率',
    def: '人工复核与评测模型对同一条内容判定为同一档的比例',
    formula: '分档一致的内容数 / 同时被自动评测与人审复核的内容数',
    note: '人审按比例抽样复核全部内容中的少数；一致率低于阈值说明评测模型需重新校准，而不是内容质量下滑',
  },
  {
    name: '维度不合格率',
    def: '某维度分档为「中」或「差」的内容占该维度被打分内容的比例',
    formula: 'Σ(该维度 gradeOf(v) ≥ 中 的内容数) / 该维度被打分内容数',
    note: 'R6 质量异常的主力规则。AIGC 批量生产里单维不合格本属常态，只能在「贴吧·区间」粒度判定以避开小样本二项噪声',
  },
  {
    name: '归属口径',
    def: '各环节事件归到哪一天统计',
    formula: '搜索事件与生成任务按事件自身 ts 的自然日；内容、三层审核、评测、分发、点击、调起统一归因到「内容生成日」',
    note: '曝光按曝光日归属。统一归因可保证「生成成功 → 三层审核 → 分发 → 曝光 → 点击 → 调起」各步口径一致、可比对',
  },
];

export default function MetricsNoteSection() {
  const [open, setOpen] = useState(false);
  return (
    <div className="section" id="sec-metrics">
      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">
              <BookOpen size={14} /> 指标口径与边界说明
            </h3>
            <p className="card-sub">
              所有指标均从同一套事件级原始数据派生；时间归属：搜索与生成按事件自身日期，内容 / 审核 / 评测 / 分发 / 点击 / 调起统一归因到内容生成日
            </p>
          </div>
          <button className="btn" onClick={() => setOpen(!open)}>
            {open ? '收起' : '展开明细'}
            {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
        {open ? (
          <div className="card-body" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 140 }}>指标</th>
                    <th style={{ width: 260 }}>业务定义</th>
                    <th style={{ width: 320 }}>计算公式</th>
                    <th>边界与说明</th>
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map((r) => (
                    <tr key={r.name}>
                      <td style={{ fontWeight: 600 }}>{r.name}</td>
                      <td style={{ whiteSpace: 'normal' }}>{r.def}</td>
                      <td style={{ whiteSpace: 'normal' }}>{r.formula}</td>
                      <td style={{ whiteSpace: 'normal', color: 'var(--c-text-sub)' }}>{r.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
