/**
 * 演示用异常阈值与展示配置
 *
 * ⚠️ 这里的阈值是「演示规则」，不是业务铁律。
 * 调整下面的常量即可改变异常识别结果，前端「阈值说明」区域会同步展示这里的取值。
 */

export const THRESHOLDS = {
  /**
   * 规则 R1：贴吧·日 生成成功率下限。
   * 贴吧·日只有 20~45 次生成尝试，二项噪声本身就能把成功率打到 90% 附近，
   * 因此阈值定在 90%，常态基线（成功率 ~99.2%）与之留出足够余量。
   */
  genSuccessRateMin: 0.9,
  /** 规则 R1：最小样本量（当日已完成生成尝试次数） */
  genSuccessRateMinSamples: 20,

  /** 规则 R2：贴吧·日 平均生成时长上限（毫秒） */
  avgDurationMaxMs: 12_000,
  /** 规则 R2：最小样本量（当日成功任务数） */
  avgDurationMinSamples: 20,

  /**
   * 规则 R3：单个审核环节的拒绝率上限。
   * 严格质量控制下常态拒绝率约 8%~13%，但贴吧·日每环节只有 20~30 条，
   * 35% 在这个样本量下仍会被二项噪声偶尔穿透，因此上抬到 40%；
   * 注入场景（人审拒绝率 60%+）仍稳稳越线。
   */
  reviewRejectRateMax: 0.4,
  /** 规则 R3：单个审核环节的待审积压上限（条） */
  reviewPendingMaxCount: 50,
  /** 规则 R3：最小样本量（进入该环节的内容数） */
  reviewMinSamples: 20,

  /** 规则 R4：单个 Query 分类的日均内容供给下限（条） */
  querySupplyMin: 5,
  /** 规则 R4：判定断供需要连续低于下限的天数 */
  querySupplyBreakDays: 3,
  /** 规则 R4：统计断供的最小区间天数 */
  querySupplyMinRangeDays: 7,
  /**
   * 规则 R4：该分类在贴吧内至少要有这么多个 Query 才纳入断供判定。
   * Query 数不足时，该分类的日产出由单个搜索词的权重决定，天然低于供给下限，
   * 属于结构性低产而非「断供」，不应告警。
   * 取 3 是因为：本项目里 Query 数 <= 2 的分类日均产出中位数仅 4~6 条，
   * 与 querySupplyMin=5 同一量级，无法与真断供区分。
   */
  querySupplyMinQueries: 3,

  /** 规则 R5：搜索结果页 CTR 下限 */
  ctrMin: 0.06,
  /** 规则 R5：调起贴吧成功率下限 */
  jumpRateMin: 0.45,
  /** 规则 R5：最小样本量（区间内曝光量） */
  ctrMinImpressions: 500,
  /** 规则 R5：调起率的最小样本量（区间内点击量） */
  jumpRateMinClicks: 50,

  /**
   * 规则 R6：单个评测维度的不合格率上限（分档为「中」或「差」的占比）。
   * AIGC 批量生产里「某一维度不合格」本就是常态（本项目基线 20%~45%），
   * 因此这条规则只能在「贴吧·区间」粒度上判定：区间样本 200+ 时二项噪声仅约 1.5%，
   * 45% 的常态水位与 55% 的阈值之间留出 6σ 以上余量；
   * 若按「贴吧·日」判定，每吧每天只有 20~45 条内容，噪声本身就能把比率打到阈值线上。
   */
  evalFailRateMax: 0.55,
  /** 规则 R6：区间综合质量分下限（常态基线约 76.7 分） */
  evalScoreMin: 66,
  /** 规则 R6：人机分档一致率下限（自动评测与人工复核判定为同一档的占比，常态约 91%） */
  evalAgreeRateMin: 0.72,
  /** 规则 R6：最小样本量（区间内该维度被打分的内容数） */
  evalMinSamples: 200,
  /** 规则 R6：人机一致率的最小样本量（同时被自动评测与人审复核的内容数） */
  evalAgreeMinSamples: 40,
} as const;

/** 严重度分档（超过该值升级为「严重」） */
export const SEVERITY_ESCALATION = {
  genSuccessRateCritical: 0.8,
  avgDurationCriticalMs: 25_000,
  reviewRejectRateCritical: 0.55,
  reviewPendingCriticalCount: 200,
  querySupplyBreakDaysCritical: 5,
  ctrCritical: 0.02,
  jumpRateCritical: 0.2,
  evalFailRateCritical: 0.72,
  evalScoreCritical: 58,
  evalAgreeRateCritical: 0.6,
} as const;

