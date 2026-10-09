// @vitest-environment jsdom
/**
 * R15 / 候选契约 §1：全端展示时间一律北京时间（Asia/Shanghai, UTC+8），与设备时区无关。
 * 固定 unix 秒夹具（经 `date -u` 核验）证明跨北京午夜分桶、格式确定性与非法输入防御；
 * 末条用视图消费点证明"口径已接入"而不是"工具函数孤悬"。
 */
import { describe, expect, it } from 'vitest';
import {
  BEIJING_UTC_OFFSET_SECONDS,
  beijingClock,
  formatBeijingClockMs,
  formatBeijingDate,
  formatBeijingDateTime,
  formatBeijingDateTimeFull
} from '../../src/core/time-format';
import { formatExpiry } from '../../src/views/settings-copy';

// 2026-10-09T16:00:00Z = 北京 2026-10-10 00:00 —— 刚跨北京午夜（AC12 跨日分桶核心夹具）。
const BEIJING_MIDNIGHT = 1791561600;
const ONE_SECOND_BEFORE = 1791561599;
// 2026-10-10T03:02:33Z = 北京 11:02:33。
const UTC_MORNING = 1791601353;

describe('R15 北京时间统一口径', () => {
  it('跨北京午夜：UTC 16:00 整点直接切到北京次日 00:00，前一秒仍在当日 23:59', () => {
    expect(formatBeijingDate(BEIJING_MIDNIGHT)).toBe('2026-10-10');
    expect(formatBeijingDateTime(BEIJING_MIDNIGHT)).toBe('2026-10-10 00:00');
    expect(formatBeijingDateTime(ONE_SECOND_BEFORE)).toBe('2026-10-09 23:59');
  });

  it('固定 +8 偏移：UTC 早晨映射为北京上午，读取一律经 getUTC*，设备时区无从介入', () => {
    expect(formatBeijingDateTimeFull(UTC_MORNING)).toBe('2026-10-10 11:02:33');
    expect(BEIJING_UTC_OFFSET_SECONDS).toBe(28800);
    expect(beijingClock(UTC_MORNING * 1000).getUTCHours()).toBe(11);
  });

  it('非法输入不伪造时间', () => {
    expect(formatBeijingDate(Number.NaN)).toBe('—');
    expect(formatBeijingDateTime(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatBeijingClockMs(Number.NaN)).toBe('—');
  });

  it('日志时间戳保留毫秒且为北京读数', () => {
    expect(formatBeijingClockMs(UTC_MORNING * 1000 + 456)).toBe('11:02:33.456');
  });

  it('视图消费点已换口径：到期文案的日期段即北京时间格式', () => {
    const copy = formatExpiry(BEIJING_MIDNIGHT + 86400, BEIJING_MIDNIGHT);
    expect(copy).toContain(formatBeijingDate(BEIJING_MIDNIGHT + 86400));
    expect(copy).toContain('剩余 1 天');
  });
});
