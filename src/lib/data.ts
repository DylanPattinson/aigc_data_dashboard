import type {
  Bar,
  Dataset,
  EvalDimension,
  Events,
  Meta,
  QueryDictItem,
  ReviewStage,
} from '../types';

const BASE = import.meta.env.BASE_URL ?? '/';

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}data/${path}`);
  if (!res.ok) {
    throw new Error(`加载 ${path} 失败：HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function loadDataset(): Promise<Dataset> {
  const [bars, queries, events, meta] = await Promise.all([
    fetchJson<Bar[]>('mock_bars.json'),
    fetchJson<QueryDictItem[]>('mock_queries.json'),
    fetchJson<Events>('mock_events.json'),
    fetchJson<Meta>('mock_meta.json'),
  ]);
  return { bars, queries, events, meta };
}

export interface Dicts {
  /** Query 意图分类 id -> 名称 */
  queryCategories: Map<string, string>;
  /** 内容类型 id -> 名称 */
  contentTypes: Map<string, string>;
  failureReasons: Map<string, string>;
  jumpFailReasons: Map<string, string>;
  /** 按审核环节分组的拒绝原因 id -> 名称 */
  reviewRejectReasons: Record<ReviewStage, Map<string, string>>;
  /** 按评测维度分组的低分原因 id -> 名称 */
  evalIssueReasons: Record<EvalDimension, Map<string, string>>;
}

const toMap = (items: { id: string; name: string }[]): Map<string, string> =>
  new Map(items.map((i) => [i.id, i.name]));

export function buildDicts(meta: Meta): Dicts {
  const reject = meta.dictionaries.reviewRejectReasons;
  return {
    queryCategories: toMap(meta.dictionaries.queryCategories),
    contentTypes: toMap(meta.dictionaries.contentTypes),
    failureReasons: toMap(meta.dictionaries.failureReasons),
    jumpFailReasons: toMap(meta.dictionaries.jumpFailReasons),
    reviewRejectReasons: {
      auto: toMap(reject.auto),
      manual: toMap(reject.manual),
      quality: toMap(reject.quality),
    },
    evalIssueReasons: Object.fromEntries(
      Object.entries(meta.dictionaries.evalIssueReasons ?? {}).map(([dim, items]) => [
        dim,
        toMap(items),
      ]),
    ) as Record<EvalDimension, Map<string, string>>,
  };
}