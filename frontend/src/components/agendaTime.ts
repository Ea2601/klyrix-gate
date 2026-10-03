// Ağ Ajandası ızgarası (G5.5, AgendaGrid.tsx): Pi'nin saat diliminde (API tz) gün / hafta / ay sınırları ve 15 dakikalık
// adımlar. Tarayıcının dilimi farklı olsa da bütün hesaplar Intl ile verilen dilimde yapılır (Date'in yerel alanları
// kullanılmaz). Yaz saati: ileri alınan saatteki (yok olan) adımlar seçilemez; geri alınan (iki kez yaşanan) saat ızgarada bir
// kez gösterilir ve İLK yaşanışı kullanılır — backend'in yerel etkinlik açılımıyla (calendarEngine.ts expandLocal: JS Date
// yerel kurucusu, "compatible" kural) aynı. Saf yardımcılar: birim testi derlenmiş hâlini Europe/Berlin geçiş haftalarında,
// Europe/Istanbul ve Asia/Dubai'de, tarayıcı (süreç) dilimi Pi'ninkinden farklıyken dener.
import { parseDbTime } from '../time';

export interface Ymd { y: number; m: number; d: number }   // m: 1–12
export interface Wall extends Ymd { min: number; ms: number }   // min: gün içi dakika (0–1439), ms: dakika içi milisaniye
const MIN = 60_000;
const DAY = 86_400_000;
export const STEP_MIN = 15;
export const SLOTS = 1440 / STEP_MIN;            // günde 96 adım
const STEP = STEP_MIN * MIN;
export const WEEKLY_MAX_MIN = 6 * 1440;          // calendarEngine.ts ile aynı: haftalık tekrarda en uzun süre

const fmts = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    fmts.set(tz, f);
  }
  return f;
}
export function validTz(tz: string | null | undefined): boolean {
  if (!tz) return false;
  try { fmt(tz); return true; } catch { return false; }
}
export const browserTz = (): string => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

// t anının dilimdeki duvar saati
export function wallOf(t: number, tz: string): Wall {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(t))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, m: p.month, d: p.day, min: (p.hour % 24) * 60 + p.minute, ms: (p.second || 0) * 1000 + (((t % 1000) + 1000) % 1000) };
}
const utcOf = (a: Ymd) => Date.UTC(a.y, a.m - 1, a.d);
// t anında UTC'den ileri dakika
export function offsetMin(t: number, tz: string): number {
  const w = wallOf(t, tz);
  return Math.round((utcOf(w) + w.min * MIN + w.ms - t) / MIN);
}

// ── Takvim günü (saat dilimsiz) ──────────────────────────────────────────────
export const addDays = (a: Ymd, n: number): Ymd => {
  const d = new Date(utcOf(a) + n * DAY);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};
