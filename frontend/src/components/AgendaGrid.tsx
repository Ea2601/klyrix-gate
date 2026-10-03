import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Info, Loader2, Lock, Plus, Repeat, Trash2, X } from 'lucide-react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { Select, SelectOption } from './ui';
import { toast } from '../toast';
import { parseDbTime } from '../time';
import { PreviewBox } from './CalendarRules';
import { TAG, SUB_KEYS, emitCalendarChanged, onCalendarChanged } from './agendaShared';
import type { AgendaItem, AgendaLink, Source } from './agendaShared';
import {
  SLOTS, STEP_MIN, WEEKLY_MAX_MIN, addDays, addMonths, browserTz, dayDiff, dayStart, daySlots, expandLocalEvent, fmtMin, localRangeError,
  monthGridStart, offsetMin, parseYmd, rangeFromWall, sameYmd, segments, untilOf, validTz, wallInstants, wallOf, wallToInstant, weekStart,
  ymdKey, ymdOf, zonesDiffer,
} from './agendaTime';
import type { Ymd } from './agendaTime';
import './AgendaGrid.css';

// Ağ Ajandası ızgarası (G5.5; AgendaPanel'in Ay / Hafta görünümü, ayrı tembel parça). Saatler Pi'nin saat dilimiyle (API tz)
// çizilir — tarayıcınınki farklıysa uyarı bandı. Kaynaklar: GET /api/agenda (G5.1 öğeleri, salt okunur — KİLİTLİ: kendi
// sayfalarından değişir) ve G5.3'ün yerel etkinlikleri (/api/calendar/local-events). Hafta ızgarasında boş alana sürükleyerek
// (fare, dokunmatik — basılı tutup sürükle — ya da kiosk) ya da "Aralık ekle" formuyla seçilen aralığa, panel etkinliğine açık bir
// etiket bağlamasının profili bağlanır: pencere G5.3'ün yan etkisiz önizlemesini (GET /api/calendar/preview) tam tarihle
// gösterir, kayıt YALNIZ "Kaydet" ile G5.3'ün mevcut yerel etkinlik ucuna (POST / PUT); "Vazgeç" hiçbir istek atmaz. Yerel
// etkinlik sürüklenerek taşınır / alt kenarından boyutlandırılır; her değişiklik yine pencereden (önizleme + onay) geçer.
// Ebeveyn ve trafik HAFTALIK pencereleri yalnız Hafta görünümünde; Ay görünümünde gün hücresinde tek seferlik işler, takvim
// etkinlikleri ve "+N". Motor kapalıyken (calendar_settings) kayıt yapılabilir ama "etkisiz" bandı görünür; ızgara motoru açmaz.
type View = 'month' | 'week';
// sources[].error / warning: okunamayan ya da dikkat isteyen kaynak (Liste görünümündeki bantların aynısı ızgarada da)
interface AgendaResp {
  tz: string; now: string; from: string; to: string; items: AgendaItem[];
  sources: { id: string; label: string; error?: string | null; warning?: string | null }[]; truncated: boolean;
}
const EMPTY: AgendaResp = { tz: '', now: '', from: '', to: '', items: [], sources: [], truncated: false };
interface EntryRow { title: string; local: boolean; start: string; end: string }
interface EngineResp { settings: { enabled: boolean; max_days: number }; allowed: boolean; active: EntryRow[]; upcoming: EntryRow[] }
const ENGINE0: EngineResp = { settings: { enabled: false, max_days: 14 }, allowed: true, active: [], upcoming: [] };
interface Binding { id: number; tag: string; profile_id: number; priority: number; sources: string[] | null; enabled: boolean }
interface LocalEv { id: number; title: string; tag: string; start: string; duration_min: number; weekly: boolean; until: string | null }
const MIN = 60_000;
const MAX_LOCAL = 100;          // calendarEngine.ts MAX_LOCAL
const NAV_MONTHS = 12;          // /api/agenda: from en çok 400 gün uzakta
const TOUCH_HOLD_MS = 380;      // dokunmatikte basılı tutunca seçim başlar (kısa dokunuş = 1 saatlik aralık / öğe)
const MOVE_PX = 6;

// Izgaradaki tek oluşum: kilitli ajanda öğesi ya da yerel (G5.3) etkinlik
interface GItem {
  key: string; src: Source | 'local'; title: string; start: number; end: number; point: boolean; allDay: boolean;
  state: '' | 'pending' | 'approved' | 'active'; item?: AgendaItem; ev?: LocalEv;
}
// Pencere taslağı (yeni bağlama ya da yerel etkinlik düzenleme). occ: düzenlenen oluşumun özgün başlangıcı (haftalıkta kayma);
// sT / eT: duvar saati alanlarının geldiği anlar (geri alınan saatin hangi yaşanışı olduğu duvar saatinde kaybolur)
interface Draft {
  id: number | null; ev: LocalEv | null; occ: number | null; title: string; tag: string;
  sDate: string; sMin: number; eDate: string; eMin: number; weekly: boolean; until: string; sT: number | null; eT: number | null;
}
type Drag =
  | { kind: 'select'; pid: number; a: number; b: number; x: number; y: number; live: boolean; moved: boolean; hit: GItem | null }
  | { kind: 'move' | 'resize'; pid: number; a: number; b: number; x: number; y: number; live: boolean; moved: boolean; hit: GItem };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const statusText = (err: string) => (err === 'HTTP 409' ? 'Bu cihaz uydu — Ağ Ajandası ana cihazdadır.' : `Ajanda alınamadı (${err}).`);
const iso = (t: number) => new Date(t).toISOString();
const durText = (m: number) => {
  if (m < 60) return `${m} dk`;
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d ? `${d} gün` : '', h ? `${h} sa` : '', mm ? `${mm} dk` : ''].filter(Boolean).join(' ');
};
const SRC_LABEL = (s: Source | 'local') => (s === 'local' ? 'Panel etkinliği' : TAG[s]);
const WEEK_ONLY = new Set<string>(['parental', 'traffic']);   // yalnız Hafta görünümünde çizilen haftalık pencereler
const rememberSub = (link: AgendaLink) => {
  const k = link.sub ? SUB_KEYS[link.tab] : undefined;
  if (k && link.sub) { try { sessionStorage.setItem(k, link.sub); } catch { /* depolama yok: sayfanın varsayılan sekmesi */ } }
};
const scrollToSel = (sel: string) => document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
const badTitle = (t: string) => {
  const s = t.trim();
  if (!s) return 'Başlık girin (1–80 karakter)';
  if ([...s].length > 80) return 'Başlık en çok 80 karakter';
  // calendarEngine.ts validName ile aynı: denetim karakteri (U+0000–001F, U+007F) ve < > yok
  return [...s].some(ch => { const c = ch.charCodeAt(0); return c < 32 || c === 127 || ch === '<' || ch === '>'; }) ? 'Başlıkta < > ve denetim karakteri olamaz' : null;
};