export const COLORS = {
  primary: '#2F5BE3',
  primarySoft: '#E8EEFD',
  success: '#17A673',
  successSoft: '#E3F6EE',
  danger: '#E0483C',
  dangerSoft: '#FDECEA',
  warn: '#E08A1E',
  warnSoft: '#FDF3E3',
  purple: '#7A5AF8',
  purpleSoft: '#EEEBFE',
  gray: '#8A9099',
  graySoft: '#F1F3F5',
  text: '#1F2329',
  textSub: '#646A73',
  border: '#E5E8EC',
  bg: '#F5F6F8',
  card: '#FFFFFF',
} as const;

/** 图表配色序列 */
export const CHART_COLORS = [
  '#2F5BE3',
  '#17A673',
  '#E0483C',
  '#E08A1E',
  '#7A5AF8',
  '#0FA3B1',
  '#B5569E',
  '#5B6673',
];

/** 三层审核各环节的固定配色，保证跨页面同环节同色 */
export const STAGE_COLORS: Record<string, string> = {
  auto: '#2F5BE3',
  manual: '#E08A1E',
  quality: '#7A5AF8',
};

export const STAGE_LABELS: Record<string, string> = {
  auto: '机审',
  manual: '人审',
  quality: '质量审核',
};

/** 审核环节串行顺序 */
export const REVIEW_STAGES = ['auto', 'manual', 'quality'] as const;

// ---------------------------------------------------------------------------
// AIGC 内容评测
// ---------------------------------------------------------------------------

/** 评测维度（顺序即图表与表格的展示顺序） */
export const EVAL_DIMENSIONS = [
  'visual',
  'av_sync',
  'relevance',
  'material',
  'readability',
  'factuality',
] as const;

export type EvalDimensionKey = (typeof EVAL_DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<string, string> = {
  visual: '画面质量',
  av_sync: '声画一致性',
  relevance: '内容-Query 符合度',
  material: '图片素材质量',
  readability: '文本可读性',
  factuality: '事实性与合规',
};

/** 维度适用的内容类型；其余内容类型的 scores 里不写该键 */
export const DIMENSION_APPLIES_TO: Record<string, string[]> = {
  visual: ['CT-IMG', 'CT-VIDEO'],
  av_sync: ['CT-VIDEO'],
  relevance: ['CT-IMG', 'CT-VIDEO'],
  material: ['CT-IMG', 'CT-VIDEO'],
  readability: ['CT-IMG', 'CT-VIDEO'],
  factuality: ['CT-IMG', 'CT-VIDEO'],
};

/** 维度短名，图表坐标轴与热力图表头用 */
export const DIMENSION_SHORT: Record<string, string> = {
  visual: '画面',
  av_sync: '声画',
  relevance: '符合度',
  material: '素材',
  readability: '可读性',
  factuality: '事实性',
};

/** 评测来源 */
export const EVAL_SOURCES = ['auto', 'human'] as const;

export const EVAL_SOURCE_LABELS: Record<string, string> = {
  auto: '评测模型（全量）',
  human: '人工复核（抽样）',
};

/**
 * 综合质量分的维度权重。
 * 内容-Query 符合度与事实性合规权重最高——它们直接决定内容是否「答非所问」或「有风险」；
 * 画面与素材质量对转化影响大但可通过换素材快速修复，权重略低。
 */
export const DIMENSION_WEIGHTS: Record<string, number> = {
  visual: 0.16,
  av_sync: 0.14,
  relevance: 0.24,
  material: 0.12,
  readability: 0.17,
  factuality: 0.17,
};

/** 分数分档阈值（0~100 分，闭开区间上界） */
export const SCORE_GRADES = {
  excellent: 85,
  good: 70,
  fair: 55,
} as const;

export const GRADE_LABELS = ['优', '良', '中', '差'] as const;
export type GradeKey = 0 | 1 | 2 | 3;

/** 各维度固定配色，保证跨页面同维度同色 */
export const DIMENSION_COLORS: Record<string, string> = {
  visual: '#2F5BE3',
  av_sync: '#0FA3B1',
  relevance: '#17A673',
  material: '#E08A1E',
  readability: '#7A5AF8',
  factuality: '#B5569E',
};

/** 状态 / 原因到配色的映射 */
export const STATUS_COLORS: Record<string, string> = {
  success: COLORS.success,
  failed: COLORS.danger,
  pending: COLORS.gray,
  pass: COLORS.success,
  reject: COLORS.danger,
};

export const SEVERITY_META: Record<
  string,
  { label: string; color: string; bg: string; order: number }
> = {
  严重: { label: '严重', color: COLORS.danger, bg: COLORS.dangerSoft, order: 0 },
  高: { label: '高', color: COLORS.warn, bg: COLORS.warnSoft, order: 1 },
  中: { label: '中', color: COLORS.primary, bg: COLORS.primarySoft, order: 2 },
};

/** 日期快捷选项 */
export const RANGE_PRESETS = [
  { key: 'today', label: '今日', days: 1 },
  { key: '7d', label: '近 7 天', days: 7 },
  { key: '30d', label: '近 30 天', days: 30 },
] as const;

export type RangePresetKey = (typeof RANGE_PRESETS)[number]['key'];