export const dayDiff = (a: Ymd, b: Ymd): number => Math.round((utcOf(b) - utcOf(a)) / DAY);
export const weekdayOf = (a: Ymd): number => (new Date(utcOf(a)).getUTCDay() + 6) % 7;   // 0 = Pazartesi … 6 = Pazar
export const weekStart = (a: Ymd): Ymd => addDays(a, -weekdayOf(a));
export const monthGridStart = (a: Ymd): Ymd => weekStart({ y: a.y, m: a.m, d: 1 });     // ay ızgarası: 1'inin haftasının Pazartesi'si
export const addMonths = (a: Ymd, n: number): Ymd => {
  const d = new Date(Date.UTC(a.y, a.m - 1 + n, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: 1 };
};
export const sameYmd = (a: Ymd, b: Ymd): boolean => a.y === b.y && a.m === b.m && a.d === b.d;
const two = (n: number) => String(n).padStart(2, '0');
export const ymdKey = (a: Ymd): string => `${a.y}-${two(a.m)}-${two(a.d)}`;
export function parseYmd(s: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const a = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  return sameYmd(addDays(a, 0), a) ? a : null;   // 2026-02-31 gibi taşan tarih yok
}
export const fmtMin = (min: number): string => `${two(Math.floor(min / 60) % 24)}:${two(min % 60)}`;
export const ymdOf = (t: number, tz: string): Ymd => { const w = wallOf(t, tz); return { y: w.y, m: w.m, d: w.d }; };

// ── Duvar saati → an ─────────────────────────────────────────────────────────
// (gün, gün içi dakika; 1440 = ertesi gün 00:00) duvar saatinin anları, artan: [] = yok (saat ileri alındı), iki an = iki kez
// yaşanır (saat geri alındı)
export function wallInstants(a: Ymd, min: number, tz: string): number[] {
  const guess = utcOf(a) + min * MIN;
  const out = new Set<number>();
  for (const o of new Set([offsetMin(guess - DAY, tz), offsetMin(guess, tz), offsetMin(guess + DAY, tz)])) {
    const t = guess - o * MIN;
    if (offsetMin(t, tz) === o) out.add(t);
  }
  return [...out].sort((x, y) => x - y);
}
// JS Date yerel kurucusunun ("compatible") kuralı: iki kez yaşanan → ilki; yok olan → geçişten önceki ofsetle (ileri kayar).
// Backend expandLocal haftalık tekrarı böyle hesaplar.
export function wallToInstant(a: Ymd, min: number, tz: string): number {
  const ts = wallInstants(a, min, tz);
  if (ts.length) return ts[0];
  const guess = utcOf(a) + min * MIN;
  return guess - offsetMin(guess - DAY, tz) * MIN;
}
// Günün ilk anı (gece yarısı yaz saati boşluğundaysa boşluğun bittiği an)
export const dayStart = (a: Ymd, tz: string): number => wallToInstant(a, 0, tz);

export interface Slot { min: number; t: number | null; twice: boolean }
// Günün 96 adımı (duvar saati): t = adımın ilk anı (null: yaz saatinde yok — seçilemez), twice: iki kez yaşanır (bir kez gösterilir)
export function daySlots(a: Ymd, tz: string): Slot[] {
  const out: Slot[] = [];
  for (let i = 0; i < SLOTS; i++) {
    const ts = wallInstants(a, i * STEP_MIN, tz);
    out.push({ min: i * STEP_MIN, t: ts.length ? ts[0] : null, twice: ts.length > 1 });
  }
  return out;
}
// Ana en yakın / alttaki / üstteki 15 dk adım. Bütün güncel dilimlerin ofseti 15 dakikanın katı (ör. +05:45): anı UTC'de 15 dk'ya
// yuvarlamak duvar saatinde de 15 dk'ya yuvarlamaktır.
export const round15 = (t: number): number => Math.round(t / STEP) * STEP;
export const floor15 = (t: number): number => Math.floor(t / STEP) * STEP;
export const ceil15 = (t: number): number => Math.ceil(t / STEP) * STEP;

// [s, e) aralığının görünen günlere düşen parçaları: top / bottom gün içi dakika (0–1440). Geri alınan saatte duvar saati
// geri gittiği için bottom < top olabilir → bottom en az top. Anlık öğe (e = s): yalnız başladığı gün, bottom = top. Önceki
// günden süren parça günün başından (top 0) çizilir; tam gün başında BAŞLAYAN öğe kendi duvar saatinden (gece yarısı yaz saati
// boşluğu olan günlerde — America/Santiago, Africa/Cairo … — gün 01:00'de başlar, öğe "yok" bandına taşmaz).
export interface Seg { day: number; top: number; bottom: number; head: boolean; tail: boolean }
export function segments(s: number, e: number, days: Ymd[], tz: string): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < days.length; i++) {
    const ds = dayStart(days[i], tz), de = dayStart(addDays(days[i], 1), tz);
    if (e <= s) {
      if (s >= ds && s < de) { const w = wallOf(s, tz); out.push({ day: i, top: w.min, bottom: w.min, head: true, tail: true }); }
      continue;
    }
    const a = Math.max(s, ds), b = Math.min(e, de);
    if (a >= b) continue;
    const wa = wallOf(a, tz), wb = wallOf(b, tz);
    const top = a === ds && a !== s ? 0 : wa.min + wa.ms / MIN;
    const bottom = b === de ? 1440 : wb.min + wb.ms / MIN;
    out.push({ day: i, top, bottom: Math.max(bottom, top), head: a === s, tail: b === e });
  }
  return out;
}