// Pi'nin dilimiyle biçimleyiciler (gün başlıkları takvim günüdür: UTC öğlen ile)
function useFormats(tz: string) {
  return useMemo(() => {
    const mk = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('tr-TR', o);
    const dShort = mk({ weekday: 'short', timeZone: 'UTC' }), dLong = mk({ weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
    const mTitle = mk({ month: 'long', year: 'numeric', timeZone: 'UTC' }), dMonth = mk({ day: 'numeric', month: 'long', timeZone: 'UTC' });
    const full = mk({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz });
    const time = mk({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz });
    const dTime = mk({ weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz });
    const noon = (a: Ymd) => new Date(Date.UTC(a.y, a.m - 1, a.d, 12));
    return {
      dayShort: (a: Ymd) => dShort.format(noon(a)), dayLong: (a: Ymd) => dLong.format(noon(a)), month: (a: Ymd) => mTitle.format(noon(a)),
      dayMonth: (a: Ymd) => dMonth.format(noon(a)), full: (t: number) => full.format(new Date(t)), time: (t: number) => time.format(new Date(t)),
      // Sürükleme etiketinin sonu: aynı gün biterse yalnız saat, başka gün biterse kısa gün + saat (gün sonu 24:00 aynı gün)
      until: (s: number, e: number) => (sameYmd(ymdOf(Math.max(s, e - 1), tz), ymdOf(s, tz)) ? time.format(new Date(e)) : dTime.format(new Date(e))),
    };
  }, [tz]);
}

export function AgendaGrid({ view, tz: apiTz, processTz, tzMismatch, now, error, onView }: {
  view: View; tz: string; processTz: string; tzMismatch: boolean; now: number; error: string | null; onView: (v: 'week') => void;
}) {
  const tz = validTz(apiTz) ? apiTz : browserTz();
  const f = useFormats(tz);
  const today = useMemo(() => (now ? ymdOf(now, tz) : null), [now, tz]);
  const [anchor, setAnchor] = useState<Ymd | null>(null);   // null: bugün (Pi'nin saati)
  const base = anchor ?? today;
  const days = useMemo(() => {
    if (!base) return [];
    const first = view === 'week' ? weekStart(base) : monthGridStart(base);
    return Array.from({ length: view === 'week' ? 7 : 42 }, (_, i) => addDays(first, i));
  }, [base, view]);
  const from = days.length ? dayStart(days[0], tz) : 0;
  const to = days.length ? dayStart(addDays(days[days.length - 1], 1), tz) : 0;

  const { data: ag, loading, error: agErr, refetch: refAg } = useApi<AgendaResp>(from ? `/agenda?from=${from}&to=${to}` : '/agenda?days=1', EMPTY, 60000);
  const { data: eng, error: engErr, refetch: refEng } = useApi<EngineResp>('/calendar/engine', ENGINE0, 60000);
  const { data: dec, refetch: refDec } = useApi<{ pending: EntryRow[] }>('/calendar/decisions', { pending: [] }, 60000);
  const { data: prof, refetch: refProf } = useApi<{ profiles: { id: number; name: string }[] }>('/calendar/profiles', { profiles: [] });
  const { data: bind, refetch: refBind } = useApi<{ bindings: Binding[] }>('/calendar/bindings', { bindings: [] });
  const { data: loc, refetch: refLoc } = useApi<{ events: LocalEv[] }>('/calendar/local-events', { events: [] });
  useEffect(() => onCalendarChanged(src => {
    if (src !== 'grid') void Promise.all([refAg(), refEng(), refDec(), refProf(), refBind(), refLoc()]);
  }), [refAg, refEng, refDec, refProf, refBind, refLoc]);
  // Hafta / ay değişirken (useApi veriyi boşaltır) önceki yanıt soluk gösterilir
  const [last, setLast] = useState<AgendaResp>(EMPTY);
  if (ag.now && ag !== last) setLast(ag);
  const shown = ag.now ? ag : last;
  const stale = !ag.now && loading && !!last.now;

  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [info, setInfo] = useState<GItem | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [ghost, setGhost] = useState<{ s: number; e: number; kind: Drag['kind'] } | null>(null);
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);   // süren seçim (adım aralığı)
  const [busy, setBusy] = useState(false);
  const [cell, setCell] = useState(0);   // klavye odağındaki saat hücresi (gün × 24 + saat)
  const colsRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const settings = eng.settings;
  // İlk yanıt gelene dek ENGINE0 varsayılanı (motor kapalı, 14 gün) gerçek ayar değildir: bant ve sınırlar yanıtla
  const engReady = eng !== ENGINE0;
  const engineOk = !engErr;
  // Aralık eklenip yerel etkinlik değiştirilebilir mi (uyduda ya da takvim kuralları okunamazken ızgara salt okunur)
  const canCreate = engReady && engineOk && eng.allowed;
  const profiles = prof.profiles || [];
  const pname = (id: number) => profiles.find(p => p.id === id)?.name || `Profil #${id}`;
  // Panel etkinliğini tetikleyebilen bağlamalar (CalendarRules ile aynı süzgeç): açık ve kaynağı "tüm takvimler" ya da Panel
  const localB = (bind.bindings || []).filter(b => b.enabled && (b.sources === null || b.sources.includes('local')) && profiles.some(p => p.id === b.profile_id));
  const localTags = [...new Set(localB.map(b => b.tag))];
  const events = useMemo(() => loc.events || [], [loc.events]);

  // Öğeler: ajanda (kilitli) + yerel etkinlik oluşumları; dış takvim etkinliğine G5.3 durumu (onay bekliyor / onaylı / etkin)
  const items = useMemo<GItem[]>(() => {
    if (!from) return [];
    const ms = (s: string | null | undefined) => parseDbTime(s)?.getTime() ?? NaN;
    const same = (r: EntryRow, s: number, title: string) => Math.abs(ms(r.start) - s) < 1000 && (r.title || 'Başlıksız etkinlik') === title;
    const out: GItem[] = [];
    for (const it of shown.items) {
      const s = ms(it.start);
      if (!Number.isFinite(s)) continue;
      const point = it.kind !== 'window';
      const e = point ? s : it.end ? ms(it.end) : to;
      let state: GItem['state'] = '';
      if (it.source === 'calendar') {
        if ((dec.pending || []).some(r => same(r, s, it.title))) state = 'pending';
        else if (eng.active.some(r => !r.local && same(r, s, it.title))) state = 'active';
        else if (eng.upcoming.some(r => !r.local && same(r, s, it.title))) state = 'approved';
      }
      out.push({ key: it.id, src: it.source, title: it.title, start: s, end: Number.isFinite(e) ? e : s, point, allDay: !!it.allDay, state, item: it });
    }
    for (const ev of events) {
      for (const [s, e] of expandLocalEvent(ev, from, to, tz)) {
        const active = eng.active.some(r => r.local && Math.abs(ms(r.start) - s) < 1000 && r.title === ev.title);
        out.push({ key: `local:${ev.id}:${s}`, src: 'local', title: ev.title, start: s, end: e, point: false, allDay: false, state: active ? 'active' : '', ev });
      }
    }
    return out;
  }, [shown.items, events, dec.pending, eng.active, eng.upcoming, from, to, tz]);
  // Gösterge sayıları görünen ızgaradan: Ay görünümünde ebeveyn / trafik haftalık pencereleri çizilmez
  const present = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) if (view === 'week' || !WEEK_ONLY.has(it.src)) m.set(it.src, (m.get(it.src) || 0) + 1);
    return m;
  }, [items, view]);
  const visible = items.filter(it => !hidden.has(it.src));

  // ── Gezinme ──
  const lo = today ? addMonths(today, -NAV_MONTHS) : null, hi = today ? addMonths(today, NAV_MONTHS + 1) : null;
  const step = (n: number) => {
    if (!base) return;
    const next = view === 'week' ? addDays(base, 7 * n) : addMonths(base, n);
    if (lo && hi && (dayDiff(lo, next) < 0 || dayDiff(next, hi) <= 0)) return;
    setAnchor(next);
    setInfo(null);
  };
  const canPrev = !!(base && lo && dayDiff(lo, view === 'week' ? addDays(base, -7) : addMonths(base, -1)) >= 0);
  const canNext = !!(base && hi && dayDiff(view === 'week' ? addDays(base, 7) : addMonths(base, 1), hi) > 0);
  const title = !days.length ? '' : view === 'month' ? f.month(base!) : (() => {
    const a = days[0], b = days[6];
    return a.m === b.m ? `${a.d}–${b.d} ${f.month(b)}` : `${f.dayMonth(a)} – ${f.dayMonth(b)} ${b.y}`;
  })();
  const btz = browserTz();
  const tzWarn = !!from && zonesDiffer(tz, btz, from, to);

  // ── Taslak (pencere) ──
  const openDraft = (d: Draft) => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setInfo(null);
    setDraft(d);
  };
  const closeDraft = () => {
    setDraft(null);
    setGhost(null);
    const el = openerRef.current;
    if (el && document.contains(el)) el.focus();
  };
  const fromWall = (s: number, e: number): Pick<Draft, 'sDate' | 'sMin' | 'eDate' | 'eMin' | 'sT' | 'eT'> => {
    const ws = wallOf(s, tz), we = wallOf(e, tz);
    return { sDate: ymdKey(ws), sMin: ws.min, eDate: ymdKey(we), eMin: we.min, sT: s, eT: e };
  };
  const newDraft = (s: number, e: number): Draft => ({
    id: null, ev: null, occ: null, title: '', tag: localTags[0] ?? '', ...fromWall(s, e), weekly: false, until: '',
  });
  const editDraft = (ev: LocalEv, occS: number, s: number, e: number): Draft => {
    const u = ev.until ? parseDbTime(ev.until) : null;
    return {
      id: ev.id, ev, occ: occS, title: ev.title, tag: ev.tag, ...fromWall(s, e), weekly: ev.weekly,
      until: u ? ymdKey(ymdOf(u.getTime(), tz)) : '',
    };
  };
  const addRange = () => {
    // Sıradaki tam saatten 1 saat (görünen haftada bugün yoksa ilk günün 18:00'i)
    const vis = today && days.some(d => sameYmd(d, today)) && now;
    const s = vis ? Math.ceil((now + MIN) / 3600_000) * 3600_000 : wallToInstant(days[0], 18 * 60, tz);
    openDraft(newDraft(s, s + 3600_000));
  };

  // ── Hafta ızgarası: konum ve sürükleme ──
  const slotsByDay = useMemo(() => (view === 'week' ? days.map(d => daySlots(d, tz)) : []), [days, tz, view]);
  // Doğrusal adım (gün × 96 + adım) ↔ duvar saati ↔ an
  const wallAt = (i: number) => ({ day: addDays(days[0], Math.floor(i / SLOTS)), min: (((i % SLOTS) + SLOTS) % SLOTS) * STEP_MIN });
  const isGap = (i: number) => { const d = Math.floor(i / SLOTS); return d >= 0 && d < 7 && slotsByDay[d]?.[i % SLOTS]?.t === null; };
  // Sınır (adım başı) anı: wallToInstant'ın "compatible" kuralı — yok olan duvar saati boşluk uzunluğu kadar ileri kayar (yalnız
  // boşluğun ilk adımı boşluğun sonuna düşer)
  const edgeAt = (i: number) => { const w = wallAt(i); return wallToInstant(w.day, w.min, tz); };
  // Bitiş sınırı: yok olan adımlar atlanır → boşluğa düşen bitiş boşluğun sonudur (imleç aşağı indikçe bitiş geri sıçramaz)
  const endEdge = (i: number) => { while (isGap(i)) i++; return edgeAt(i); };
  const indexOf = (t: number) => { const w = wallOf(t, tz); return dayDiff(days[0], w) * SLOTS + Math.floor(w.min / STEP_MIN); };
  const locate = (x: number, y: number): number => {
    const r = colsRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return 0;
    const d = Math.min(6, Math.max(0, Math.floor(((x - r.left) / r.width) * 7)));
    const s = Math.min(SLOTS - 1, Math.max(0, Math.floor(((y - r.top) / r.height) * SLOTS)));
    return d * SLOTS + s;
  };
  // Seçim [a, b] adımları → [başlangıç, bitiş) anları; yok olan adımlar atlanır (hepsi yoksa null)
  const selRange = (a: number, b: number): [number, number] | null => {
    let x = Math.min(a, b);
    const y = Math.max(a, b);
    while (x <= y && isGap(x)) x++;
    if (x > y) return null;
    return [edgeAt(x), endEdge(y + 1)];
  };
  const ghostFor = (d: Drag): { s: number; e: number } | null => {
    if (d.kind === 'select') { const r = selRange(d.a, d.b); return r ? { s: r[0], e: r[1] } : null; }
    const it = d.hit;
    if (d.kind === 'move') {
      const ws = wallOf(it.start, tz), shift = (d.b - d.a) * STEP_MIN;
      const s = wallToInstant(addDays(ws, Math.floor((ws.min + shift) / 1440)), (((ws.min + shift) % 1440) + 1440) % 1440, tz);
      return { s, e: s + (it.end - it.start) };
    }
    const e = Math.max(endEdge(d.b + 1), it.start + STEP_MIN * MIN);
    return { s: it.start, e };
  };
  const endDrag = () => {
    if (holdRef.current) { clearTimeout(holdRef.current); holdRef.current = null; }
    dragRef.current = null;
  };
  // Sürükleme başlar: işaretçi yakalanır; showSel (dokunmatikte basılı tutunca): seçimin ilk adımı hemen gösterilir
  const activate = (d: Drag, el: HTMLElement, showSel: boolean) => {
    d.live = true;
    try { el.setPointerCapture(d.pid); } catch { /* işaretçi bitti */ }
    if (d.kind === 'select') { setGhost(null); setSel(showSel ? { a: d.a, b: d.b } : null); return; }
    const g = ghostFor(d);
    setGhost(g ? { ...g, kind: d.kind } : null);
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (view !== 'week' || draft || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const t = e.target as HTMLElement;
    if (e.pointerType !== 'touch') e.preventDefault();   // farede metin seçimi / odak halkası olmasın (klavye odağı ayrı)
    const blk = t.closest<HTMLElement>('[data-gi]');
    const hit = blk ? visible.find(it => it.key === blk.dataset.gi) ?? null : null;
    const i = locate(e.clientX, e.clientY);
    const base0 = { pid: e.pointerId, a: i, b: i, x: e.clientX, y: e.clientY, live: false, moved: false };
    if (!hit && !canCreate) return;
    const d: Drag = hit?.ev && canCreate
      ? { ...base0, kind: t.closest('[data-handle]') ? 'resize' : 'move', hit, ...(t.closest('[data-handle]') ? { a: indexOf(hit.end - 1), b: indexOf(hit.end - 1) } : {}) }
      : { ...base0, kind: 'select', hit };
    endDrag();
    dragRef.current = d;
    const el = e.currentTarget;
    if (e.pointerType === 'touch') {
      // Dokunmatik: kısa dokunuş = tıklama, basılı tutup sürükleme = seçim / taşıma; tutmadan kaydırma sayfayı kaydırır
      holdRef.current = setTimeout(() => {
        holdRef.current = null;
        if (dragRef.current === d && (canCreate || d.kind !== 'select')) activate(d, el, true);
      }, TOUCH_HOLD_MS);
    } else {
      activate(d, el, false);
    }
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pid !== e.pointerId) return;
    if (!d.live) {
      // Dokunmatikte basılı tutmadan kaydırma: seçim değil, sayfa kaydırması
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > MOVE_PX) endDrag();
      return;
    }
    const body = bodyRef.current?.getBoundingClientRect();
    if (body && bodyRef.current) {
      if (e.clientY < body.top + 24) bodyRef.current.scrollTop -= 14;
      else if (e.clientY > body.bottom - 24) bodyRef.current.scrollTop += 14;
    }
    if (d.kind === 'select' && !canCreate) return;   // salt okunur: kilitli öğeye tıklama olarak kalır
    const i = locate(e.clientX, e.clientY);
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < MOVE_PX && i === d.b) return;
    d.moved = true;
    if (i === d.b) return;
    d.b = i;
    if (d.kind === 'select') setSel({ a: d.a, b: d.b });
    else { const g = ghostFor(d); setGhost(g ? { ...g, kind: d.kind } : null); }
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pid !== e.pointerId) return;
    const wasHeld = d.live;
    endDrag();
    setSel(null);
    if (!d.moved) {
      setGhost(null);
      // Tıklama / kısa dokunuş (dokunmatikte tutma süresi dolmadan bırakılan da)
      if (!wasHeld && e.pointerType !== 'touch') return;
      if (d.hit?.ev && canCreate) { openDraft(editDraft(d.hit.ev, d.hit.start, d.hit.start, d.hit.end)); return; }
      if (d.hit) { setInfo(d.hit); return; }
      if (!canCreate) return;
      const r = selRange(d.a, Math.min(d.a + 3, Math.floor(d.a / SLOTS) * SLOTS + SLOTS - 1));
      if (r) openDraft(newDraft(r[0], r[1]));
      return;
    }
    const g = ghostFor(d);
    if (!g) { setGhost(null); return; }
    if (d.kind === 'select') openDraft(newDraft(g.s, g.e));
    else if (g.s === d.hit.start && g.e === d.hit.end) setGhost(null);
    else openDraft(editDraft(d.hit.ev!, d.hit.start, g.s, g.e));
  };
  const onCancel = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pid !== e.pointerId) return;
    endDrag();
    setSel(null);
    setGhost(null);
  };
  // Dokunmatik sürükleme sürerken sayfa kaymasın (React dokunma dinleyicileri pasif: yerel, pasif olmayan dinleyici)
  useEffect(() => {
    const el = colsRef.current;
    if (!el) return;
    const h = (ev: TouchEvent) => { if (dragRef.current?.live) ev.preventDefault(); };
    el.addEventListener('touchmove', h, { passive: false });
    return () => el.removeEventListener('touchmove', h);
  }, [view, days.length]);
  // Sürükleme sırasında Esc: vazgeç
  useEffect(() => {
    const h = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === 'Escape' && dragRef.current) { endDrag(); setSel(null); setGhost(null); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  // Hafta değişince sabah saatine (bugün görünüyorsa şimdiki saatin biraz öncesine) kaydır
  const weekKey = view === 'week' && days.length ? ymdKey(days[0]) : '';
  const nowRef = useRef(now);
  useEffect(() => { nowRef.current = now; }, [now]);
  useEffect(() => {
    const el = bodyRef.current;
    if (!weekKey || !el) return;
    const n = nowRef.current;
    const showNow = n && n >= from && n < to;
    const h = showNow ? Math.max(0, wallOf(n, tz).min / 60 - 2) : 7;
    el.scrollTop = (h / 24) * el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekKey]);

  // Klavye: saat hücreleri arasında oklar (gün × saat), Enter / Boşluk o saate 1 saatlik aralık. Kapalı hücre (yaz saatinde yok
  // olan saat; salt okunurken hepsi) odak almaz: oklar onu atlar, sınırda durur; Tab ile girilen hücre her zaman açık olandır.
  const hourGone = (n: number) => {
    const sl = slotsByDay[Math.floor(n / 24)];
    return !!sl && sl.length > 0 && sl.slice((n % 24) * 4, (n % 24) * 4 + 4).every(s => s.t === null);
  };
  const cellOff = (n: number) => !canCreate || hourGone(n);
  let tabCell = cell;
  if (cellOff(cell)) for (let n = 0; n < 7 * 24; n++) if (!cellOff(n)) { tabCell = n; break; }
  const cellKey = (e: KeyboardEvent<HTMLButtonElement>, n: number) => {
    const moves: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -24, ArrowRight: 24 };
    if (e.key in moves) {
      e.preventDefault();
      let next = n + moves[e.key];
      while (next >= 0 && next < 7 * 24 && cellOff(next)) next += moves[e.key];
      if (next < 0 || next >= 7 * 24) return;
      setCell(next);
      colsRef.current?.querySelector<HTMLButtonElement>(`[data-cell="${next}"]`)?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const d = Math.floor(n / 24), h = n % 24;
      const r = selRange(d * SLOTS + h * 4, d * SLOTS + h * 4 + 3);
      if (r) openDraft(newDraft(r[0], r[1]));
    }
  };
  // Öğe düğmesi: klavyeyle (detail 0) Enter → ayrıntı / düzenleme (fare ve dokunma işaretçi olaylarıyla)
  const itemClick = (e: MouseEvent<HTMLElement>, it: GItem) => {
    if (e.detail !== 0 && view === 'week') return;
    if (it.ev && canCreate) openDraft(editDraft(it.ev, it.start, it.start, it.end));
    else setInfo(it);
  };

  // ── Kaydet / sil ──
  // Sonrasında odak (pencere kapanır): açan öğe yerindeyse o; yerel etkinliğin bloğu / çipi yeniden çizildiği için (taşınınca
  // anahtarı değişir, silinince yok olur) Hafta'da aralığın başladığı saat hücresi, Ay'da o günün düğmesi, yoksa "Aralık ekle"
  const focusAfterWrite = (at: number) => {
    const el = openerRef.current;
    if (el && el !== document.body && document.contains(el) && !el.matches('.agg-blk.is-local, .agg-chip.is-local')) { el.focus(); return; }
    let target: HTMLElement | null | undefined = null;
    if (view === 'week') {
      const i = indexOf(at);
      const n = Math.floor(i / SLOTS) * 24 + Math.floor((i % SLOTS) / (60 / STEP_MIN));
      const c = i >= 0 && i < 7 * SLOTS && !cellOff(n) ? n : tabCell;
      setCell(c);
      target = colsRef.current?.querySelector<HTMLElement>(`[data-cell="${c}"]:not(:disabled)`);
    } else {
      target = document.querySelector<HTMLElement>(`.agg-mday[data-day="${ymdKey(ymdOf(at, tz))}"]`);
    }
    (target ?? document.querySelector<HTMLElement>('.agg-add'))?.focus();
  };
  const save = async (body: Record<string, unknown>, id: number | null, at: number) => {
    setBusy(true);
    try {
      if (id === null) await postApi('/calendar/local-events', body); else await putApi(`/calendar/local-events/${id}`, body);
      toast.success(id === null ? 'Aralık kaydedildi' : 'Etkinlik güncellendi');
      setDraft(null);
      setGhost(null);
      focusAfterWrite(at);
      emitCalendarChanged('grid');
      await Promise.all([refLoc(), refEng(), refAg()]);
    } catch (e) { toast.error(errText(e)); } finally { setBusy(false); }
  };
  const remove = async (ev: LocalEv, at: number) => {
    if (!window.confirm(`«${ev.title}» silinsin mi?\n\nSürüyorsa takvim etkisi hemen biter${ev.weekly ? '; bütün haftalık tekrarlar silinir' : ''}.`)) return;
    setBusy(true);
    try {
      await deleteApi(`/calendar/local-events/${ev.id}`);
      toast.success('Etkinlik silindi');
      setDraft(null);
      setGhost(null);
      focusAfterWrite(at);
      emitCalendarChanged('grid');
      await Promise.all([refLoc(), refEng()]);
    } catch (e) { toast.error(errText(e)); } finally { setBusy(false); }
  };

  if (!now) {
    return error ? <div className="ag-alert is-error"><AlertTriangle size={14} /><span>{statusText(error)}</span></div>
      : <p className="ag-empty ag-loading"><Loader2 size={14} className="spin" /> Ajanda yükleniyor…</p>;
  }
  const nowIdx = view === 'week' && now >= from && now < to ? dayDiff(days[0], ymdOf(now, tz)) : -1;
  const legend = [...present.keys()].sort((a, b) => (a === 'local' ? -1 : b === 'local' ? 1 : SRC_LABEL(a as Source).localeCompare(SRC_LABEL(b as Source), 'tr')));

  return (
    <div className="agg" data-view={view}>
      <div className="agg-toolbar">
        <div className="agg-nav" role="group" aria-label={view === 'week' ? 'Hafta' : 'Ay'}>
          <button className="agg-navbtn" onClick={() => step(-1)} disabled={!canPrev} aria-label={view === 'week' ? 'Önceki hafta' : 'Önceki ay'}><ChevronLeft size={15} /></button>
          <button className="agg-today" onClick={() => { setAnchor(null); setInfo(null); }} disabled={!anchor}>Bugün</button>
          <button className="agg-navbtn" onClick={() => step(1)} disabled={!canNext} aria-label={view === 'week' ? 'Sonraki hafta' : 'Sonraki ay'}><ChevronRight size={15} /></button>
        </div>
        <h4 className="agg-title" aria-live="polite">{title}</h4>
        <span className="ag-tz"><Info size={13} /> Saatler: <b>{tz}</b></span>
        <button className="btn-primary btn-sm agg-on agg-add" onClick={addRange} disabled={!canCreate}><Plus size={13} /> Aralık ekle</button>
      </div>

      {(error || agErr) && <div className="ag-alert is-error"><AlertTriangle size={14} /><span>{statusText((agErr || error)!)}</span></div>}
      {/* Okunamayan kaynağın saatleri ızgarada boş görünür: Liste'deki bantların aynısı */}
      {shown.sources.filter(s => s.error).map(s => (
        <div key={`e${s.id}`} className="ag-alert is-error"><AlertTriangle size={14} /><span>{s.label} okunamadı: {s.error}</span></div>
      ))}
      {shown.sources.filter(s => !s.error && s.warning).map(s => (
        <div key={`w${s.id}`} className="ag-alert is-warn"><AlertTriangle size={14} /><span><b>{s.label}:</b> {s.warning}</span></div>
      ))}
      {!validTz(apiTz) && <div className="ag-alert is-warn"><AlertTriangle size={14} /><span>Pi'nin saat dilimi okunamadı — ızgara bu tarayıcının saatiyle ({tz}) çiziliyor.</span></div>}
      {validTz(apiTz) && tzWarn && (
        <div className="ag-alert is-warn" role="note"><AlertTriangle size={14} />
          <span>Bu cihazın saat dilimi (<b>{btz}</b>) Pi'ninkinden (<b>{tz}</b>) farklı: ızgaradaki ve formdaki saatler <b>Pi'nin saatidir</b>; etkinlik Pi'nin saatiyle başlar ve biter.</span>
        </div>
      )}
      {tzMismatch && <div className="ag-alert is-warn"><AlertTriangle size={14} /><span>Panel hâlâ <b>{processTz}</b> diliminde çalışıyor: yeniden başlayana dek kurallar o dilime göre uygulanır (ayrıntı Liste görünümünde).</span></div>}
      {engErr === 'HTTP 409' ? null : engErr ? (
        <div className="ag-alert is-error"><AlertTriangle size={14} /><span>Takvim kuralları alınamadı ({engErr}) — ızgarada aralık eklenemez.</span></div>
      ) : engReady && !settings.enabled && (
        <div className="ag-alert is-warn agg-off-band" role="note"><AlertTriangle size={14} />
          <span><b>Takvim kuralları motoru kapalı — etkisiz.</b> Izgarada eklediğiniz aralıklar kaydedilir ama motor açılana dek hiçbir kural uygulanmaz.
            {' '}<button className="agg-linkbtn" onClick={() => scrollToSel('.cr-panel')}>Takvim kuralları</button></span>
        </div>
      )}

      {legend.length > 0 && (
        <div className="ag-chips agg-legend" role="group" aria-label="Gösterge ve kaynak süzgeci">
          {legend.map(s => (
            <button key={s} data-src={s} className={`ag-chip agg-key${hidden.has(s) ? ' is-hidden' : ''}`} aria-pressed={!hidden.has(s)}
              title={hidden.has(s) ? 'Göster' : 'Gizle'}
              onClick={() => setHidden(h => { const n = new Set(h); if (n.has(s)) n.delete(s); else n.add(s); return n; })}>
              <span className={`agg-swatch${s === 'calendar' ? ' is-ext' : ''}`} aria-hidden="true" />{SRC_LABEL(s as Source | 'local')} <b>{present.get(s)}</b>
            </button>
          ))}
          {items.some(i => i.state === 'pending') && <span className="agg-key-note"><span className="agg-swatch is-pending" aria-hidden="true" /> onay bekliyor</span>}
          {view === 'month' && items.some(i => WEEK_ONLY.has(i.src)) && <span className="agg-key-note">ebeveyn ve trafik pencereleri Hafta görünümünde</span>}
          <span className="agg-key-note"><Lock size={11} /> kilitli: kendi sayfasından</span>
        </div>
      )}

      {info && <InfoCard it={info} f={f} onClose={() => setInfo(null)} />}

      {view === 'week' ? (
        <div className={`agg-week${stale ? ' is-stale' : ''}`} aria-busy={stale || undefined}>
          <div className="agg-head">
            <span className="agg-corner" aria-hidden="true" />
            {days.map((d, i) => (
              <div key={ymdKey(d)} className={`agg-dh${i === nowIdx ? ' is-today' : ''}`}>
                <span>{f.dayShort(d)}</span> <b>{d.d}</b>
              </div>
            ))}
          </div>
          {visible.some(it => it.allDay) && (
            <div className="agg-allday" aria-label="Tüm gün">
              <span className="agg-corner">tüm gün</span>
              {days.map((d, i) => (
                <div key={ymdKey(d)} className="agg-adcol">
                  {visible.filter(it => it.allDay && segments(it.start, it.end, [d], tz).length).map(it => (
                    <button key={`${it.key}:${i}`} data-src={it.src} className={`agg-chip${it.state ? ` is-${it.state}` : ''}`} onClick={() => setInfo(it)}
                      aria-label={`${it.title}, ${SRC_LABEL(it.src)}, tüm gün — kilitli; ayrıntı`}>{it.title}</button>
                  ))}
                </div>
              ))}
            </div>
          )}
          <div className="agg-body" ref={bodyRef}>
            <div className="agg-gutter" aria-hidden="true">
              {Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: `${(h / 24) * 100}%` }}>{h ? fmtMin(h * 60) : ''}</span>)}
            </div>
            <div className="agg-cols" ref={colsRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}
              onContextMenu={e => { if (dragRef.current) e.preventDefault(); }}>
              {days.map((d, di) => (
                <WeekColumn key={ymdKey(d)} di={di} day={d} f={f} tz={tz} slots={slotsByDay[di] || []} items={visible}
                  cell={tabCell} cellKey={cellKey} setCell={setCell} itemClick={itemClick} canCreate={canCreate}
                  now={di === nowIdx ? wallOf(now, tz).min : null} />
              ))}
              {sel && (() => { const r = selRange(sel.a, sel.b); return r ? <Overlay s={r[0]} e={r[1]} days={days} tz={tz} cls="agg-sel" label={`${f.full(r[0])} – ${f.until(r[0], r[1])}`} /> : null; })()}
              {ghost && <Overlay s={ghost.s} e={ghost.e} days={days} tz={tz} cls={`agg-ghost is-${ghost.kind}`} label={`${f.full(ghost.s)} – ${f.until(ghost.s, ghost.e)}`} />}
            </div>
          </div>
        </div>
      ) : (
        <MonthGrid days={days} base={base!} today={today} items={visible} tz={tz} f={f} stale={stale}
          goWeek={d => { setAnchor(d); onView('week'); }} itemClick={itemClick} />
      )}
      {shown.truncated && <p className="ag-empty">Bu aralıkta öğe çok olduğu için ızgara kısaltıldı — kaynak süzgeciyle azaltın.</p>}
      {!canCreate && engErr === 'HTTP 409' && <p className="ag-empty">Bu cihaz uydu: takvim kuralları ana cihazda.</p>}

      {draft && (
        <BindDialog draft={draft} setDraft={setDraft} tz={tz} f={f} busy={busy} maxDays={settings.max_days} engineOn={settings.enabled} now={now}
          localB={localB} localTags={localTags} pname={pname} count={events.length} visible={visible}
          onCancel={closeDraft} onSave={save} onDelete={remove} />
      )}
    </div>
  );
}

