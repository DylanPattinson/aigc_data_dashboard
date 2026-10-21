/**
 * 数据模型定义
 *
 * 业务场景：贴吧侧用 AIGC 能力针对用户在手百搜索的 Query 批量生成图文帖 / 视频帖，
 * 经机审 → 人审 → 质量审核三层把关后，分发到手百搜索结果页，用户点击后调起贴吧。
 *
 * 全链路关联关系：
 *   barId（贴吧） → queryId（搜索 Query） → taskId（生成任务） → contentId（内容）
 *   → reviews（按 contentId，三层 stage 区分）→ distributeId（分发到手百结果页）
 *   → impressionStat（按日聚合的曝光计数）/ clickEvent / jumpBackEvent
 *
 * 说明：三层审核的最终结论不在 Content 上预存布尔字段，
 * 而是由 buildContentIndex() 在运行时从 reviews 派生，保证指标不写死。
 */

export interface Bar {
  id: string;
  name: string;
  /** 一级分类，如「学习」「生活」「娱乐」 */
  category: string;
  /** 贴吧分级，用于增长优先级排序 */
  tier: 'S' | 'A' | 'B' | 'C';
  /** 接入 AIGC 生产的日期 */
  openedAt: string;
}

export interface QueryDictItem {
  id: string;
  name: string;
  /** Query 意图分类 id，对应 Meta.dictionaries.queryCategories */
  category: string;
}

export interface ContentType {
  id: string;
  name: string;
}

export type GenerationStatus = 'success' | 'failed' | 'pending';
export type ReviewStage = 'auto' | 'manual' | 'quality';
export type ReviewVerdict = 'pass' | 'reject' | 'pending';
export type JumpStatus = 'success' | 'failed';
export type DistributeSlot = 'top' | 'middle' | 'bottom';

/** 搜索需求侧事件：用户在手百搜索了某个 Query（与内容生产解耦，仅作需求上下文） */
export interface QueryEvent {
  eventId: string;
  ts: string;
  barId: string;
  queryId: string;
  userId: string;
}

/** AIGC 内容生成任务 */
export interface GenerationTask {
  taskId: string;
  ts: string;
  barId: string;
  queryId: string;
  contentType: string;
  userId: string;
  status: GenerationStatus;
  /** 成功任务的生成耗时（毫秒）；失败 / 生成中为 null */
  durationMs: number | null;
  /** 失败原因编码；仅 status = failed 时有值 */
  failureReason: string | null;
}

/** 生成产出的内容；同一 taskId 可产出多个 version（挑优重生成） */
export interface Content {
  contentId: string;
  taskId: string;
  version: number;
  ts: string;
  barId: string;
  queryId: string;
  contentType: string;
}

/** 单层审核记录；机审 / 人审 / 质量审核三条 stage 串行 */
export interface ReviewRecord {
  reviewId: string;
  contentId: string;
  stage: ReviewStage;
  ts: string;
  status: ReviewVerdict;
  /** 拒绝原因编码；仅 status = reject 时有值，按 stage 取不同字典 */
  rejectReason: string | null;
  /** 该层审核耗时（毫秒），用于评估审核积压与人工成本 */
  costMs: number | null;
}

/** 内容质量评测维度；av_sync 仅视频帖适用，图文帖的 scores 里不写该键 */
export type EvalDimension =
  | 'visual'
  | 'av_sync'
  | 'relevance'
  | 'material'
  | 'readability'
  | 'factuality';

/** 评测来源：auto = 评测模型全量打分，human = 人审抽样复核 */
export type EvalSource = 'auto' | 'human';

/**
 * 单条内容的一次评测结果。
 * 一条记录含该来源下的全部适用维度分（而不是每维度一条），
 * 与真实评测系统「一次评测任务产出一份多维打分结果」的形态一致。
 */