// ── Yerel etkinlik (G5.3) ────────────────────────────────────────────────────
export interface LocalLike { start: string; duration_min: number; weekly: boolean; until: string | null }
// Oluşumlar [a, b) içinde — calendarEngine.ts expandLocal'ın aynısı, Pi'nin diliminde: haftalık tekrar duvar saatiyle (yaz saati
// geçişinde saat aynı kalır), 6 günden uzun haftalık hiç tetiklemez, tekrar bitişinden sonra başlayan oluşum yok.
export function expandLocalEvent(ev: LocalLike, a: number, b: number, tz: string): [number, number][] {
  const s0 = parseDbTime(ev.start)?.getTime() ?? NaN;
  if (!Number.isFinite(s0) || !(ev.duration_min > 0)) return [];
  if (ev.weekly && ev.duration_min > WEEKLY_MAX_MIN) return [];
  const dur = ev.duration_min * MIN;
  const until = ev.until ? parseDbTime(ev.until)?.getTime() ?? Infinity : Infinity;
  if (!ev.weekly) return s0 < b && s0 + dur > a ? [[s0, s0 + dur]] : [];
  const base = wallOf(s0, tz);
  const sec = Math.floor(base.ms / 1000) * 1000;   // backend gibi saniyeye kadar (milisaniye düşer)
  const out: [number, number][] = [];
  const skip = Math.max(0, Math.floor((a - dur - s0) / (7 * DAY)) - 1);
  for (let k = skip; k < skip + 600; k++) {
    const s = wallToInstant(addDays(base, 7 * k), base.min, tz) + sec;
    if (s >= b || s > until) break;
    if (s + dur > a) out.push([s, s + dur]);
  }
  return out;
}

// Duvar saatleriyle verilen aralık → anlar (yok olan saat hata; iki kez yaşanan → ilki). hintS / hintE: düzenlenen oluşumun
// özgün anları — duvar dakikası değişmediyse o an aynen kullanılır (geri alınan saatin İKİNCİ yaşanışında biten / başlayan
// etkinlik dokunulmadan kaydedilince süresi kısalmaz, saniyesi düşmez); değiştirilen alan ilk yaşanış kuralına döner.
export function rangeFromWall(
  sDay: Ymd, sMin: number, eDay: Ymd, eMin: number, tz: string, hintS?: number | null, hintE?: number | null,
): { start: number; end: number } | { error: string } {
  const s = wallInstants(sDay, sMin, tz), e = wallInstants(eDay, eMin, tz);
  if (!s.length) return { error: 'Başlangıç saati yaz saati geçişinde yok (saat ileri alındı) — başka bir saat seçin' };
  if (!e.length) return { error: 'Bitiş saati yaz saati geçişinde yok (saat ileri alındı) — başka bir saat seçin' };
  const pick = (ts: number[], hint?: number | null) => (hint != null && ts.some(t => hint >= t && hint < t + MIN) ? hint : ts[0]);
  const start = pick(s, hintS), end = pick(e, hintE);
  if (end <= start) return { error: 'Bitiş başlangıçtan sonra olmalı' };
  return { start, end };
}
// Tekrarın son günü (Pi'nin diliminde o günün sonu)
export const untilOf = (u: Ymd, tz: string): number => dayStart(addDays(u, 1), tz) - 1000;
// calendarEngine.ts validateLocal sınırları (metinler oradakiyle aynı anlamda): süre 1 dk – max_days gün, haftalıkta en çok 6
// gün, tekrar bitişi başlangıçtan önce olamaz. Hata metni ya da null.
export function localRangeError(start: number, end: number, weekly: boolean, maxDays: number, until: number | null): string | null {
  const dur = Math.round((end - start) / MIN);
  if (!(dur >= 1)) return 'Bitiş başlangıçtan sonra olmalı';
  if (dur > maxDays * 1440) return `Süre en çok ${maxDays} gün olabilir (Takvim kuralları → en uzun süre)`;
  if (weekly && dur > WEEKLY_MAX_MIN) return 'Haftalık tekrarda süre en çok 6 gün (her hafta en az bir gün boşluk kalır)';
  if (weekly && until !== null && until < start) return 'Tekrar bitişi başlangıçtan sonra olmalı';
  return null;
}

// İki dilim aralıkta farklı saat veriyor mu (adlar farklı ama kurallar aynıysa uyarı yok)
export function zonesDiffer(a: string, b: string, from: number, to: number): boolean {
  if (a === b) return false;
  if (!validTz(a) || !validTz(b)) return true;
  for (let t = from; t <= to + DAY; t += 6 * 3600_000) if (offsetMin(t, a) !== offsetMin(t, b)) return true;
  return false;
}
