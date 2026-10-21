#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
贴吧 AIGC 内容增长看板 —— 模拟数据生成脚本

业务场景
--------
贴吧侧用 AIGC 能力，针对用户在手百（百度手机版）搜索的 Query 批量生成图文帖 / 视频帖；
内容经「机审 → 人审 → 质量审核」三层串行把关后，分发到手百搜索结果页；
用户在结果页看到并点击，点击后调起贴吧，从而推动贴吧用户增长。

设计原则
--------
1. 固定随机种子（SEED），同一份脚本多次运行产出字节级完全一致的结果，可复现。
2. 事件级数据，ID 全链路可关联：
   barId（贴吧） → queryId（搜索 Query） → taskId（生成任务） → contentId（内容）
   → reviews（按 contentId 区分 stage）→ distributeId（分发到手百结果页）
   → impressionStat（按日聚合）/ clickEvent / jumpBackEvent
3. 三层审核严格串行：机审 pass 才进人审，人审 pass 才进质量审核，三层全 pass 才分发；
   每个进入某环节的内容在该环节恰好一条 review 记录，故各 stage 条数依次递减。
4. 曝光是量级最大的一环，按「内容 × 分发 × 日 × 位次」聚合计数，不生成逐条曝光事件；
   点击与调起仍为逐条事件。
5. 5 个异常场景用硬编码时间窗口注入，异常在原始数据中留有真实证据，不在 UI 层编造，
   并登记在 meta.anomalyScenarios 中便于核验；窗口外的基础水位保持正常。
6. 所有时间戳为 Asia/Shanghai（UTC+8）本地时间，写入格式 YYYY-MM-DDTHH:MM:SS。
7. 不使用任何真实用户隐私信息，用户 ID 仅为匿名编号。

