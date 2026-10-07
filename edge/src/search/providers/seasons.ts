import type { DiscoveryCandidate } from '../discovery-provider';

export function season(title: string): { base: string; number: number; unit: string; chinese: boolean } | undefined {
  const match = /^(.*?)第?\s*([0-9零〇一二两兩三四五六七八九十百]+)\s*(季|部|阶段)[\p{P}\s]*$/u.exec(title.normalize('NFKC'));
  if (!match) return;
  const label = match[2], digits = '零一二三四五六七八九';
  let number = 0, digit = 0;
  if (/^\d+$/.test(label)) number = Number(label);
  else if (!/[十百]/.test(label)) {
    for (const c of label) number = number * 10 + digits.indexOf(c.replace(/[两兩]/, '二').replace('〇', '零'));
  } else {
    let previous = 1000;
    for (const c of label) {
      if (c === '十' || c === '百') {
        const unit = c === '十' ? 10 : 100;
        if (unit >= previous || digit > 9) return;
        number += (digit || 1) * unit; digit = 0; previous = unit;
      } else digit = digit * 10 + digits.indexOf(c.replace(/[两兩]/, '二').replace('〇', '零'));
    }
    number += digit;
  }
  const base = match[1].replace(/[\p{P}\s]+$/u, '');
  if (base && number >= 1 && number <= 200) return { base, number, unit: match[3], chinese: !/^\d+$/.test(label) };
}
function chinese(n: number): string {
  const digits = '零一二三四五六七八九';
  if (n < 10) return digits[n];
  if (n < 100) return (n < 20 ? '' : digits[Math.floor(n / 10)]) + '十' + (n % 10 ? digits[n % 10] : '');
  const rest = n % 100;
  return digits[Math.floor(n / 100)] + '百' + (rest ? (rest < 10 ? '零' : rest < 20 ? '一' : '') + chinese(rest) : '');
}
/** Bound queries to observed maxima. No invention of future seasons or unrelated families. */
export async function fillSeasons(query: string, initial: DiscoveryCandidate[], get: (query: string) => Promise<DiscoveryCandidate[]>): Promise<DiscoveryCandidate[]> {
  if (season(query)) return initial;
  const found = new Map(initial.map((item) => [item.id, item]));
  const groups = new Map<string, NonNullable<ReturnType<typeof season>>>();
  for (const item of initial) { const s = season(item.title); if (s && s.base.includes(query)) groups.set(`${s.base}:${s.unit}`, s); }
  let requests = 0;
  for (const group of groups.values()) {
    const known = new Set<number>(); let max = 0;
    for (const item of initial) {
      const s = season(item.title);
      if (item.title === group.base) known.add(1);
      if (s?.base === group.base && s.unit === group.unit) { known.add(s.number); max = Math.max(max, s.number); }
    }
    for (let n = 1; n <= max && requests < 32; n++) {
      if (known.has(n)) continue;
      const labels = group.chinese ? [chinese(n), String(n)] : [String(n), chinese(n)];
      for (const label of [...new Set(labels)]) {
        if (requests++ >= 32) break;
        const q = `${group.base}第${label}${group.unit}`;
        if ([...q].length > 80) continue;
        for (const item of await get(q)) {
          const s = season(item.title);
          if (s?.base === group.base && s.unit === group.unit && s.number === n) { known.add(n); found.set(item.id, item); }
        }
        if (known.has(n)) break;
      }
    }
  }
  return [...found.values()];
}