type Fmt = ReturnType<typeof useFormats>;

// Haftanın bir günü: 24 saat hücresi (klavye), yaz saati bantları, öğe blokları (şerit paketleme), şimdi çizgisi
function WeekColumn({ di, day, f, tz, slots, items, cell, cellKey, setCell, itemClick, canCreate, now }: {
  di: number; day: Ymd; f: Fmt; tz: string; slots: { min: number; t: number | null; twice: boolean }[]; items: GItem[];
  cell: number; cellKey: (e: KeyboardEvent<HTMLButtonElement>, n: number) => void; setCell: (n: number) => void;
  itemClick: (e: MouseEvent<HTMLElement>, it: GItem) => void; canCreate: boolean; now: number | null;
}) {
  // Bu güne düşen parçalar → çakışanlar yan yana şeritlerde
  const blocks = useMemo(() => {
    const segs: { it: GItem; top: number; bottom: number; head: boolean; tail: boolean }[] = [];
    for (const it of items) {
      if (it.allDay) continue;
      for (const s of segments(it.start, it.end, [day], tz)) segs.push({ it, top: s.top, bottom: Math.max(s.bottom, s.top + STEP_MIN), head: s.head, tail: s.tail });
    }
    segs.sort((a, b) => a.top - b.top || b.bottom - a.bottom || (a.it.src === 'local' ? -1 : 1));
    const out: { it: GItem; top: number; bottom: number; head: boolean; tail: boolean; lane: number; lanes: number }[] = [];
    let group: typeof out = [];
    let groupEnd = -1;
    const flush = () => { const n = Math.max(...group.map(g => g.lane)) + 1; for (const g of group) g.lanes = n; out.push(...group); group = []; };
    for (const s of segs) {
      if (group.length && s.top >= groupEnd) flush();
      const ends: number[] = [];
      for (const g of group) ends[g.lane] = Math.max(ends[g.lane] ?? -1, g.bottom);
      let lane = 0;
      while (ends[lane] !== undefined && ends[lane] > s.top) lane++;
      group.push({ ...s, lane, lanes: 1 });
      groupEnd = Math.max(groupEnd, s.bottom);
    }
    if (group.length) flush();
    return out;
  }, [items, day, tz]);
  // Yaz saati: yok olan (ileri alınan) ve iki kez yaşanan (geri alınan) adımların bantları
  const bands = useMemo(() => {
    const out: { top: number; bottom: number; kind: 'gap' | 'twice' }[] = [];
    for (const s of slots) {
      const kind = s.t === null ? 'gap' : s.twice ? 'twice' : null;
      if (!kind) continue;
      const last = out[out.length - 1];
      if (last && last.kind === kind && last.bottom === s.min) last.bottom = s.min + STEP_MIN;
      else out.push({ top: s.min, bottom: s.min + STEP_MIN, kind });
    }
    return out;
  }, [slots]);
  const pct = (m: number) => `${(m / 1440) * 100}%`;
  const dayName = f.dayLong(day);
  return (
    <div className={`agg-col${now !== null ? ' is-today' : ''}`} role="group" aria-label={dayName}>
      {Array.from({ length: 24 }, (_, h) => {
        const n = di * 24 + h;
        const gone = slots.length > 0 && slots.slice(h * 4, h * 4 + 4).every(s => s.t === null);
        const twice = slots.slice(h * 4, h * 4 + 4).some(s => s.twice);
        return (
          <button key={h} type="button" className="agg-cell" data-cell={n} tabIndex={n === cell ? 0 : -1} disabled={gone || !canCreate}
            aria-label={`${dayName} ${fmtMin(h * 60)}–${fmtMin((h + 1) * 60)}${gone ? ' — yaz saati geçişinde yok' : twice ? ' — bu saat iki kez yaşanır, ilki' : ''}${gone || !canCreate ? '' : '; Enter: bu saate aralık ekle'}`}
            onKeyDown={e => cellKey(e, n)} onFocus={() => setCell(n)} />
        );
      })}
      {bands.map(b => (
        <div key={`${b.kind}${b.top}`} className={`agg-dst is-${b.kind}`} style={{ top: pct(b.top), height: pct(b.bottom - b.top) }} aria-hidden="true">
          <span>{b.kind === 'gap' ? 'yaz saati: yok' : 'iki kez'}</span>
        </div>
      ))}
      {blocks.map(({ it, top, bottom, head, tail, lane, lanes }) => {
        const local = !!it.ev;
        const style: CSSProperties = { top: pct(top), height: pct(bottom - top), left: `calc(${(lane / lanes) * 100}% + 1px)`, width: `calc(${100 / lanes}% - 3px)` };
        const when = it.point ? f.time(it.start) : `${f.time(it.start)}–${f.time(it.end)}`;
        const label = `${it.title}, ${SRC_LABEL(it.src)}, ${it.point ? f.full(it.start) : `${f.full(it.start)} – ${f.full(it.end)}`}${it.state === 'pending' ? ', onay bekliyor' : it.state === 'active' ? ', şu an etkin' : ''}${local ? ' — taşımak için sürükleyin, düzenlemek için Enter' : ' — kilitli, taşınamaz; ayrıntı için Enter'}`;
        return (
          <button key={`${it.key}`} type="button" data-gi={it.key} data-src={it.src}
            className={`agg-blk${it.point ? ' is-point' : ''}${local ? ' is-local' : ' is-locked'}${it.state ? ` is-${it.state}` : ''}${head ? '' : ' cont-top'}${tail ? '' : ' cont-bot'}`}
            style={style} aria-label={label} onClick={e => itemClick(e, it)}>
            <span className="agg-blk-t">{local ? null : <Lock size={9} aria-hidden="true" />}{it.item?.color && <span className="ag-cdot" style={{ background: it.item.color }} aria-hidden="true" />}{it.title}</span>
            {!it.point && bottom - top >= 45 && <span className="agg-blk-w">{when}</span>}
            {local && tail && <span className="agg-handle" data-handle="1" aria-hidden="true" />}
          </button>
        );
      })}
      {now !== null && <div className="agg-now" style={{ top: pct(now) }} aria-hidden="true" />}
    </div>
  );
}

