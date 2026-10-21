/**
 * 测试夹具：手工构造可精确断言的小数据集。
 *
 * 只被 *.test.ts 引用，不会进入应用构建。
 * 之所以不读 public/data 下的生成产物，是因为那样断言会随生成脚本的参数漂移，
 * 测的就不是「口径」而是「恰好这份数据」。
 */

import type {
  Bar,
  ClickEvent,
  Content,
  ContentEval,
  ContentType,
  Dataset,
  DistributeEvent,
  EvalDimension,
  Events,
  Filters,
  GenerationTask,
  ImpressionStat,
  JumpBackEvent,
  Meta,
  QueryDictItem,
  QueryEvent,
  ReviewRecord,
  ReviewStage,
} from '../types';
import { buildContentIndex, type ContentIndex } from './metrics';

export const D1 = '2026-10-10';
export const D2 = '2026-10-11';
export const D3 = '2026-10-12';

export const ts = (day: string, hh = 10, mm = 0): string =>
  `${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;

export const BARS: Bar[] = [
  { id: 'B1', name: '甲吧', category: '学习', tier: 'S', openedAt: '2026-09-01' },
  { id: 'B2', name: '乙吧', category: '生活', tier: 'A', openedAt: '2026-09-05' },
];

export const QUERIES: QueryDictItem[] = [
  { id: 'Q1', name: '考研数学怎么学', category: '学习方法' },
  { id: 'Q2', name: '租房避坑', category: '生活经验' },
  { id: 'Q3', name: '考研政治怎么背', category: '学习方法' },
  { id: 'Q4', name: '考研英语长难句', category: '学习方法' },
];

export const CONTENT_TYPES: ContentType[] = [
  { id: 'CT-IMG', name: '图文帖' },
  { id: 'CT-VIDEO', name: '视频帖' },
];

export const ALL_PASS = { auto: 'pass', manual: 'pass', quality: 'pass' } as const;

/** 测试里通用的低分原因 id，与 mock_meta.json 的字典保持同一形态 */
export const EVAL_ISSUE_IDS: Record<EvalDimension, string> = {
  visual: 'VIS_BLUR',
  av_sync: 'AV_LIP',
  relevance: 'REL_KEYWORD',
  material: 'MAT_LOW_RES',
  readability: 'READ_TERM',
  factuality: 'FACT_ERROR',
};

/** 按内容类型生成一份「中上水平」的默认维度分；声画一致性仅视频帖适用 */
const DEFAULT_SCORES: Record<string, Partial<Record<EvalDimension, number>>> = {
  'CT-IMG': { visual: 78, relevance: 82, material: 76, readability: 80, factuality: 83 },
  'CT-VIDEO': {
    visual: 76,
    av_sync: 79,
    relevance: 80,
    material: 74,
    readability: 78,
    factuality: 82,
  },
};

export const RANGE: Filters = {
  range: { startDate: D1, endDate: D2 },
  barId: 'ALL',
  contentType: 'ALL',
};

/** 把 id -> 名称的对象转成 metrics 层需要的字典 */
export const dict = (items: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(items));

export interface Spec {
  barId?: string;
  queryId?: string;
  contentType?: string;
  day?: string;
  status?: GenerationTask['status'];
  durationMs?: number | null;
  failureReason?: string | null;
  /** 三层审核结论；某层为 reject 时，其后的层不再生成记录 */
  reviews?: Partial<Record<ReviewStage, ReviewRecord['status']>>;
  rejectReason?: string | null;
  /** 分发到手百搜索结果页时的展示位次 */
  rankInPage?: number;
  /** 曝光：曝光日 -> 次数 */
  impressions?: Record<string, number>;
  clicks?: number;
  jumpSuccess?: number;
  jumpFail?: number;
  /** 自动评测的维度分；缺键表示该维度不适用。缺省时按 contentType 生成一份中等分 */
  scores?: Partial<Record<EvalDimension, number>>;
  /** 人工复核的维度分；给了才会产出 source = 'human' 的评测 */
  humanScores?: Partial<Record<EvalDimension, number>>;
  evalModelVersion?: string;
  /** issues 缺省时按「分 < 70 的维度各产出一条」自动生成 */
  issues?: ContentEval['issues'];
}

export interface Built {
  events: Events;
  ds: Dataset;
  index: ContentIndex;
  /** 每条 spec 产出的 contentId / distributeId，便于精确断言 */
  ids: { contentId: string; distributeId: string | null }[];
}

export const META: Meta = {
  datasetName: 'test',
  seed: 1,
  timezone: 'Asia/Shanghai',
  baselineTime: `${D3}T20:00:00`,
  dataUpdateTime: `${D3}T20:00:00`,
  businessDays: 3,
  startDate: D1,
  endDate: D3,
  counts: {},
  dictionaries: {
    queryCategories: [
      { id: '学习方法', name: '学习方法' },
      { id: '生活经验', name: '生活经验' },
    ],
    contentTypes: CONTENT_TYPES,
    reviewStages: [
      { id: 'auto', name: '机审' },
      { id: 'manual', name: '人审' },
      { id: 'quality', name: '质量审核' },
    ],
    reviewRejectReasons: {
      auto: [
        { id: '机审-违规', name: '机审-违规' },
        { id: '机审-低质', name: '机审-低质' },
      ],
      manual: [
        { id: '人审-低质', name: '人审-低质' },
        { id: '人审-事实错误', name: '人审-事实错误' },
      ],
      quality: [{ id: '质量-可读性', name: '质量-可读性' }],
    },
    failureReasons: [{ id: 'FR_TIMEOUT', name: '模型推理超时' }],
    jumpFailReasons: [{ id: '未安装贴吧App', name: '未安装贴吧App' }],
    evalIssueReasons: {
      visual: [{ id: EVAL_ISSUE_IDS.visual, name: '画面模糊 / 抖动' }],
      av_sync: [{ id: EVAL_ISSUE_IDS.av_sync, name: '口型与音轨不对齐' }],
      relevance: [{ id: EVAL_ISSUE_IDS.relevance, name: '未覆盖 Query 核心问题' }],
      material: [{ id: EVAL_ISSUE_IDS.material, name: '素材分辨率过低' }],
      readability: [{ id: EVAL_ISSUE_IDS.readability, name: '行文退化为无小标题长段落' }],
      factuality: [{ id: EVAL_ISSUE_IDS.factuality, name: '存在事实性错误' }],
    },
    slotPositions: [],
  },
  anomalyScenarios: [],
  notes: [],
};

/** 按 spec 逐条生成一条完整链路：搜索 → 任务 → 内容 → 三层审核 → 分发 → 曝光 → 点击 → 调起 */
export function build(specs: Spec[]): Built {
  const queryEvents: QueryEvent[] = [];
  const generationTasks: GenerationTask[] = [];
  const contents: Content[] = [];
  const reviews: ReviewRecord[] = [];
  const evals: ContentEval[] = [];
  const distributes: DistributeEvent[] = [];
  const impressionStats: ImpressionStat[] = [];
  const clicks: ClickEvent[] = [];
  const jumpBacks: JumpBackEvent[] = [];
  const ids: Built['ids'] = [];

  specs.forEach((s, i) => {
    const n = i + 1;
    const barId = s.barId ?? 'B1';
    const queryId = s.queryId ?? 'Q1';
    const contentType = s.contentType ?? 'CT-IMG';
    const day = s.day ?? D1;

    queryEvents.push({ eventId: `QE${n}`, ts: ts(day), barId, queryId, userId: `U${n}` });
    generationTasks.push({
      taskId: `T${n}`,
      ts: ts(day),
      barId,
      queryId,
      contentType,
      userId: `U${n}`,
      status: s.status ?? 'success',
      durationMs: s.durationMs === undefined ? 3000 : s.durationMs,
      failureReason: s.failureReason ?? null,
    });

    const contentId = `C${n}`;
    contents.push({
      contentId,
      taskId: `T${n}`,
      version: 1,
      ts: ts(day),
      barId,
      queryId,
      contentType,
    });

    let broken = false;
    for (const stage of ['auto', 'manual', 'quality'] as ReviewStage[]) {
      const status = s.reviews?.[stage];
      if (broken) break;
      if (status === undefined) continue;
      if (status === 'reject') broken = true;
      reviews.push({
        reviewId: `R${n}${stage[0]}`,
        contentId,
        stage,
        ts: ts(day, 12),
        status,
        rejectReason: status === 'reject' ? (s.rejectReason ?? '机审-低质') : null,
        costMs: 2000,
      });
    }

    // 评测紧跟内容生成发生，归因到同一天
    const scores = s.scores ?? DEFAULT_SCORES[contentType] ?? {};
    const autoIssues =
      s.issues ??
      (Object.entries(scores) as Array<[EvalDimension, number]>)
        .filter(([, v]) => v < 70)
        .map(([dim]) => ({ dim, reason: EVAL_ISSUE_IDS[dim] }));
    evals.push({
      evalId: `EV${n}`,
      contentId,
      barId,
      queryId,
      contentType,
      ts: ts(day, 11),
      source: 'auto',
      scores,
      issues: autoIssues,
      modelVersion: s.evalModelVersion ?? 'ev-test',
    });
    if (s.humanScores) {
      evals.push({
        evalId: `EV${n}h`,
        contentId,
        barId,
        queryId,
        contentType,
        ts: ts(day, 18),
        source: 'human',
        scores: s.humanScores,
        issues: [],
        modelVersion: 'human',
      });
    }

    let distributeId: string | null = null;
    if (s.rankInPage !== undefined) {
      distributeId = `D${n}`;
      distributes.push({
        distributeId,
        contentId,
        ts: ts(day, 13),
        barId,
        queryId,
        rankInPage: s.rankInPage,
        slot: s.rankInPage <= 3 ? 'top' : s.rankInPage <= 8 ? 'middle' : 'bottom',
      });
      for (const [impDay, imp] of Object.entries(s.impressions ?? {})) {
        impressionStats.push({
          distributeId,
          contentId,
          day: impDay,
          rankInPage: s.rankInPage,
          impressions: imp,
        });
      }
      for (let k = 0; k < (s.clicks ?? 0); k += 1) {
        clicks.push({
          eventId: `K${n}_${k}`,
          ts: ts(day, 14),
          distributeId,
          contentId,
          barId,
          queryId,
        });
      }
      for (let k = 0; k < (s.jumpSuccess ?? 0); k += 1) {
        jumpBacks.push({
          eventId: `J${n}_s${k}`,
          ts: ts(day, 15),
          contentId,
          barId,
          queryId,
          status: 'success',
          failReason: null,
        });
      }
      for (let k = 0; k < (s.jumpFail ?? 0); k += 1) {
        jumpBacks.push({
          eventId: `J${n}_f${k}`,
          ts: ts(day, 15),
          contentId,
          barId,
          queryId,
          status: 'failed',
          failReason: '未安装贴吧App',
        });
      }
    }
    ids.push({ contentId, distributeId });
  });

  const events: Events = {
    queryEvents,
    generationTasks,
    contents,
    reviews,
    evals,
    distributes,
    impressionStats,
    clicks,
    jumpBacks,
  };

  const ds: Dataset = { bars: BARS, queries: QUERIES, events, meta: META };
  return { events, ds, index: buildContentIndex(events, QUERIES), ids };
}

/** 批量生成同一 pattern 的 spec */
export const repeat = (n: number, spec: Spec): Spec[] =>
  Array.from({ length: n }, () => ({ ...spec }));