产出（写入 public/data/）
------------------------
mock_bars.json    贴吧维度表
mock_queries.json 搜索 Query 维度表
mock_events.json  事件事实表（8 类事件）
mock_meta.json    数据元信息：基准时间、种子、口径、注入的异常场景
"""

import json
import math
import os
import random
from datetime import datetime, timedelta

# ----------------------------------------------------------------------------
# 全局参数
# ----------------------------------------------------------------------------
SEED = 20261020                                  # 固定随机种子，保证可复现
BASELINE_TIME = datetime(2026, 10, 20, 23, 59, 0)  # 模拟数据基准时间（"当前时刻"）
DAYS = 60                                         # 业务数据天数（含基准日）
TS_FMT = "%Y-%m-%dT%H:%M:%S"
DAY_FMT = "%Y-%m-%d"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "public", "data")

rng = random.Random(SEED)

# ----------------------------------------------------------------------------
# 维度数据
# ----------------------------------------------------------------------------

# 贴吧维度：id / 名称 / 一级分类 / 分级 / 接入 AIGC 日期 / 日均生成任务数 / 视频帖占比
BARS = [
    ("BAR-01", "考研吧", "学习", "S", "2026-05-12", 37, 0.26),
    ("BAR-02", "摄影吧", "兴趣", "A", "2026-04-08", 29, 0.36),
    ("BAR-03", "汽车吧", "生活", "A", "2026-06-20", 27, 0.30),
    ("BAR-04", "健身吧", "生活", "B", "2026-07-15", 31, 0.40),
    ("BAR-05", "游戏吧", "娱乐", "S", "2026-05-28", 35, 0.44),
    ("BAR-06", "美食吧", "生活", "B", "2026-08-03", 32, 0.46),
]

CONTENT_TYPES = [
    ("CT-IMG", "图文帖"),
    ("CT-VIDEO", "视频帖"),
]

# Query 意图分类
QUERY_CATEGORIES = [
    ("QC-LIFE", "生活经验类"),
    ("QC-SCI", "科普知识类"),
    ("QC-NEWS", "时事热点类"),
    ("QC-HOBBY", "兴趣爱好类"),
    ("QC-EDU", "教育考试类"),
]

# 搜索 Query 词表：每类 16 个，共 80 个；格式（Query 名称, 意图分类 id, 归属贴吧 id）
# Query 与贴吧的关联不落库（QueryDictItem 只有 id/name/category），
# 仅在生成时用于「某个贴吧下会命中哪些搜索词」的业务合理性约束。
QUERY_TABLE = [
    # ---------------- 教育考试类（16）----------------
    ("考研英语作文模板", "QC-EDU", "BAR-01"),
    ("考研数学一怎么复习", "QC-EDU", "BAR-01"),
    ("考研政治什么时候开始", "QC-EDU", "BAR-01"),
    ("考研专业课资料怎么找", "QC-EDU", "BAR-01"),
    ("考研复试面试技巧", "QC-EDU", "BAR-01"),
    ("考研英语阅读理解技巧", "QC-EDU", "BAR-01"),
    ("考研数学强化阶段", "QC-EDU", "BAR-01"),
    ("考研院校怎么选", "QC-EDU", "BAR-01"),
    ("考研英语单词背诵方法", "QC-EDU", "BAR-01"),
    ("考研调剂流程", "QC-EDU", "BAR-01"),
    ("计算机考研408怎么复习", "QC-EDU", "BAR-01"),
    ("考研英语长难句", "QC-EDU", "BAR-01"),
    ("教资笔试题型", "QC-EDU", "BAR-01"),
    ("摄影考证怎么准备", "QC-EDU", "BAR-02"),
    ("健身教练证考试", "QC-EDU", "BAR-04"),
    ("驾照科目二技巧", "QC-EDU", "BAR-03"),
    # ---------------- 科普知识类（16）----------------
    ("宇宙是怎么形成的", "QC-SCI", "BAR-05"),
    ("黑洞照片是真的吗", "QC-SCI", "BAR-05"),
    ("相机传感器原理", "QC-SCI", "BAR-02"),
    ("光圈快门感光度区别", "QC-SCI", "BAR-02"),
    ("无人机航拍原理", "QC-SCI", "BAR-02"),
    ("混动车工作原理", "QC-SCI", "BAR-03"),
    ("涡轮增压原理", "QC-SCI", "BAR-03"),
    ("肌肉是怎么增长的", "QC-SCI", "BAR-04"),
    ("有氧和无氧运动区别", "QC-SCI", "BAR-04"),
    ("蛋白质摄入量多少合适", "QC-SCI", "BAR-04"),
    ("食品营养成分表怎么看", "QC-SCI", "BAR-06"),
    ("微波炉加热原理", "QC-SCI", "BAR-06"),
    ("食品添加剂安全吗", "QC-SCI", "BAR-06"),
    ("统计学显著性是什么意思", "QC-SCI", "BAR-01"),
    ("为什么天空是蓝色的", "QC-SCI", "BAR-05"),
    ("显卡原理科普", "QC-SCI", "BAR-05"),
    # ---------------- 生活经验类（16）----------------
    ("厨房收纳技巧", "QC-LIFE", "BAR-06"),
    ("周末备餐怎么做", "QC-LIFE", "BAR-06"),
    ("冰箱食材怎么整理", "QC-LIFE", "BAR-06"),
    ("外卖怎么点更健康", "QC-LIFE", "BAR-06"),
    ("厨房小白入门", "QC-LIFE", "BAR-06"),
    ("居家健身怎么安排", "QC-LIFE", "BAR-04"),
    ("新手增肌饮食", "QC-LIFE", "BAR-04"),
    ("办公室久坐怎么拉伸", "QC-LIFE", "BAR-04"),
    ("熬夜后怎么恢复", "QC-LIFE", "BAR-04"),
    ("异地搬家怎么省钱", "QC-LIFE", "BAR-03"),
    ("新手开车注意事项", "QC-LIFE", "BAR-03"),
    ("汽车保养怎么安排", "QC-LIFE", "BAR-03"),
    ("违章申诉流程", "QC-LIFE", "BAR-03"),
    ("新手买车怎么选", "QC-LIFE", "BAR-03"),
    ("露营装备怎么选", "QC-LIFE", "BAR-02"),
    ("相机怎么保养", "QC-LIFE", "BAR-02"),
    # ---------------- 兴趣爱好类（16）----------------
    ("游戏画质怎么调", "QC-HOBBY", "BAR-05"),
    ("独立游戏推荐", "QC-HOBBY", "BAR-05"),
    ("速通高手操作", "QC-HOBBY", "BAR-05"),
    ("游戏装备挑选", "QC-HOBBY", "BAR-05"),
    ("人像摄影技巧", "QC-HOBBY", "BAR-02"),
    ("风光摄影构图", "QC-HOBBY", "BAR-02"),
    ("摄影后期调色", "QC-HOBBY", "BAR-02"),
    ("镜头怎么选", "QC-HOBBY", "BAR-02"),
    ("增肌训练动作", "QC-HOBBY", "BAR-04"),
    ("减脂饮食搭配", "QC-HOBBY", "BAR-04"),
    ("卧推怎么练", "QC-HOBBY", "BAR-04"),
    ("马拉松训练计划", "QC-HOBBY", "BAR-04"),
    ("家常菜快手做法", "QC-HOBBY", "BAR-06"),
    ("烘焙入门", "QC-HOBBY", "BAR-06"),
    ("在家做烧烤", "QC-HOBBY", "BAR-06"),
    ("咖啡手冲入门", "QC-HOBBY", "BAR-06"),
    # ---------------- 时事热点类（16）----------------
    ("今年考研报名人数", "QC-NEWS", "BAR-01"),
    ("高校专业调整", "QC-NEWS", "BAR-01"),
    ("就业政策解读", "QC-NEWS", "BAR-01"),
    ("新能源车补贴政策", "QC-NEWS", "BAR-03"),
    ("燃油车降价消息", "QC-NEWS", "BAR-03"),
    ("智能驾驶新规", "QC-NEWS", "BAR-03"),
    ("摄影大赛征稿", "QC-NEWS", "BAR-02"),
    ("手机影像对比", "QC-NEWS", "BAR-02"),
    ("全民健身热潮", "QC-NEWS", "BAR-04"),
    ("马拉松赛事日历", "QC-NEWS", "BAR-04"),
    ("新款游戏发布", "QC-NEWS", "BAR-05"),
    ("游戏版号发放", "QC-NEWS", "BAR-05"),
    ("电竞比赛结果", "QC-NEWS", "BAR-05"),
    ("美食节活动", "QC-NEWS", "BAR-06"),
    ("预制菜新国标", "QC-NEWS", "BAR-06"),
    ("咖啡价格上涨", "QC-NEWS", "BAR-06"),
]

# 三层审核各自的拒绝原因字典
REVIEW_REJECT_REASONS = {
    "auto": [
        ("AUTO_TEXT_POLICY", "文本策略拦截", 0.30),
        ("AUTO_IMAGE_POLICY", "图像策略拦截", 0.26),
        ("AUTO_PORN", "低俗内容", 0.24),
        ("AUTO_DUPLICATE", "重复内容检测", 0.20),
    ],
    "manual": [
        ("MANUAL_LOW_QUALITY", "内容质量低", 0.42),
        ("MANUAL_OVERRIDE", "人工策略覆写", 0.24),
        ("MANUAL_BRAND_RISK", "品牌风险", 0.18),
        ("MANUAL_USER_REPORT", "用户举报", 0.16),
    ],
    "quality": [
        ("QUALITY_READABILITY", "可读性不足", 0.34),
        ("QUALITY_FACT_ERROR", "事实性错误", 0.27),
        ("QUALITY_NO_INCREMENT", "无信息增量", 0.22),
        ("QUALITY_LANGUAGE", "语言质量不合格", 0.17),
    ],
}

# 生成失败原因
FAILURE_REASONS = [
    ("MODEL_TIMEOUT", "模型推理超时", 0.34),
    ("MODEL_SERVICE_ERROR", "模型服务异常", 0.28),
    ("QUERY_REWRITE_FAIL", "Query 改写失败", 0.20),
    ("ASSET_EMPTY", "素材检索为空", 0.18),
]

# 调起贴吧失败原因
JUMP_FAIL_REASONS = [
    ("APP_NOT_INSTALLED", "未安装贴吧 App", 0.50),
    ("APP_VERSION_TOO_LOW", "App 版本过低", 0.18),
    ("NETWORK_FAIL", "网络失败", 0.18),
    ("USER_CANCEL", "用户取消", 0.14),
]

# 内容质量评测：维度顺序即前端展示顺序（与 config.ts 的 EVAL_DIMENSIONS 保持一致）
EVAL_DIMENSIONS = [
    "visual", "av_sync", "relevance", "material", "readability", "factuality",
]

EVAL_DIM_LABELS = {
    "visual": "画面质量",
    "av_sync": "声画一致性",
    "relevance": "内容-Query 符合度",
    "material": "图片素材质量",
    "readability": "文本可读性",
    "factuality": "事实性与合规",
}

# 评测维度低分原因（分 < 70 时抽 1 条写入 issues，用于下钻）
EVAL_ISSUE_REASONS = {
    "visual": [
        ("VIS_BLUR", "画面模糊 / 失焦", 0.30),
        ("VIS_JITTER", "运镜抖动 / 画面不稳", 0.24),
        ("VIS_FLASH", "频闪 / 曝光异常", 0.20),
        ("VIS_LIGHTING", "光线与色调偏暗", 0.26),
    ],
    "av_sync": [
        ("AV_LIP", "口播与口型不对齐", 0.32),
        ("AV_BGM", "背景音乐盖过人声", 0.22),
        ("AV_SUBTITLE", "字幕与画面错位", 0.24),
        ("AV_SILENCE", "音轨缺失或长时间无声", 0.22),
    ],
    "relevance": [
        ("REL_KEYWORD", "未覆盖 Query 核心问题", 0.34),
        ("REL_OFFTOPIC", "答非所问 / 话题偏移", 0.28),
        ("REL_SHALLOW", "只给结论不给方法", 0.22),
        ("REL_INTENT", "搜索意图理解偏差", 0.16),
    ],
    "material": [
        ("MAT_LOW_RES", "配图分辨率过低", 0.28),
        ("MAT_UNRELATED", "配图与正文无关", 0.26),
        ("MAT_REPEAT", "配图重复 / 素材雷同", 0.24),
        ("MAT_WATERMARK", "含水印或站外二维码", 0.22),
    ],
    "readability": [
        ("READ_TOO_LONG", "篇幅过长、重点不突出", 0.28),
        ("READ_TERM", "术语堆砌未做通俗解释", 0.26),
        ("READ_LIST", "行文冗长、句子不通顺", 0.24),
        ("READ_NO_STEP", "缺少可执行步骤", 0.22),
    ],
    "factuality": [
        ("FACT_ERROR", "数据 / 事实性错误", 0.34),
        ("FACT_HALLU", "疑似模型编造", 0.26),
        ("FACT_AD", "夹带推广与广告", 0.22),
        ("FACT_RISK", "存在合规风险表述", 0.18),
    ],
}

# 评测模型版本（用于看迭代效果）
EVAL_MODEL_VERSIONS = [("ev-v3.2", 0.72), ("ev-v3.4", 0.28)]

# 分发位次分档
SLOT_POSITIONS = [
    ("top", "前三位（1-3 位）"),
    ("middle", "中段位（4-8 位）"),
    ("bottom", "后段位（9 位及以后）"),
]

# ----------------------------------------------------------------------------
# 基础水位（正常情况下的各项概率）
# 原则：常态水位必须显著优于 THRESHOLDS 里的告警阈值，
#      只有注入窗口内的贴吧才越线，否则异常列表会被日常波动淹没。
#      生成失败率、审核拒绝率的日样本量都很小（贴吧·日 约 20~45 条生成任务、
#      20~30 条审核），二项噪声本身就能把成功率/通过率打到 90% 附近：
#      n=40、p=2.5% 时 P(X>=4 次失败) 已达 1.9%，360 个「贴吧·日」里必有若干条。
#      故基线失败率压到 0.8%（成功率 ~99.2%，阈值 90%），
#      此时 n=40 下 P(X>=5) < 1e-5，正常日的日间波动不会再触发 R1。
# ----------------------------------------------------------------------------
BASE_FAIL_RATE = 0.008          # 生成失败率基线（成功率 ~99.2%，阈值 90%）
BASE_IMG_MEDIAN_MS = 4200       # 图文帖生成耗时中位数（对数正态）
BASE_VIDEO_MEDIAN_MS = 11000    # 视频帖生成耗时中位数（对数正态）
DURATION_SIGMA = 0.30
REGEN_RATE = 0.025              # 成功任务的挑优重生成比例（产出 version=2）

STAGE_BASE = {
    # stage: (pending 概率, reject 概率, 平均审核耗时毫秒)
    # 「严格质量控制体系」下常态就有可观拒绝率，但均显著低于 R3 阈值 35%；
    # 逐层递减又保证 auto > manual > quality 的漏斗条数
    "auto": (0.005, 0.140, 1600),
    "manual": (0.005, 0.120, 32000),
    "quality": (0.005, 0.100, 52000),
}
RECENT_PENDING_RATE = 0.10      # 基准时刻前 36 小时内审核积压概率（模拟排队）
RECENT_WINDOW_H = 36
RECENT_TASK_PENDING_RATE = 0.10  # 基准时刻前 2 小时内仍在生成中的任务比例
RECENT_TASK_WINDOW_H = 2

DISTRIBUTE_RATE = 0.96          # 过审内容进入分发排期的比例（其余进入排期积压）
IMPRESSION_DAYS_WEIGHTS = [0.05, 0.10, 0.16, 0.24, 0.22, 0.23]   # 上线后持续曝光天数
IMPRESSION_SCALE = 0.083        # 单条分发·单日曝光量基数
# 常态 CTR 需明显高于 R5 阈值 6%，否则各吧会在无异常时也触发 R5。
# BASE_CTR 是「第 1 位」口径；曝光加权后的位次系数均值约 0.813，
# 故整体 CTR ≈ BASE_CTR × 0.813 ≈ 11.8%。
BASE_CTR = 0.145               # 搜索结果页 CTR 基线（第 1 位口径，实际再乘位次系数）
JUMP_TRIGGER_RATE = 0.86        # 一次点击触发一次贴吧调起尝试的比例
CAN_JUMP_RATE = 0.70            # 被点击内容中「可成功调起贴吧」的比例（装了 App）
JUMP_SUCCESS_RATE = 0.93        # 可调起内容发起的调起尝试成功率

# ----------------------------------------------------------------------------
# 内容质量评测基线
#   两处标定互相牵制，必须同时满足：
#   1) 维度不合格率（分 < 70）常态控制在 25%~45%——AIGC 批量生产里单维度不合格本就是常态，
#      因此 R6-1 只能在「贴吧·区间」粒度上判定（样本 200+，二项噪声仅 1.5%），
#      若按「贴吧·日」判定，每吧每天只有 20~45 条内容，噪声就能把比率打到阈值线上。
#   2) 综合分（6 维加权均值）的标准差会被平均压缩到约 5 分，
#      故维度标准差必须给到 11~14，综合分才会落在「优 4% / 良 84% / 中 12%」的可分析分布上；
#      若维度标准差压到 9 分，综合分方差过小，中档近乎为 0，档位分析就失去意义。
# ----------------------------------------------------------------------------
EVAL_DIM_BASE = {
    # dim: (图文帖均值, 视频帖均值, 标准差)
    "visual": (76.0, 75.0, 13.0),
    "av_sync": (0.0, 75.0, 14.0),      # 仅视频帖适用，图文帖均值位不用
    "relevance": (78.0, 78.0, 12.0),
    "material": (74.0, 73.0, 13.0),
    "readability": (77.0, 77.0, 12.0),
    "factuality": (79.0, 79.0, 11.0),
}
# 视频的画面分与声画分波动更大（拍摄 / 剪辑链路更长）
EVAL_VIDEO_SD_BOOST = {"visual": 2.0, "av_sync": 1.0}
# 各吧的整体质量水位差异（用于「各贴吧质量对比」有区分度）
EVAL_BAR_OFFSET = {
    "BAR-01": 1.5, "BAR-02": 0.5, "BAR-03": -1.0,
    "BAR-04": 0.5, "BAR-05": -1.5, "BAR-06": 0.0,
}
EVAL_COVERAGE = 0.985            # 全量评测覆盖率（其余为评测未回传）
HUMAN_REVIEW_RATE = 0.09         # 人审抽样复核比例
HUMAN_NOISE_SD = 4.0             # 人审复核相对自动分的修正噪声标准差
ISSUE_SCORE_LIMIT = 70           # 低于该分数视为低分维度，记录扣分原因
# 综合分 → 点击率的质量耦合：CTR 随质量单调上升，且在基线分处归一为 1.0，
# 因此只改变内容之间的分布、不改变大盘 CTR 水位。
QUALITY_CTR_SLOPE = 0.45
QUALITY_CTR_BASE = 77.0

# ----------------------------------------------------------------------------
# 注入的异常场景（硬编码时间窗口，窗口外水位正常）
# ----------------------------------------------------------------------------
SCEN01 = {  # 生成失败率飙升：模型推理超时
    "bar": "BAR-03", "start": "2026-10-06", "end": "2026-10-09",
    "fail_rate": 0.27, "timeout_weight": 0.82,
}
SCEN02 = {  # 视频帖生成变慢：图文帖不受影响
    "bar": "BAR-02", "start": "2026-10-11", "end": "2026-10-14",
    "video_mult": 3.4,
}
SCEN03 = {  # 人审拒绝率飙升（品牌风险），机审与质量审核不受影响
    "bar": "BAR-05", "start": "2026-10-12", "end": "2026-10-17",
    "manual_reject": 0.62, "brand_weight": 0.74,
}
SCEN04 = {  # Query 分类内容断供：教育考试类在考研吧
    # 窗口一直延续到数据最后一天，使 R4「从区间尾部往回」的检测口径能命中
    "bar": "BAR-01", "category": "QC-EDU",
    "start": "2026-10-16", "end": "2026-10-20", "keep_rate": 0.02,
}
SCEN05 = {  # CTR 与调起率双降：未安装贴吧 App
    "bar": "BAR-04", "start": "2026-10-09", "end": "2026-10-19",
    "ctr_keep": 0.22, "can_jump": 0.20,
}
SCEN06 = {  # 画面质量骤降：生成链路劣化，只有感官维度掉分，语义维度不受影响
    # 与 SCEN01（同为汽车吧）时间上完全错开，避免两条规则互相干扰
    "bar": "BAR-03", "start": "2026-10-13", "end": "2026-10-18",
    "visual_penalty": 22.0, "visual_sd_boost": 6.0,
}

# 各场景的对照基线窗口（窗口之前等长的天数），用于证据文案
BASELINE_WINDOW_DAYS = 7

# ----------------------------------------------------------------------------
# 工具函数
# ----------------------------------------------------------------------------


def ts(dt_obj: datetime) -> str:
    """时间戳统一格式 YYYY-MM-DDTHH:MM:SS（Asia/Shanghai 本地时间）"""
    return dt_obj.strftime(TS_FMT)


def day_str(dt_obj: datetime) -> str:
    return dt_obj.strftime(DAY_FMT)


def weighted_pick(options, weights):
    return rng.choices(options, weights=weights, k=1)[0]


def in_window(date_obj: datetime, spec) -> bool:
    return spec["start"] <= day_str(date_obj) <= spec["end"]


def clamp_dt(dt_obj: datetime) -> datetime:
    """保证事件时间不晚于基准时间"""
    if dt_obj >= BASELINE_TIME:
        return BASELINE_TIME - timedelta(seconds=rng.randint(1, 900))
    return dt_obj


# 一天 24 小时的采样权重
SEARCH_HOURS = list(range(24))
SEARCH_HOUR_WEIGHTS = [
    0.9, 0.6, 0.4, 0.3, 0.3, 0.5, 0.9, 1.5, 2.2, 2.8, 3.0, 2.9,
    2.4, 2.5, 2.7, 2.8, 2.7, 2.6, 2.7, 3.0, 3.3, 3.0, 2.2, 1.5,
]
# 批量生产以夜间批处理为主，白天也有在线补充
GEN_HOUR_WEIGHTS = [
    3.2, 3.0, 2.6, 2.2, 2.0, 2.2, 2.6, 3.0, 2.6, 2.2, 2.0, 1.9,
    1.8, 1.8, 1.9, 2.0, 2.1, 2.2, 2.2, 2.1, 2.0, 2.3, 2.7, 3.1,
]


def sample_time(date_obj: datetime, hour_weights) -> datetime:
    hour = weighted_pick(SEARCH_HOURS, hour_weights)
    return datetime(
        date_obj.year, date_obj.month, date_obj.day,
        hour, rng.randint(0, 59), rng.randint(0, 59),
    )


# ID 序列：宽度按「够用即止」设定，避免过长 ID 撑大 mock_events.json
seq = {"qe": 0, "gt": 0, "cd": 0, "rv": 0, "ev": 0, "dp": 0, "ck": 0, "jb": 0}
ID_WIDTH = {
    "qe": ("QE", 6), "gt": ("GT", 6), "cd": ("CD", 6),
    "rv": ("RV", 6), "ev": ("EV", 6), "dp": ("DP", 6),
    "ck": ("CK", 6), "jb": ("JB", 6),
}


def next_id(kind: str) -> str:
    seq[kind] += 1
    prefix, width = ID_WIDTH[kind]
    return f"{prefix}{seq[kind]:0{width}d}"


# 用户池：搜索与生产共用同一批匿名用户，用于产生跨贴吧重复用户
USER_POOL_SIZE = 4200


def sample_user() -> str:
    return f"U{rng.randint(1, USER_POOL_SIZE):05d}"


# 搜索结果页位次采样权重：前 8 位占大头，长尾到 20 位
RANK_CHOICES = list(range(1, 21))
RANK_WEIGHTS = [
    0.115, 0.105, 0.092, 0.078, 0.066, 0.058, 0.051, 0.045,
    0.040, 0.036, 0.032, 0.028, 0.025, 0.022, 0.020, 0.017,
    0.015, 0.013, 0.011, 0.011,
]


def rank_to_slot(rank: int) -> str:
    if rank <= 3:
        return "top"
    if rank <= 8:
        return "middle"
    return "bottom"


def rank_ctr_factor(rank: int) -> float:
    """位次越靠前，点击率越高；第 1 位为基准 1.0，第 20 位衰减到约 0.25。

    这是搜索结果页的经典位次衰减曲线，也是看板「位次 CTR 衰减」图的建模依据。
    """
    return 1.0 / (1.0 + 0.30 * (rank - 1)) ** 0.85


# ----------------------------------------------------------------------------
# 内容质量评测
# ----------------------------------------------------------------------------
# 评测用独立的随机流：新增评测维度不应改动既有生成 / 审核 / 分发 / 点击的数据，
# 否则场景证据与已固化的看板文案会被无关地推翻。
rng_eval = random.Random(SEED + 7717)

# 综合分权重，与前端 config.ts 的 DIMENSION_WEIGHTS 保持一致
EVAL_WEIGHTS = {
    "visual": 0.16, "av_sync": 0.14, "relevance": 0.24,
    "material": 0.12, "readability": 0.17, "factuality": 0.17,
}


def eval_applies(dim: str, content_type: str) -> bool:
    """声画一致性只对视频帖有意义；不适用的维度 scores 里不写该键。"""
    return content_type == "CT-VIDEO" if dim == "av_sync" else True


def overall_eval_score(scores: dict) -> float:
    """按维度权重算综合分；不适用的维度不参与，权重就地归一。"""
    num = sum(EVAL_WEIGHTS[d] * v for d, v in scores.items())
    den = sum(EVAL_WEIGHTS[d] for d in scores)
    return num / den if den > 0 else 0.0


# 分档阈值，与前端 config.ts 的 SCORE_GRADES 保持一致：优 >= 85，良 >= 70，中 >= 55，其余为差
GRADES = ["优", "良", "中", "差"]


def grade_of(score: float) -> int:
    if score >= 85:
        return 0
    if score >= 70:
        return 1
    if score >= 55:
        return 2
    return 3


def quality_ctr_factor(score: float) -> float:
    """质量 → 点击率的耦合系数。

    在基线分处归一为 1.0，因此只改变内容之间的点击率分布，不改变大盘 CTR 水位；
    综合分每高 20 分，CTR 上浮 45%（差档约打七折、优档约 1.2 倍）。
    """
    f = 1.0 + QUALITY_CTR_SLOPE * (score - QUALITY_CTR_BASE) / 20.0
    return max(0.45, min(1.75, f))


def weighted_pick_rng(r, options, weights):
    return r.choices(options, weights=weights, k=1)[0]


def eval_issue_reasons(dim: str) -> list:
    return [r[0] for r in EVAL_ISSUE_REASONS[dim]]


def eval_issue_weights(dim: str) -> list:
    return [r[2] for r in EVAL_ISSUE_REASONS[dim]]


def make_scores(content_type: str, bar_id: str, in_scen06: bool) -> dict:
    """生成一条内容在全部适用维度上的自动评测分。"""
    offset = EVAL_BAR_OFFSET.get(bar_id, 0.0)
    scores = {}
    for dim in EVAL_DIMENSIONS:
        if not eval_applies(dim, content_type):
            continue
        img_mu, video_mu, sd = EVAL_DIM_BASE[dim]
        mu = video_mu if content_type == "CT-VIDEO" else img_mu
        mu += offset
        cur_sd = sd + EVAL_VIDEO_SD_BOOST.get(dim, 0.0) if content_type == "CT-VIDEO" else sd
        # SCEN-06：画面质量骤降，同时波动放大，模拟生成 / 剪辑链路劣化
        if in_scen06 and dim == "visual":
            mu -= SCEN06["visual_penalty"]
            cur_sd += SCEN06["visual_sd_boost"]
        scores[dim] = int(max(1, min(100, round(rng_eval.gauss(mu, cur_sd)))))
    return scores


def make_issues(scores: dict) -> list:
    """低分维度记录扣分原因，供下钻定位。"""
    return [
        {"dim": d, "reason": weighted_pick_rng(rng_eval, eval_issue_reasons(d), eval_issue_weights(d))}
        for d in EVAL_DIMENSIONS
        if d in scores and scores[d] < ISSUE_SCORE_LIMIT
    ]


def make_eval(content_id, bar_id, query_id, content_type, eval_ts, in_scen06):
    """产出该内容的自动评测记录，以及可能存在的人审抽样复核记录。"""
    if rng_eval.random() > EVAL_COVERAGE:
        return None

    scores = make_scores(content_type, bar_id, in_scen06)
    if not scores:
        return None
    model_version = weighted_pick_rng(
        rng_eval, [v[0] for v in EVAL_MODEL_VERSIONS], [v[1] for v in EVAL_MODEL_VERSIONS]
    )
    auto = {
        "evalId": next_id("ev"), "contentId": content_id, "barId": bar_id,
        "queryId": query_id, "contentType": content_type, "ts": ts(eval_ts),
        "source": "auto", "scores": scores, "issues": make_issues(scores),
        "modelVersion": model_version,
    }
    content_score[content_id] = overall_eval_score(scores)

    if rng_eval.random() >= HUMAN_REVIEW_RATE:
        return auto

    # 人审复核：在自动分基础上做有偏修正，保留约 12% 的分档分歧
    human_scores = {
        d: int(max(1, min(100, round(v + rng_eval.gauss(-0.6, HUMAN_NOISE_SD)))))
        for d, v in scores.items()
    }
    human_ts = clamp_dt(eval_ts + timedelta(hours=rng_eval.randint(1, 30)))
    human = {
        "evalId": next_id("ev"), "contentId": content_id, "barId": bar_id,
        "queryId": query_id, "contentType": content_type, "ts": ts(human_ts),
        "source": "human", "scores": human_scores, "issues": make_issues(human_scores),
        "modelVersion": model_version,
    }
    return [auto, human]


# ----------------------------------------------------------------------------
# 生成 Query 维表与「贴吧 → Query 池」
# ----------------------------------------------------------------------------
queries = []
queries_of_bar = {b[0]: [] for b in BARS}

_qseq = 0
for cat_id, _cat_name in QUERY_CATEGORIES:
    items = [q for q in QUERY_TABLE if q[1] == cat_id]
    for i, (name, category, bar_id) in enumerate(items, start=1):
        _qseq += 1
        query_id = f"Q{_qseq:02d}"          # 全局自增，跨分类唯一
        queries.append({"id": query_id, "name": name, "category": category})
        # 热度权重用词表下标推算，保证确定且不引入额外随机源
        weight = 0.62 + ((i * 7) % 10) * 0.11
        queries_of_bar[bar_id].append((query_id, weight))

query_category_of = {q["id"]: q["category"] for q in queries}
# QUERY_TABLE 与 queries 同序，据此还原每个 Query 的归属贴吧（仅生成期使用）
bar_id_of_query = {
    queries[idx]["id"]: bar_id for idx, (_name, _category, bar_id) in enumerate(QUERY_TABLE)
}

# 每个贴吧的 Query 池与热度权重
query_pool = {bar_id: [qid for qid, _w in qs] for bar_id, qs in queries_of_bar.items()}
query_weights = {bar_id: [w for _qid, w in qs] for bar_id, qs in queries_of_bar.items()}

# ----------------------------------------------------------------------------
# 生成业务事件
# ----------------------------------------------------------------------------
query_events = []
generation_tasks = []
contents = []
reviews = []
evals = []
distributes = []
impression_stats = []
clicks = []
jump_backs = []

# 用于场景证据统计的索引：contentId -> 生成日 / 归属贴吧 / 意图分类
content_meta = {}
# contentId -> 综合质量分（自动评测口径），供点击派生时做质量耦合
content_score = {}

start_date = (BASELINE_TIME - timedelta(days=DAYS - 1)).replace(
    hour=0, minute=0, second=0, microsecond=0
)
end_date_str = day_str(BASELINE_TIME)

for day_offset in range(DAYS):
    date = start_date + timedelta(days=day_offset)
    day = day_str(date)
    is_weekend = date.weekday() >= 5
    # 全期缓慢增长 + 周末峰 + 日常噪声
    growth = 0.94 + 0.16 * (day_offset / max(1, DAYS - 1))
    week_factor = 1.32 if is_weekend else 1.0

    # ---------------- 搜索需求侧：用户在手百搜索了某个 Query ----------------
    for bar in BARS:
        bar_id = bar[0]
        q_volume = 0.52 * bar[5] * growth * week_factor * rng.uniform(0.88, 1.12)
        for _ in range(int(q_volume)):
            t = sample_time(date, SEARCH_HOUR_WEIGHTS)
            if t >= BASELINE_TIME:
                continue
            query_id = weighted_pick(query_pool[bar_id], query_weights[bar_id])
            query_events.append({
                "eventId": next_id("qe"),
                "ts": ts(t),
                "barId": bar_id,
                "queryId": query_id,
                "userId": sample_user(),
            })

    # ---------------- AIGC 生产：批量生成任务 + 内容 + 三层审核 + 分发 ----------------
    for bar in BARS:
        bar_id, _bar_name, _category, _tier, _opened, base_tasks, video_p = bar
        pool = query_pool[bar_id]
        pool_w = query_weights[bar_id]
        edu_idx = [i for i, qid in enumerate(pool) if query_category_of[qid] == "QC-EDU"]
        non_edu_idx = [i for i, qid in enumerate(pool) if query_category_of[qid] != "QC-EDU"]

        volume = base_tasks * growth * week_factor * rng.uniform(0.86, 1.14)
        in_scen01 = in_window(date, SCEN01) and bar_id == SCEN01["bar"]
        in_scen02 = in_window(date, SCEN02) and bar_id == SCEN02["bar"]
        in_scen03 = in_window(date, SCEN03) and bar_id == SCEN03["bar"]
        in_scen04 = in_window(date, SCEN04) and bar_id == SCEN04["bar"]
        in_scen06 = in_window(date, SCEN06) and bar_id == SCEN06["bar"]

        for _ in range(int(volume)):
            t = sample_time(date, GEN_HOUR_WEIGHTS)
            if t >= BASELINE_TIME:
                continue

            # ---- 选择 Query（SCEN-04：教育考试类断供）----
            if in_scen04 and non_edu_idx and rng.random() > SCEN04["keep_rate"]:
                pick_idx = rng.choice(non_edu_idx)
            else:
                pick_idx = rng.choices(range(len(pool)), weights=pool_w, k=1)[0]
            query_id = pool[pick_idx]

            content_type = "CT-VIDEO" if rng.random() < video_p else "CT-IMG"
            task_id = next_id("gt")
            user_id = sample_user()

            # ---- 生成中（pending）：只在基准时刻前两小时内出现 ----
            if (BASELINE_TIME - t) < timedelta(hours=RECENT_TASK_WINDOW_H) and rng.random() < RECENT_TASK_PENDING_RATE:
                generation_tasks.append({
                    "taskId": task_id, "ts": ts(t), "barId": bar_id, "queryId": query_id,
                    "contentType": content_type, "userId": user_id,
                    "status": "pending", "durationMs": None, "failureReason": None,
                })
                continue

            # ---- 生成成功 / 失败 ----
            fail_rate = SCEN01["fail_rate"] if in_scen01 else BASE_FAIL_RATE
            if rng.random() < fail_rate:
                if in_scen01:
                    fw = [SCEN01["timeout_weight"]] + [w * (1 - SCEN01["timeout_weight"]) for _id, _n, w in FAILURE_REASONS[1:]]
                else:
                    fw = [w for _id, _n, w in FAILURE_REASONS]
                reason = weighted_pick([r[0] for r in FAILURE_REASONS], fw)
                generation_tasks.append({
                    "taskId": task_id, "ts": ts(t), "barId": bar_id, "queryId": query_id,
                    "contentType": content_type, "userId": user_id,
                    "status": "failed", "durationMs": None, "failureReason": reason,
                })
                continue

            median = BASE_VIDEO_MEDIAN_MS if content_type == "CT-VIDEO" else BASE_IMG_MEDIAN_MS
            if in_scen02 and content_type == "CT-VIDEO":
                median *= SCEN02["video_mult"]
            duration_ms = int(min(300000, max(1200, rng.lognormvariate(math.log(median), DURATION_SIGMA))))
            generation_tasks.append({
                "taskId": task_id, "ts": ts(t), "barId": bar_id, "queryId": query_id,
                "contentType": content_type, "userId": user_id,
                "status": "success", "durationMs": duration_ms, "failureReason": None,
            })

            created = clamp_dt(t + timedelta(milliseconds=duration_ms))
            # 同一任务可能挑优重生成，产出第 2 个版本
            versions = [1, 2] if rng.random() < REGEN_RATE else [1]

            for version in versions:
                content_id = next_id("cd")
                content_ts = created if version == 1 else clamp_dt(
                    created + timedelta(minutes=rng.randint(20, 240))
                )
                contents.append({
                    "contentId": content_id, "taskId": task_id, "version": version,
                    "ts": ts(content_ts), "barId": bar_id, "queryId": query_id,
                    "contentType": content_type,
                })
                content_meta[content_id] = (day, bar_id, query_category_of[query_id], content_type)
                recent = (BASELINE_TIME - content_ts) < timedelta(hours=RECENT_WINDOW_H)

                # ================= 内容质量评测 =================
                # 评测紧跟生成发生（分钟级），因此归属到内容生成日，与审核 / 分发同口径。
                eval_ts = clamp_dt(content_ts + timedelta(minutes=rng_eval.randint(1, 45)))
                made = make_eval(content_id, bar_id, query_id, content_type, eval_ts, in_scen06)
                if made is not None:
                    evals.extend(made if isinstance(made, list) else [made])

                # ================= 三层串行审核 =================
                cursor = content_ts
                passed_all = True
                for stage in ("auto", "manual", "quality"):
                    pend_p, rej_p, base_cost = STAGE_BASE[stage]
                    if in_scen03 and stage == "manual":
                        rej_p = SCEN03["manual_reject"]
                    pend_p = RECENT_PENDING_RATE if recent else pend_p

                    cursor = clamp_dt(cursor + timedelta(seconds=rng.randint(10, 900)))
                    cost = None

                    if rng.random() < pend_p:
                        reviews.append({
                            "reviewId": next_id("rv"), "contentId": content_id, "stage": stage,
                            "ts": ts(cursor), "status": "pending", "rejectReason": None, "costMs": None,
                        })
                        passed_all = False
                        break

                    if stage == "auto":
                        delay_min = rng.randint(3, 180)
                    elif stage == "manual":
                        delay_min = rng.randint(20, 900)
                    else:
                        delay_min = rng.randint(10, 300)
                    cursor = clamp_dt(cursor + timedelta(minutes=delay_min))
                    cost = int(base_cost * rng.uniform(0.55, 1.6))

                    if rng.random() < rej_p:
                        dict_items = REVIEW_REJECT_REASONS[stage]
                        if in_scen03 and stage == "manual":
                            # 品牌风险占比抬升，其余原因按原权重等比缩小
                            lookup = {x[0]: x for x in dict_items}
                            reason = weighted_pick(
                                [x[0] for x in dict_items],
                                [
                                    SCEN03["brand_weight"] if x[0] == "MANUAL_BRAND_RISK"
                                    else x[2] * (1 - SCEN03["brand_weight"])
                                    for x in dict_items
                                ],
                            )
                        else:
                            reason = weighted_pick(
                                [x[0] for x in dict_items], [x[2] for x in dict_items]
                            )
                        reviews.append({
                            "reviewId": next_id("rv"), "contentId": content_id, "stage": stage,
                            "ts": ts(cursor), "status": "reject", "rejectReason": reason, "costMs": cost,
                        })
                        passed_all = False
                        break

                    reviews.append({
                        "reviewId": next_id("rv"), "contentId": content_id, "stage": stage,
                        "ts": ts(cursor), "status": "pass", "rejectReason": None, "costMs": cost,
                    })

                if not passed_all:
                    continue

                # ================= 分发到手百搜索结果页 =================
                if rng.random() > DISTRIBUTE_RATE:
                    continue

                dist_ts = clamp_dt(cursor + timedelta(minutes=rng.randint(5, 600)))
                dist_id = next_id("dp")
                rank = weighted_pick(RANK_CHOICES, RANK_WEIGHTS)
                distributes.append({
                    "distributeId": dist_id, "contentId": content_id, "ts": ts(dist_ts),
                    "barId": bar_id, "queryId": query_id,
                    "rankInPage": rank, "slot": rank_to_slot(rank),
                })

                # ================= 曝光（按 内容 × 分发 × 日 × 位次 聚合）=================
                heat = rng.lognormvariate(0.0, 1.0)          # 单条内容的热度，长尾分布
                impr_factor = 0.40 + 0.70 * heat
                n_days = weighted_pick([1, 2, 3, 4, 5, 6], IMPRESSION_DAYS_WEIGHTS)
                cur_rank = rank
                imp_days = []                              # [(曝光日, 曝光量, 当日位次)]
                for k in range(n_days):
                    imp_day = clamp_dt(dist_ts + timedelta(days=k)).date()
                    if day_str(imp_day) > end_date_str:
                        break
                    # 次日自然重排，位次会小幅变化
                    cur_rank = min(20, max(1, cur_rank + rng.choice([-1, -1, 0, 0, 0, 1])))
                    rank_decay = 200.0 / (1.0 + 0.5 * (cur_rank - 1)) ** 1.5
                    day_factor = 1.0 if k == 0 else (0.92 ** (k - 1))
                    impressions = max(1, int(
                        rank_decay * IMPRESSION_SCALE * impr_factor * day_factor * rng.uniform(0.7, 1.35)
                    ))
                    impression_stats.append({
                        "distributeId": dist_id, "contentId": content_id,
                        "day": day_str(imp_day), "rankInPage": cur_rank, "impressions": impressions,
                    })
                    imp_days.append((imp_day, impressions, cur_rank))

                # ================= 点击（逐条）=================
                # 点击数由当日曝光量派生，而不是独立抽样：
                #   当日点击数 ≈ 当日曝光量 × BASE_CTR × 位次系数 × 随机抖动
                # 点击时刻直接落在该曝光日当天，因此任意时间切片下的 CTR 都是稳定量，
                # 不会因为「曝光跨 6 天、点击只跨 2 天」而系统性塌陷。
                for imp_day, impressions, imp_rank in imp_days:
                    # SCEN-05：窗口内该吧在结果页的可点击性整体变差
                    ctr_today = BASE_CTR * rank_ctr_factor(imp_rank) * rng.uniform(0.8, 1.25)
                    # 质量耦合：内容综合分越高，同样的曝光越容易被点击
                    ctr_today *= quality_ctr_factor(content_score.get(content_id, QUALITY_CTR_BASE))
                    if bar_id == SCEN05["bar"] and day_str(imp_day) >= SCEN05["start"] \
                            and day_str(imp_day) <= SCEN05["end"]:
                        ctr_today *= SCEN05["ctr_keep"]
                    n_clicks = int(impressions * ctr_today)
                    for _c in range(n_clicks):
                        click_ts = datetime(
                            imp_day.year, imp_day.month, imp_day.day,
                            rng.randint(0, 23), rng.randint(0, 59), rng.randint(0, 59),
                        )
                        if click_ts >= BASELINE_TIME:
                            continue
                        clicks.append({
                            "eventId": next_id("ck"), "ts": ts(click_ts), "distributeId": dist_id,
                            "contentId": content_id, "barId": bar_id, "queryId": query_id,
                        })

                        # ================= 调起贴吧（逐条）=================
                        if rng.random() >= JUMP_TRIGGER_RATE:
                            continue
                        jump_ts = click_ts + timedelta(seconds=rng.randint(1, 180))
                        # 调起侧劣化同样按点击时刻判定：装机量是用户侧属性，
                        # 窗口内用户手百内贴吧入口曝光异常
                        in_scen05_jump = bar_id == SCEN05["bar"] and day_str(click_ts) >= SCEN05["start"] \
                            and day_str(click_ts) <= SCEN05["end"]
                        can_jump_rate = SCEN05["can_jump"] if in_scen05_jump else CAN_JUMP_RATE
                        if rng.random() < can_jump_rate:
                            ok = rng.random() < JUMP_SUCCESS_RATE
                            fail_reason = None if ok else weighted_pick(
                                ["NETWORK_FAIL", "USER_CANCEL"], [0.55, 0.45]
                            )
                        else:
                            ok = False
                            fail_reason = weighted_pick(
                                ["APP_NOT_INSTALLED", "APP_VERSION_TOO_LOW"], [0.74, 0.26]
                            )
                        jump_backs.append({
                            "eventId": next_id("jb"), "ts": ts(jump_ts), "contentId": content_id,
                            "barId": bar_id, "queryId": query_id,
                            "status": "success" if ok else "failed", "failReason": fail_reason,
                        })

# ----------------------------------------------------------------------------
# 异常场景证据（从已生成数据实测，用于 meta.anomalyScenarios 文案）
# ----------------------------------------------------------------------------


def prev_window_dates(spec):
    """返回异常窗口之前等长的基线日期列表"""
    start = datetime.strptime(spec["start"], DAY_FMT)
    n = (datetime.strptime(spec["end"], DAY_FMT) - start).days + 1
    return [day_str(start - timedelta(days=BASELINE_WINDOW_DAYS - i)) for i in range(n)]


def fmt_pct(v):
    return f"{v * 100:.1f}%"


def fmt_sec(ms):
    return f"{ms / 1000:.1f}s"


def pct_safe(num, den):
    return num / den if den else 0.0


# ---- SCEN-01：生成失败率飙升 ----
_w = [SCEN01["start"], SCEN01["end"]]
_b = prev_window_dates(SCEN01)


def _task_stats(days):
    rows = [
        t for t in generation_tasks
        if t["barId"] == SCEN01["bar"] and day_str(datetime.strptime(t["ts"][:10], DAY_FMT)) in days
        and t["status"] in ("success", "failed")
    ]
    failed = [t for t in rows if t["status"] == "failed"]
    return rows, failed


_rows_w, _fail_w = _task_stats(_w)
_rows_b, _fail_b = _task_stats(_b)
_timeout_w = sum(1 for t in _fail_w if t["failureReason"] == "MODEL_TIMEOUT")
_ev01 = (
    f"{SCEN01['start']} ~ {SCEN01['end']} 期间，{SCEN01['bar']} 已完成生成尝试 {len(_rows_w)} 次，"
    f"失败 {len(_fail_w)} 次，失败率 {fmt_pct(pct_safe(len(_fail_w), len(_rows_w)))}"
    f"（前 {BASELINE_WINDOW_DAYS} 天同贴吧为 {fmt_pct(pct_safe(len(_fail_b), len(_rows_b)))}）；"
    f"失败原因中「模型推理超时」占 {fmt_pct(pct_safe(_timeout_w, len(_fail_w)))}。"
)

# ---- SCEN-02：视频帖生成变慢 ----
_w = [SCEN02["start"], SCEN02["end"]]
_b = prev_window_dates(SCEN02)


def _dur_stats(days, ctype):
    vals = [
        t["durationMs"] for t in generation_tasks
        if t["barId"] == SCEN02["bar"] and t["status"] == "success"
        and t["contentType"] == ctype and t["durationMs"] is not None
        and t["ts"][:10] in days
    ]
    return (sum(vals) / len(vals)) if vals else 0.0, len(vals)


_v_w, _vn_w = _dur_stats(_w, "CT-VIDEO")
_v_b, _vn_b = _dur_stats(_b, "CT-VIDEO")
_i_w, _in_w = _dur_stats(_w, "CT-IMG")
_i_b, _in_b = _dur_stats(_b, "CT-IMG")
_ev02 = (
    f"{SCEN02['start']} ~ {SCEN02['end']} 期间，{SCEN02['bar']} 视频帖成功任务 {_vn_w} 条，"
    f"平均生成耗时 {fmt_sec(_v_w)}（前 {BASELINE_WINDOW_DAYS} 天为 {fmt_sec(_v_b)}）；"
    f"同期图文帖 {_in_w} 条，平均耗时 {fmt_sec(_i_w)}（前值 {fmt_sec(_i_b)}），基本未受影响。"
)

# ---- SCEN-03：人审拒绝率飙升 ----
_w = [SCEN03["start"], SCEN03["end"]]
_b = prev_window_dates(SCEN03)
_cid_meta = content_meta


def _stage_stats(days, stage):
    reviewed = rejected = 0
    reasons = []
    for rv in reviews:
        if rv["stage"] != stage or rv["status"] == "pending":
            continue
        meta = _cid_meta.get(rv["contentId"])
        if meta is None or meta[0] not in days or meta[1] != SCEN03["bar"]:
            continue
        reviewed += 1
        if rv["status"] == "reject":
            rejected += 1
            reasons.append(rv["rejectReason"])
    return reviewed, rejected, reasons


_m_rev_w, _m_rej_w, _m_reasons_w = _stage_stats(_w, "manual")
_m_rev_b, _m_rej_b, _ = _stage_stats(_b, "manual")
_a_rev_w, _a_rej_w, _ = _stage_stats(_w, "auto")
_a_rev_b, _a_rej_b, _ = _stage_stats(_b, "auto")
_q_rev_w, _q_rej_w, _ = _stage_stats(_w, "quality")
_q_rev_b, _q_rej_b, _ = _stage_stats(_b, "quality")
_brand_w = sum(1 for r in _m_reasons_w if r == "MANUAL_BRAND_RISK")
_ev03 = (
    f"{SCEN03['start']} ~ {SCEN03['end']} 期间，{SCEN03['bar']} 人审已审 {_m_rev_w} 条，"
    f"通过率 {fmt_pct(1 - pct_safe(_m_rej_w, _m_rev_w))}，拒绝率 {fmt_pct(pct_safe(_m_rej_w, _m_rev_w))}"
    f"（前 {BASELINE_WINDOW_DAYS} 天通过率 {fmt_pct(1 - pct_safe(_m_rej_b, _m_rev_b))}）；"
    f"人审拒绝原因中「品牌风险」占 {fmt_pct(pct_safe(_brand_w, _m_rej_w))}。"
    f"同期机审拒绝率 {fmt_pct(pct_safe(_a_rej_w, _a_rev_w))}（前值 {fmt_pct(pct_safe(_a_rej_b, _a_rev_b))}）、"
    f"质量审核拒绝率 {fmt_pct(pct_safe(_q_rej_w, _q_rev_w))}（前值 {fmt_pct(pct_safe(_q_rej_b, _q_rev_b))}），"
    f"均无明显变化，可定位问题出在人审环节。"
)

# ---- SCEN-04：Query 分类内容断供 ----
_w = [SCEN04["start"], SCEN04["end"]]
_b = prev_window_dates(SCEN04)
_content_days = {}
for c in contents:
    meta = content_meta[c["contentId"]]
    if meta[1] == SCEN04["bar"] and meta[2] == SCEN04["category"]:
        _content_days[c["ts"][:10]] = _content_days.get(c["ts"][:10], 0) + 1
_w_counts = [_content_days.get(d, 0) for d in _w]
_b_counts = [_content_days.get(d, 0) for d in _b]
_ev04 = (
    f"{SCEN04['start']} ~ {SCEN04['end']} 期间，{SCEN04['bar']} 上「教育考试类」Query 的日均内容产出 "
    f"{sum(_w_counts) / len(_w_counts):.1f} 条（逐日 {', '.join(str(x) for x in _w_counts)}）；"
    f"断供前 {BASELINE_WINDOW_DAYS} 天日均 {sum(_b_counts) / len(_b_counts):.1f} 条，骤降至不足 3 条/天，"
    f"构成连续 {len(_w)} 天的分类级内容断供。"
)

# ---- SCEN-05：CTR 与调起率双降 ----
# 统计口径与前端 metrics.ts 保持一致：
#   搜索结果页 CTR = 区间内点击事件数 / 区间内曝光量
#   调起成功率     = 区间内成功调起次数 / 区间内调起次数
def _ctr_stats(lo, hi):
    days = set()
    d0 = datetime.strptime(lo, DAY_FMT)
    d1 = datetime.strptime(hi, DAY_FMT)
    while d0 <= d1:
        days.add(day_str(d0))
        d0 += timedelta(days=1)
    bar_of_dist = {d["distributeId"]: d["barId"] for d in distributes}
    imps = sum(
        s["impressions"] for s in impression_stats
        if s["day"] in days and bar_of_dist.get(s["distributeId"]) == SCEN05["bar"]
    )
    cks = sum(1 for c in clicks if c["barId"] == SCEN05["bar"] and c["ts"][:10] in days)
    jumps = [j for j in jump_backs if j["barId"] == SCEN05["bar"] and j["ts"][:10] in days]
    ok = sum(1 for j in jumps if j["status"] == "success")
    fail_reasons = [j["failReason"] for j in jumps if j["status"] == "failed"]
    noapp = sum(1 for r in fail_reasons if r == "APP_NOT_INSTALLED")
    return imps, pct_safe(cks, imps), len(jumps), pct_safe(ok, len(jumps)), pct_safe(noapp, len(fail_reasons))


_w_start, _w_end = SCEN05["start"], SCEN05["end"]
_w_span = (datetime.strptime(_w_end, DAY_FMT) - datetime.strptime(_w_start, DAY_FMT)).days + 1
_b_start = day_str(datetime.strptime(_w_start, DAY_FMT) - timedelta(days=_w_span))
_b_end = day_str(datetime.strptime(_w_start, DAY_FMT) - timedelta(days=1))
_impr_w, _ctr_w, _j_w, _jsr_w, _na_w = _ctr_stats(_w_start, _w_end)
_impr_b, _ctr_b, _j_wb, _jsr_b, _na_b = _ctr_stats(_b_start, _b_end)
_ev05 = (
    f"{_w_start} ~ {_w_end} 期间，{SCEN05['bar']} 在手百搜索结果页曝光 {_impr_w} 次，"
    f"CTR {fmt_pct(_ctr_w)}（同长度的前 {_w_span} 天 {_b_start} ~ {_b_end} 为 {fmt_pct(_ctr_b)}）；"
    f"同期调起尝试 {_j_w} 次，成功率 {fmt_pct(_jsr_w)}（前值 {fmt_pct(_jsr_b)}）；"
    f"调起失败原因中「未安装贴吧 App」占 {fmt_pct(_na_w)}（前值 {fmt_pct(_na_b)}）。"
)

# ---- SCEN-06：画面质量骤降 ----
# 统计口径与前端 metrics.ts 保持一致：
#   维度不合格率 = 该维度打分 < 70 的内容数 / 该维度被打分的内容数（分档「中」及以下）
def _eval_stats(lo, hi):
    days = set()
    d0 = datetime.strptime(lo, DAY_FMT)
    d1 = datetime.strptime(hi, DAY_FMT)
    while d0 <= d1:
        days.add(day_str(d0))
        d0 += timedelta(days=1)
    scored = 0
    total = 0
    low = 0
    for e in evals:
        if e["source"] != "auto" or e["barId"] != SCEN06["bar"]:
            continue
        meta_row = content_meta.get(e["contentId"])
        if not meta_row or meta_row[0] not in days:
            continue
        s = e["scores"].get("visual")
        if s is None:
            continue
        scored += 1
        total += s
        if s < ISSUE_SCORE_LIMIT:
            low += 1
    return scored, (total / scored if scored else 0.0), pct_safe(low, scored)


_w_start, _w_end = SCEN06["start"], SCEN06["end"]
_w_span = (datetime.strptime(_w_end, DAY_FMT) - datetime.strptime(_w_start, DAY_FMT)).days + 1
_b_start = day_str(datetime.strptime(_w_start, DAY_FMT) - timedelta(days=_w_span))
_b_end = day_str(datetime.strptime(_w_start, DAY_FMT) - timedelta(days=1))
_n_w, _mu_w, _fail_w = _eval_stats(_w_start, _w_end)
_n_b, _mu_b, _fail_b = _eval_stats(_b_start, _b_end)
_ev06 = (
    f"{_w_start} ~ {_w_end} 期间，{SCEN06['bar']} 共评测 {_n_w} 条内容，画面质量均分 "
    f"{_mu_w:.1f} 分、不合格率 {fmt_pct(_fail_w)}（同长度的前 {_w_span} 天 {_b_start} ~ {_b_end} 为 "
    f"{_mu_b:.1f} 分 / {fmt_pct(_fail_b)}），仅感官维度掉分，语义类维度基本未变。"
)

ANOMALY_SCENARIOS = [
    {
        "id": "SCEN-01",
        "name": "生成失败率飙升（模型推理超时）",
        "barId": SCEN01["bar"],
        "queryCategory": None,
        "window": [SCEN01["start"], SCEN01["end"]],
        "evidence": _ev01,
    },
    {
        "id": "SCEN-02",
        "name": "视频帖生成耗时异常变慢（图文帖不受影响）",
        "barId": SCEN02["bar"],
        "queryCategory": None,
        "window": [SCEN02["start"], SCEN02["end"]],
        "evidence": _ev02,
    },
    {
        "id": "SCEN-03",
        "name": "人审拒绝率飙升（集中于品牌风险，机审与质量审核正常）",
        "barId": SCEN03["bar"],
        "queryCategory": None,
        "window": [SCEN03["start"], SCEN03["end"]],
        "evidence": _ev03,
    },
    {
        "id": "SCEN-04",
        "name": "Query 分类内容断供（教育考试类 · 考研吧）",
        "barId": SCEN04["bar"],
        "queryCategory": SCEN04["category"],
        "window": [SCEN04["start"], SCEN04["end"]],
        "evidence": _ev04,
    },
    {
        "id": "SCEN-05",
        "name": "搜索结果 CTR 与调起成功率双降（未安装贴吧 App）",
        "barId": SCEN05["bar"],
        "queryCategory": None,
        "window": [SCEN05["start"], SCEN05["end"]],
        "evidence": _ev05,
    },
    {
        "id": "SCEN-06",
        "name": "画面质量骤降（语义类维度不受影响）",
        "barId": SCEN06["bar"],
        "queryCategory": None,
        "window": [SCEN06["start"], SCEN06["end"]],
        "evidence": _ev06,
    },
]

# ----------------------------------------------------------------------------
# 组装输出
# ----------------------------------------------------------------------------
bars_json = [
    {
        "id": b[0], "name": b[1], "category": b[2], "tier": b[3], "openedAt": b[4],
    }
    for b in BARS
]

events = {
    "queryEvents": query_events,
    "generationTasks": generation_tasks,
    "contents": contents,
    "reviews": reviews,
    "evals": evals,
    "distributes": distributes,
    "impressionStats": impression_stats,
    "clicks": clicks,
    "jumpBacks": jump_backs,
}

stage_counts = {s: 0 for s in ("auto", "manual", "quality")}
for rv in reviews:
    stage_counts[rv["stage"]] += 1

_total_impressions = sum(s["impressions"] for s in impression_stats)
_jump_ok = sum(1 for j in jump_backs if j["status"] == "success")

meta = {
    "datasetName": "贴吧 AIGC 内容增长模拟数据",
    "seed": SEED,
    "timezone": "Asia/Shanghai (UTC+8)",
    "baselineTime": ts(BASELINE_TIME),
    "dataUpdateTime": ts(BASELINE_TIME),
    "businessDays": DAYS,
    "startDate": day_str(start_date),
    "endDate": end_date_str,
    "counts": {
        "bars": len(bars_json),
        "queries": len(queries),
        "queryEvents": len(query_events),
        "generationTasks": len(generation_tasks),
        "contents": len(contents),
        "reviews": len(reviews),
        "reviewsAuto": stage_counts["auto"],
        "reviewsManual": stage_counts["manual"],
        "reviewsQuality": stage_counts["quality"],
        "evals": len(evals),
        "evalsAuto": sum(1 for e in evals if e["source"] == "auto"),
        "evalsHuman": sum(1 for e in evals if e["source"] == "human"),
        "distributes": len(distributes),
        "impressionStats": len(impression_stats),
        "impressions": _total_impressions,
        "clicks": len(clicks),
        "jumpBacks": len(jump_backs),
    },
    "dictionaries": {
        "queryCategories": [{"id": cid, "name": cname} for cid, cname in QUERY_CATEGORIES],
        "contentTypes": [{"id": cid, "name": cname} for cid, cname in CONTENT_TYPES],
        "reviewStages": [
            {"id": "auto", "name": "机审"},
            {"id": "manual", "name": "人审"},
            {"id": "quality", "name": "质量审核"},
        ],
        "reviewRejectReasons": {
            stage: [{"id": rid, "name": rname} for rid, rname, _w in items]
            for stage, items in REVIEW_REJECT_REASONS.items()
        },
        "failureReasons": [{"id": rid, "name": rname} for rid, rname, _w in FAILURE_REASONS],
        "jumpFailReasons": [{"id": rid, "name": rname} for rid, rname, _w in JUMP_FAIL_REASONS],
        "evalDimensions": [
            {"id": did, "name": EVAL_DIM_LABELS[did]} for did in EVAL_DIMENSIONS
        ],
        "evalSources": [
            {"id": "auto", "name": "评测模型（全量）"},
            {"id": "human", "name": "人工复核（抽样）"},
        ],
        "evalIssueReasons": {
            dim: [{"id": rid, "name": rname} for rid, rname, _w in items]
            for dim, items in EVAL_ISSUE_REASONS.items()
        },
        "slotPositions": [{"id": sid, "name": sname} for sid, sname in SLOT_POSITIONS],
    },
    "anomalyScenarios": ANOMALY_SCENARIOS,
    "notes": [
        "全部为模拟数据，不含任何真实用户隐私信息，用户 ID 仅为匿名编号。",
        f"固定随机种子 {SEED}，多次运行脚本产出字节级完全一致，可用于测试与文档引用。",
        "所有时间戳为 Asia/Shanghai（UTC+8）本地时间，格式 YYYY-MM-DDTHH:MM:SS，前端按 +08:00 解析。",
        "基准日为部分数据：仅统计到 baselineTime 之前的事件，故当日量级低于历史完整日。",
        "三层审核串行：进入某环节才在该环节留一条记录，因此 auto / manual / quality 条数依次递减；"
        "三层全 pass 且进入分发排期的内容才会产生 distribute 及其下游曝光 / 点击 / 调起。",
        "曝光为按「内容 × 分发 × 日 × 位次」聚合计数，非逐条曝光事件；"
        "点击与调起为逐条事件，内容级去重指标以 contentId 为准。",
        "pending 状态（生成中 / 待审核）不计入成功率与通过率的分母，用于呈现审核与生成积压。",
        "内容质量评测：评测模型对全量内容自动打分（source=auto），另有约 9% 的内容被人工抽样复核"
        "（source=human），二者可算出分档一致率；一条评测记录含该来源下的全部适用维度分，"
        "声画一致性仅对视频帖打分，图文帖的 scores 里不写该键。",
        "评测使用独立随机流生成，不影响生成 / 审核 / 分发 / 曝光 / 点击 / 调起的既有数据分布。",
        "异常场景由硬编码时间窗口注入，证据文案中的数值为脚本按生成结果实测后写入，可与原始事件逐条核对。",
        "局限：Query 与贴吧的归属关系不在维表中落库，仅在生成阶段保证业务合理性；"
        "曝光量为聚合值，无法还原到单次曝光，位次日间波动为模拟重排而非真实排名波动。",
    ],
}

# ----------------------------------------------------------------------------
# 写出文件
# ----------------------------------------------------------------------------
os.makedirs(OUT_DIR, exist_ok=True)

for name, payload in [
    ("mock_bars.json", bars_json),
    ("mock_queries.json", queries),
    ("mock_events.json", events),
    ("mock_meta.json", meta),
]:
    path = os.path.join(OUT_DIR, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"written: {path}  ({os.path.getsize(path) / 1024 / 1024:.2f} MB)")

print("\n=== 汇总 ===")
print(json.dumps(meta["counts"], ensure_ascii=False, indent=2))
print("\n=== 调起成功率 ===")
print(f"{pct_safe(_jump_ok, len(jump_backs)):.3f}")

# ---- 评测统计（标定看板与异常规则时的人工核对依据）----
_auto = [e for e in evals if e["source"] == "auto"]
_by_content = {}
for e in _auto:
    _by_content[e["contentId"]] = e
_grades = [grade_of(overall_eval_score(e["scores"])) for e in _auto]
print("\n=== 评测统计 ===")
print(f"自动评测覆盖内容数 : {len(_auto)}")
print(f"综合分均值         : {sum(overall_eval_score(e['scores']) for e in _auto) / len(_auto):.1f}")
print("分档分布           : " + "  ".join(
    f"{GRADES[i]}{sum(1 for g in _grades if g == i)}" for i in range(4)
))
for dim in EVAL_DIMENSIONS:
    ss = [e["scores"][dim] for e in _auto if dim in e["scores"]]
    if not ss:
        continue
    lo = sum(1 for v in ss if v < ISSUE_SCORE_LIMIT)
    print(f"  {EVAL_DIM_LABELS[dim]:<12} n={len(ss):<6} 均分 {sum(ss)/len(ss):5.1f}  不合格率 {lo/len(ss):6.1%}")

_paired = {}
for e in evals:
    if e["source"] == "human":
        _paired[e["contentId"]] = e
_agree = []
for cid, he in _paired.items():
    ae = _by_content.get(cid)
    if not ae:
        continue
    _agree.append(grade_of(overall_eval_score(ae["scores"])) == grade_of(overall_eval_score(he["scores"])))
print(f"人机一致率         : {len(_agree)} 对样本, {sum(_agree)/len(_agree):.1%}")