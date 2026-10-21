import { AlertTriangle, CalendarDays, MessageSquareText, RefreshCw } from 'lucide-react';
import type { Bar, ContentType, DateRange, Meta } from '../types';
import { RANGE_PRESETS, type RangePresetKey } from '../lib/config';
import { diffDays } from '../lib/time';

export interface FilterBarProps {
  meta: Meta;
  preset: RangePresetKey | 'custom';
  onPreset: (p: RangePresetKey | 'custom') => void;
  range: DateRange;
  onRangeChange: (r: DateRange) => void;
  barId: string;
  onBarChange: (s: string) => void;
  bars: Bar[];
  contentType: string;
  onContentTypeChange: (s: string) => void;
  contentTypes: ContentType[];
  onReset: () => void;
  hitRecords: number;
}

export default function FilterBar({
  meta,
  preset,
  onPreset,
  range,
  onRangeChange,
  barId,
  onBarChange,
  bars,
  contentType,
  onContentTypeChange,
  contentTypes,
  onReset,
  hitRecords,
}: FilterBarProps) {
  const days = diffDays(range.startDate, range.endDate) + 1;
  const invalidRange = range.startDate > range.endDate;
  const outOfRange = range.endDate < meta.startDate || range.startDate > meta.endDate;

  return (
    <div className="filter-bar">
      <div className="filter-row">
        <div className="filter-group">
          <span className="filter-label">
            <CalendarDays size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
            日期范围
          </span>
          <div className="segmented">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.key}
                className={preset === p.key ? 'active' : ''}
                onClick={() => onPreset(p.key)}
              >
                {p.label}
              </button>
            ))}
            <button className={preset === 'custom' ? 'active' : ''} onClick={() => onPreset('custom')}>
              自定义
            </button>
          </div>
          {preset === 'custom' ? (
            <div className="filter-group">
              <input
                className="date-input"
                type="date"
                value={range.startDate}
                onChange={(e) => onRangeChange({ ...range, startDate: e.target.value })}
              />
              <span style={{ color: 'var(--c-text-weak)' }}>至</span>
              <input
                className="date-input"
                type="date"
                value={range.endDate}
                onChange={(e) => onRangeChange({ ...range, endDate: e.target.value })}
              />
            </div>
          ) : (
            <span style={{ color: 'var(--c-text-sub)', fontSize: 12.5 }}>
              {range.startDate} ~ {range.endDate}
            </span>
          )}
        </div>

        <div className="filter-group">
          <span className="filter-label">
            <MessageSquareText size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
            贴吧
          </span>
          <select className="select-input" value={barId} onChange={(e) => onBarChange(e.target.value)}>
            <option value="ALL">全部贴吧（{bars.length}）</option>
            {bars.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <span className="filter-label">内容类型</span>
          <select
            className="select-input"
            value={contentType}
            onChange={(e) => onContentTypeChange(e.target.value)}
          >
            <option value="ALL">全部内容类型</option>
            {contentTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <button className="btn" onClick={onReset}>
            <RefreshCw size={13} /> 重置筛选
          </button>
        </div>
      </div>

      <div className="filter-summary">
        <span>
          统计区间：<strong>{range.startDate} ~ {range.endDate}</strong>（{days} 天）
        </span>
        <span>
          贴吧范围：<strong>{barId === 'ALL' ? '全部贴吧' : (bars.find((b) => b.id === barId)?.name ?? barId)}</strong>
        </span>
        <span>
          内容类型：<strong>{contentType === 'ALL' ? '全部' : (contentTypes.find((t) => t.id === contentType)?.name ?? contentType)}</strong>
        </span>
        <span>
          命中事件记录：<strong>{hitRecords.toLocaleString('zh-CN')}</strong> 条
        </span>
        <span>
          数据基准时间：<strong>{meta.baselineTime.replace('T', ' ')}</strong>
        </span>
      </div>

      {invalidRange ? (
        <div className="callout" style={{ marginTop: 10 }}>
          <AlertTriangle size={14} />
          <span>
            起始日期（{range.startDate}）晚于结束日期（{range.endDate}），该区间不含任何数据，
            所有指标将显示为 <strong>—</strong>。请调整日期。
          </span>
        </div>
      ) : outOfRange ? (
        <div className="callout" style={{ marginTop: 10 }}>
          <AlertTriangle size={14} />
          <span>
            所选区间超出模拟数据范围（{meta.startDate} ~ {meta.endDate}），区间内没有记录，
            页面将展示空状态。请调整日期。
          </span>
        </div>
      ) : null}
    </div>
  );
}