export interface ContentEval {
  evalId: string;
  contentId: string;
  barId: string;
  queryId: string;
  contentType: string;
  /** 评测时间，归属到内容生成日，与内容 / 审核 / 分发同口径 */
  ts: string;
  source: EvalSource;
  /** 维度分 0~100；不适用的维度缺键 */
  scores: Partial<Record<EvalDimension, number>>;
  /** 仅低分维度（< 70）产出，用于下钻看扣分原因 */
  issues: Array<{ dim: EvalDimension; reason: string }>;
  /** 评测模型版本，用于看迭代效果 */
  modelVersion: string;
}

/** 内容分发到手百搜索结果页 */
export interface DistributeEvent {
  distributeId: string;
  contentId: string;
  ts: string;
  barId: string;
  queryId: string;
  /** 在搜索结果页中的展示位次（1 为首位） */
  rankInPage: number;
  slot: DistributeSlot;
}

/**
 * 曝光聚合记录。
 * 曝光是链路中量级最大的一环，逐条存储会使数据文件膨胀到上百 MB，
 * 因此按「内容 × 分发 × 日 × 位次」聚合计数；点击与调起仍为逐条事件。
 */
export interface ImpressionStat {
  distributeId: string;
  contentId: string;
  /** 曝光发生日，格式 YYYY-MM-DD */
  day: string;
  rankInPage: number;
  impressions: number;
}

/** 搜索结果页点击（逐条） */
export interface ClickEvent {
  eventId: string;
  ts: string;
  distributeId: string;
  contentId: string;
  barId: string;
  queryId: string;
}

/** 点击后调起贴吧（逐条） */
export interface JumpBackEvent {
  eventId: string;
  ts: string;
  contentId: string;
  barId: string;
  queryId: string;
  status: JumpStatus;
  failReason: string | null;
}

export interface Events {
  queryEvents: QueryEvent[];
  generationTasks: GenerationTask[];
  contents: Content[];
  /** 三层审核混存，靠 stage 字段区分 */
  reviews: ReviewRecord[];
  /** 内容质量评测，auto 全量 + human 抽样，靠 source 字段区分 */
  evals: ContentEval[];
  distributes: DistributeEvent[];
  impressionStats: ImpressionStat[];
  clicks: ClickEvent[];
  jumpBacks: JumpBackEvent[];
}

export interface MetaDictItem {
  id: string;
  name: string;
}

export interface MetaAnomalyScenario {
  id: string;
  name: string;
  barId: string | null;
  queryCategory: string | null;
  window: [string, string];
  evidence: string;
}

export interface Meta {
  datasetName: string;
  seed: number;
  timezone: string;
  baselineTime: string;
  dataUpdateTime: string;
  businessDays: number;
  startDate: string;
  endDate: string;
  counts: Record<string, number>;
  dictionaries: {
    queryCategories: MetaDictItem[];
    contentTypes: ContentType[];
    reviewStages: MetaDictItem[];
    /** 按 stage 分组的拒绝原因字典 */
    reviewRejectReasons: Record<ReviewStage, MetaDictItem[]>;
    /** 按评测维度分组的低分原因字典 */
    evalIssueReasons: Record<EvalDimension, MetaDictItem[]>;
    failureReasons: MetaDictItem[];
    jumpFailReasons: MetaDictItem[];
    slotPositions: MetaDictItem[];
  };
  anomalyScenarios: MetaAnomalyScenario[];
  notes: string[];
}

export interface Dataset {
  bars: Bar[];
  queries: QueryDictItem[];
  events: Events;
  meta: Meta;
}

export interface DateRange {
  /** 含首日，格式 YYYY-MM-DD */
  startDate: string;
  /** 含末日，格式 YYYY-MM-DD */
  endDate: string;
}

export interface Filters {
  range: DateRange;
  /** 'ALL' 表示全部贴吧 */
  barId: string;
  /** 'ALL' 表示全部内容类型 */
  contentType: string;
}