// Seçim / sürükleme gölgesi: [s, e) aralığının günlere düşen parçaları
function Overlay({ s, e, days, tz, cls, label }: { s: number; e: number; days: Ymd[]; tz: string; cls: string; label: string }) {
  const segs = segments(s, e, days, tz);
  return (
    <>
      {segs.map((g, i) => (
        <div key={g.day} className={cls} aria-hidden={i > 0 || undefined}
          style={{ left: `${(g.day / 7) * 100}%`, width: `${100 / 7}%`, top: `${(g.top / 1440) * 100}%`, height: `${((Math.max(g.bottom, g.top + STEP_MIN) - g.top) / 1440) * 100}%` }}>
          {i === 0 && <span>{label}</span>}
        </div>
      ))}
    </>
  );
}

// Ay görünümü: gün hücresinde tek seferlik işler + takvim etkinlikleri (ebeveyn / trafik haftalık pencereleri yalnız Hafta'da), "+N"
function MonthGrid({ days, base, today, items, tz, f, stale, goWeek, itemClick }: {
  days: Ymd[]; base: Ymd; today: Ymd | null; items: GItem[]; tz: string; f: Fmt; stale: boolean;
  goWeek: (d: Ymd) => void; itemClick: (e: MouseEvent<HTMLElement>, it: GItem) => void;
}) {
  const { cells, daily } = useMemo(() => {
    // Her gün aynı saatte çalışan iş (kota yenilenmesi, gece yedeği, cron …) tek seferlik değil: hücreleri doldurmasın diye
    // ızgaranın üstünde tek satırda (görünen günlerin en az %80'inde aynı kaynak + başlık + saat)
    const kinds = new Map<string, Set<number>>();
    const keyOf = (it: GItem) => `${it.src}|${it.title}|${f.time(it.start)}`;
    const per = days.map(() => [] as { it: GItem; head: boolean }[]);
    for (const it of items) {
      if (WEEK_ONLY.has(it.src)) continue;
      for (const s of segments(it.start, it.end, days, tz)) {
        per[s.day].push({ it, head: s.head });
        if (it.point) { const k = keyOf(it); if (!kinds.has(k)) kinds.set(k, new Set()); kinds.get(k)!.add(s.day); }
      }
    }
    const every = new Set([...kinds].filter(([, d]) => d.size >= Math.ceil(days.length * 0.8)).map(([k]) => k));
    const rank = (x: GItem) => (x.src === 'local' ? 0 : x.src === 'calendar' ? 1 : 2);
    const cells = per.map(l => l.filter(x => !(x.it.point && every.has(keyOf(x.it)))).sort((a, b) => rank(a.it) - rank(b.it) || a.it.start - b.it.start));
    const daily = [...every].map(k => { const [src, title, time] = k.split('|'); return { src, title, time }; }).sort((a, b) => a.time.localeCompare(b.time));
    return { cells, daily };
  }, [days, items, tz, f]);
  const MAX = 3;
  return (
    <div className={`agg-month${stale ? ' is-stale' : ''}`} aria-busy={stale || undefined}>
      {daily.length > 0 && (
        <p className="agg-daily"><b>Her gün:</b> {daily.map(d => (
          <span key={`${d.src}${d.title}${d.time}`} data-src={d.src} className="agg-daily-i"><span className="agg-swatch" aria-hidden="true" />{d.time} {d.title}</span>
        ))}<span className="agg-muted"> — hücrelerde gösterilmez (Hafta görünümünde saatinde)</span></p>
      )}
      <div className="agg-mhead" aria-hidden="true">{days.slice(0, 7).map(d => <span key={ymdKey(d)}>{f.dayShort(d)}</span>)}</div>
      <div className="agg-mgrid">
        {days.map((d, i) => {
          const list = cells[i];
          const other = d.m !== base.m;
          const isToday = !!today && sameYmd(d, today);
          return (
            <div key={ymdKey(d)} className={`agg-mcell${other ? ' is-other' : ''}${isToday ? ' is-today' : ''}`} role="group" aria-label={`${f.dayLong(d)}${list.length ? `, ${list.length} öğe` : ''}`}>
              <button className="agg-mday" data-day={ymdKey(d)} onClick={() => goWeek(d)} aria-label={`${f.dayLong(d)} — haftayı aç`}>{d.d}</button>
              {list.slice(0, MAX).map(({ it, head }) => (
                <button key={it.key} data-src={it.src} className={`agg-chip${it.state ? ` is-${it.state}` : ''}${it.ev ? ' is-local' : ''}`}
                  onClick={e => itemClick(e, it)} title={`${it.title} · ${SRC_LABEL(it.src)}`}
                  aria-label={`${it.title}, ${SRC_LABEL(it.src)}, ${f.full(it.start)}${it.ev ? '' : ' — kilitli; ayrıntı'}`}>
                  {it.item?.color && <span className="ag-cdot" style={{ background: it.item.color }} aria-hidden="true" />}
                  <span className="agg-chip-t">{head && !it.allDay ? f.time(it.start) : '…'}</span> {it.title}
                </button>
              ))}
              {list.length > MAX && <button className="agg-more" onClick={() => goWeek(d)} aria-label={`${list.length - MAX} öğe daha — haftayı aç`}>+{list.length - MAX}</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Kilitli öğenin ayrıntısı: kendi sayfasına bağlantı (ebeveyn, trafik, cron …) ya da takvim bağlantıları / onay
function InfoCard({ it, f, onClose }: { it: GItem; f: Fmt; onClose: () => void }) {
  const a = it.item;
  const when = it.point ? f.full(it.start) : it.allDay ? `${f.full(it.start)} – ${f.full(it.end)} (tüm gün)` : `${f.full(it.start)} – ${f.full(it.end)}`;
  const go = (e: MouseEvent<HTMLAnchorElement>, link: AgendaLink) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    rememberSub(link);
  };
  return (
    <div className="agg-info" data-src={it.src} role="region" aria-label="Seçili öğe" aria-live="polite">
      <div className="agg-info-h">
        <b>{it.title}</b> <span className="ag-tag" data-src={it.src}>{SRC_LABEL(it.src)}</span>
        {it.state === 'pending' && <span className="ag-badge">onay bekliyor</span>}
        {it.state === 'active' && <span className="ag-badge is-now">şu an etkin</span>}
        <button className="icon-btn icon-btn-sm agg-info-x" onClick={onClose} aria-label="Kapat"><X size={14} /></button>
      </div>
      <div className="agg-info-w">{when}</div>
      {a?.note && <div className="agg-info-n">{a.note}</div>}
      {a?.tags?.length ? <div className="agg-info-n">{a.tags.map(t => <span key={t} className="ag-ctag">#{t}</span>)}</div> : null}
      <div className="agg-info-a">
        <span className="agg-lock"><Lock size={12} /> Kilitli — burada taşınamaz</span>
        {a?.link ? (
          <a className="ag-link" href={`#${a.link.tab}`} onClick={e => go(e, a.link!)}>Sayfasını aç <ChevronRight size={13} /></a>
        ) : it.src === 'calendar' ? (
          <>
            <button className="agg-linkbtn" onClick={() => scrollToSel('#cal-sources')}>Takvim bağlantıları</button>
            {it.state === 'pending' && <button className="agg-linkbtn" onClick={() => scrollToSel('.cr-panel')}>Onayla / reddet (Takvim kuralları)</button>}
          </>
        ) : null}
      </div>
    </div>
  );
}

// "Profil bağla" / yerel etkinlik penceresi: form (klavye karşılığı), tam tarihli özet, G5.3 sınırları, yan etkisiz önizleme.
// Vazgeç / Esc / dışarı tıklama: hiçbir istek yok.
function BindDialog({ draft, setDraft, tz, f, busy, maxDays, engineOn, now, localB, localTags, pname, count, visible, onCancel, onSave, onDelete }: {
  draft: Draft; setDraft: (d: Draft) => void; tz: string; f: Fmt; busy: boolean; maxDays: number; engineOn: boolean; now: number;
  localB: Binding[]; localTags: string[]; pname: (id: number) => string; count: number; visible: GItem[];
  onCancel: () => void; onSave: (body: Record<string, unknown>, id: number | null, at: number) => Promise<void>;
  onDelete: (ev: LocalEv, at: number) => Promise<void>;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => { firstRef.current?.focus(); }, []);
  // Başlık hatası yazmaya başlanınca ya da kaydetme denenince görünür: pencere açılır açılmaz uyarı yok (önizleme başlıktan
  // bağımsız). Alandan çıkış (blur) tetiklemez — X / Vazgeç'e basarken pencere uyarıyla büyüyüp düğme imlecin altından kaymasın.
  const [touched, setTouched] = useState(false);
  // Bağlama başına önizlemesi görünen sorgu: Kaydet yalnız güncel aralığın önizlemesi (yanıt ya da hata) görününce açılır
  const [ready, setReady] = useState<Record<number, string>>({});
  const set = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  const sDay = parseYmd(draft.sDate), eDay = parseYmd(draft.eDate);
  const r = sDay && eDay ? rangeFromWall(sDay, draft.sMin, eDay, draft.eMin, tz, draft.sT, draft.eT) : { error: 'Tarih geçersiz' };
  const uDay = draft.weekly && draft.until ? parseYmd(draft.until) : null;
  const until = uDay ? untilOf(uDay, tz) : null;
  const range = 'error' in r ? null : r;
  // Haftalık etkinliğin taşınan oluşumu: seri başlangıcı aynı duvar saati kadar kayar (bütün tekrarlar birlikte)
  let start = range?.start ?? NaN;
  if (range && draft.ev && draft.ev.weekly && draft.weekly && draft.occ !== null) {
    const o = wallOf(draft.occ, tz), n = wallOf(range.start, tz), b = wallOf(parseDbTime(draft.ev.start)?.getTime() ?? range.start, tz);
    const shift = dayDiff(o, n) * 1440 + (n.min - o.min);
    const m = b.min + shift;
    start = wallToInstant(addDays(b, Math.floor(m / 1440)), ((m % 1440) + 1440) % 1440, tz) + Math.floor(b.ms / 1000) * 1000;
  }
  const dur = range ? Math.round((range.end - range.start) / MIN) : 0;
  // Geçmişte kalan (hiç etkisi olmayacak) aralık: tek seferlikte bitiş, haftalıkta son tekrarın bitişi şimdiden önce
  const past = !range || !now ? null
    : !draft.weekly ? (range.end <= now ? 'Bu aralık geçmişte — kaydedilse de hiçbir etkisi olmaz' : null)
      : until !== null && until + (range.end - range.start) <= now ? 'Tekrarın son günü geçmişte — kaydedilse de hiçbir etkisi olmaz' : null;
  // Aralık / sınır / profil hataları: önizleme bunlara bağlı (başlık ve etkinlik sayısı sınırı önizlemeyi engellemez)
  const rangeErrs = [
    'error' in r ? r.error : null,
    // Süre oluşumdan; tekrar bitişi kaydedilecek seri başlangıcına göre (backend validateLocal gibi)
    range ? localRangeError(start, start + (range.end - range.start), draft.weekly, maxDays, until) : null,
    !localTags.length ? 'Panel etkinliğini tetikleyecek etiket bağlaması yok — önce Takvim kuralları\'nda profil ekleyip etiketine bağlayın' : !localTags.includes(draft.tag) ? 'Profil seçin' : null,
    draft.weekly && draft.until && !uDay ? 'Tekrarın son günü geçersiz' : null,
    past,
  ].filter((x): x is string => !!x);
  const errs = [...rangeErrs, ...(draft.id === null && count >= MAX_LOCAL ? [`En çok ${MAX_LOCAL} yerel etkinlik — önce eskileri silin`] : [])];
  const titleErr = badTitle(draft.title);
  const shownErrs = touched && titleErr ? [titleErr, ...errs] : errs;
  const body = range ? {
    title: draft.title.trim(), tag: draft.tag, start: iso(start), duration_min: dur, weekly: draft.weekly, until: until !== null ? iso(until) : null,
  } : null;
  const ev = draft.ev;
  const unchanged = !!(ev && body && body.title === ev.title && body.tag === ev.tag && body.duration_min === ev.duration_min && body.weekly === ev.weekly
    && Math.abs(start - (parseDbTime(ev.start)?.getTime() ?? NaN)) < 1000 && (body.until ?? '') === (ev.until ? iso(parseDbTime(ev.until)?.getTime() ?? 0) : ''));
  const dstShift = !!range && draft.weekly && offsetMin(range.start, tz) !== offsetMin(range.end, tz);
  // Geri alınan saatte iki kez yaşanan başlangıç / bitiş: hangisi kullanılıyor (dokunulmamış etkinlikte özgün yaşanışı)
  const sTs = sDay ? wallInstants(sDay, draft.sMin, tz) : [], eTs = eDay ? wallInstants(eDay, draft.eMin, tz) : [];
  const twiceS = sTs.length > 1, twiceE = eTs.length > 1;
  const passOf = (ts: number[], t: number | undefined) => (t !== undefined && t >= ts[1] ? 'ikincisi kullanılır (saati değiştirirseniz ilki)' : 'ilki kullanılır');
  const startsPast = !!range && !past && !draft.weekly && !!now && range.start < now;
  // Aynı saatlerdeki kilitli pencereler (her gün tekrar edenler bir kez)
  const overl = range ? [...new Set(visible.filter(it => !it.ev && !it.point && it.start < range.end && it.end > range.start)
    .map(o => `«${o.title}» (${SRC_LABEL(o.src)})`))].slice(0, 4) : [];
  const binds = localB.filter(b => b.tag === draft.tag);
  const pq = (b: Binding) => range
    ? `profile=${b.profile_id}&priority=${b.priority}&start=${encodeURIComponent(iso(range.start))}&end=${encodeURIComponent(iso(range.end))}` : '';
  const showPreview = !!range && !rangeErrs.length;
  const previewReady = showPreview && binds.length > 0 && binds.every(b => ready[b.id] === pq(b));
  // Saat seçenekleri: 15 dk; o gün yaz saatinde olmayanlar seçilemez, iki kez yaşananlar bir kez. 15 dk dışındaki mevcut saat
  // (Takvim kuralları formunda serbest dakikayla girilmiş etkinlik) kendi seçeneğiyle görünür — sessizce yuvarlanmaz.
  const times = (day: Ymd | null, cur: number) => {
    const mins = Array.from({ length: SLOTS }, (_, i) => i * STEP_MIN);
    if (cur % STEP_MIN) mins.splice(Math.ceil(cur / STEP_MIN), 0, cur);
    return mins.map(m => {
      const n = day ? wallInstants(day, m, tz).length : 1;
      return <option key={m} value={String(m)} disabled={n === 0}>{fmtMin(m)}{n === 0 ? ' (yok)' : n > 1 ? ' (iki kez)' : ''}</option>;
    });
  };
  const trap = (e: KeyboardEvent<HTMLDivElement>) => {
    // Esc: açık liste (Select) kendisi kapanır (defaultPrevented); değilse pencere — yazma yok
    if (e.key === 'Escape') { if (!e.defaultPrevented) onCancel(); return; }
    if (e.key !== 'Tab' || !boxRef.current) return;
    const els = [...boxRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')].filter(x => x.offsetParent !== null);
    if (!els.length) return;
    const first = els[0], lastEl = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
  };
  // Örtük gönderim (başlıkta Enter) de Kaydet'in koşullarından geçer: önizleme görünmeden kayıt yok
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (titleErr) { setTouched(true); firstRef.current?.focus(); return; }
    if (range && body && !errs.length && !unchanged && previewReady) void onSave(body, draft.id, range.start);
  };
  const head = draft.id === null ? 'Profil bağla' : 'Panel etkinliği';
  return (
    <div className="modal-backdrop agg-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-container agg-dialog" role="dialog" aria-modal="true" aria-labelledby="agg-dlg-h" ref={boxRef} onKeyDown={trap}>
        <div className="modal-header">
          <h3 id="agg-dlg-h">{head}</h3>
          <button className="icon-btn" onClick={onCancel} aria-label="Vazgeç ve kapat"><X size={16} /></button>
        </div>
        <form className="modal-body agg-form" onSubmit={submit} id="agg-form">
          {!engineOn && (
            <div className="ag-alert is-warn agg-off-band" role="note"><AlertTriangle size={14} />
              <span><b>Takvim kuralları motoru kapalı — etkisiz.</b> Kaydedilir ama motor açılana dek uygulanmaz; bu pencere motoru açmaz.</span>
            </div>
          )}
          {range && (
            <p className="agg-summary">
              <b>{f.full(range.start)}</b> – <b>{f.full(range.end)}</b> · {durText(dur)} <span className="agg-muted">({tz})</span>
              {draft.weekly && <><br /><Repeat size={12} /> Her hafta aynı saatte{until !== null ? `, son gün ${f.dayLong(uDay!)}` : ''}{ev?.weekly && !unchanged ? ' — bütün tekrarlar birlikte değişir' : ''}</>}
            </p>
          )}
          <div className="agg-fgrid">
            <label className="agg-wide">Başlık<input ref={firstRef} className="config-input" value={draft.title} maxLength={80} placeholder="ör. Oyun Odası tam izin"
              aria-invalid={touched && !!titleErr} onChange={e => { setTouched(true); set({ title: e.target.value }); }} /></label>
            <label className="agg-wide">Profil (etiket bağlaması)
              <Select className="config-input" value={draft.tag} onChange={e => set({ tag: e.target.value })} columns={['text', 'muted']} aria-label="Profil">
                {!localTags.includes(draft.tag) && <option value={draft.tag}>{draft.tag ? `#${draft.tag} (panel etkinliğine bağlı değil)` : 'Profil seçin'}</option>}
                {localTags.map(t => <SelectOption key={t} value={t} cols={[localB.filter(b => b.tag === t).map(b => pname(b.profile_id)).join(', '), `#${t}`]} />)}
              </Select>
            </label>
            <label>Başlangıç günü<input className="config-input" type="date" value={draft.sDate} onChange={e => set({ sDate: e.target.value })} /></label>
            <label>Başlangıç saati
              <Select className="config-input" value={String(draft.sMin)} onChange={e => set({ sMin: Number(e.target.value) })} aria-label="Başlangıç saati">{times(sDay, draft.sMin)}</Select>
            </label>
            <label>Bitiş günü<input className="config-input" type="date" value={draft.eDate} onChange={e => set({ eDate: e.target.value })} /></label>
            <label>Bitiş saati
              <Select className="config-input" value={String(draft.eMin)} onChange={e => set({ eMin: Number(e.target.value) })} aria-label="Bitiş saati">{times(eDay, draft.eMin)}</Select>
            </label>
          </div>
          <div className="agg-checks" role="radiogroup" aria-label="Tekrar">
            <label><input type="radio" name="agg-rep" checked={!draft.weekly} onChange={() => set({ weekly: false })} /> Tek sefer</label>
            <label><input type="radio" name="agg-rep" checked={draft.weekly} onChange={() => set({ weekly: true })} /> Her hafta</label>
            {draft.weekly && <label className="agg-until">son gün (isteğe bağlı) <input className="config-input" type="date" value={draft.until} onChange={e => set({ until: e.target.value })} /></label>}
          </div>
          <p className="agg-muted">
            Profil, etiketi panel etkinliğine açık bir bağlamadan gelir.{' '}
            <button type="button" className="agg-linkbtn" onClick={() => { onCancel(); scrollToSel('.cr-panel'); }}>Yeni profil / bağlama (Takvim kuralları)</button>
            {' '}En uzun süre {maxDays} gün{draft.weekly ? `, haftalıkta ${WEEKLY_MAX_MIN / 1440} gün` : ''}; takvim cihazın kotasını ve hız sınırını kaldıramaz.
          </p>
          {twiceS && <div className="ag-alert is-warn"><Info size={13} /><span>Başlangıç saati yaz saati geçişinde iki kez yaşanıyor: {passOf(sTs, range?.start)}.</span></div>}
          {twiceE && <div className="ag-alert is-warn"><Info size={13} /><span>Bitiş saati yaz saati geçişinde iki kez yaşanıyor: {passOf(eTs, range?.end)}.</span></div>}
          {dstShift && <div className="ag-alert is-warn"><AlertTriangle size={13} /><span>Bu aralık yaz saati geçişini içeriyor: haftalık tekrarda süre sabit ({durText(dur)}) olduğu için diğer haftalarda bitiş saati 1 saat kayar.</span></div>}
          {startsPast && <div className="ag-alert is-warn"><Info size={13} /><span>Başlangıç saati geçmişte: aralık şimdiden sürüyor sayılır — kaydedilince hemen etkili olur.</span></div>}
          {shownErrs.map(x => <div key={x} className="ag-alert is-error" role="alert"><AlertTriangle size={13} /><span>{x}</span></div>)}
          {overl.length > 0 && (
            <p className="agg-muted">Aynı saatlerde (kilitli): {overl.join(', ')}</p>
          )}
          {showPreview && binds.map(b => (
            <PreviewBox key={b.id} query={pq(b)} onReady={q => setReady(m => (m[b.id] === q ? m : { ...m, [b.id]: q }))} />
          ))}
        </form>
        <div className="modal-actions agg-actions">
          {ev && <button type="button" className="btn-outline btn-sm agg-off agg-del" disabled={busy} onClick={() => void onDelete(ev, draft.occ ?? draft.sT ?? now)}><Trash2 size={13} /> Sil</button>}
          <button type="button" className="btn-outline btn-sm" onClick={onCancel}>Vazgeç</button>
          <button type="submit" form="agg-form" className="btn-primary btn-sm agg-on" disabled={busy || !!errs.length || !body || unchanged || !previewReady}>
            {busy ? <Loader2 size={13} className="spin" /> : null}{unchanged ? 'Değişiklik yok' : 'Kaydet'}
          </button>
        </div>
      </div>
    </div>
  );
}
