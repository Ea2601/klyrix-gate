// Ağ Ajandası'nın liste (AgendaPanel.tsx) ve ızgara (AgendaGrid.tsx, ayrı tembel parça) görünümlerinin ortak tipleri ve
// sabitleri; takvim kayıtları değişince aynı sayfadaki bölümlerin (ızgara, Takvim kuralları) birbirini yenilemesi.
import { BANDWIDTH_TAB_KEY, MAINTENANCE_TAB_KEY } from '../nav';
import type { TabId } from '../types';

// GET /api/agenda (backend agenda.ts) öğeleri
export type Source = 'parental' | 'traffic' | 'cron' | 'system' | 'vault' | 'speedtest' | 'quota' | 'zapret' | 'calendar';
// sub: sayfanın açılacak alt sekmesi (tek seferlik oturum anahtarıyla)
export interface AgendaLink { tab: TabId; sub?: string }
export interface AgendaItem {
  id: string; source: Source; title: string; start: string; end: string | null; kind: 'window' | 'job' | 'reset';
  approx: boolean; link: AgendaLink | null; note?: string; since?: boolean;
  // Yalnız dış takvim öğelerinde: etiketler, takvimin adı / rengi, tüm gün, çözülemedi nedeni (tz | rrule | limit | time)
  tags?: string[]; calendar?: string; color?: string; allDay?: boolean; unresolved?: string;
}

// Kaynağın kısa etiketi (renk: AgendaPanel.css --agenda-<kaynak>)
export const TAG: Record<Source | 'panel', string> = {
  parental: 'Ebeveyn', traffic: 'Trafik', cron: 'Cron', system: 'Sistem', vault: 'Bulut yedeği', speedtest: 'Hız testi',
  quota: 'Kota', zapret: 'Zapret', calendar: 'Takvim', panel: 'Panel',
};
// Alt sekmeyi açan tek seferlik anahtarlar (BandwidthPanel / SystemLogs açılışta okuyup siler)
export const SUB_KEYS: Partial<Record<TabId, string>> = { bandwidth: BANDWIDTH_TAB_KEY, maintenance: MAINTENANCE_TAB_KEY };

// Takvim kaydı değişti (yerel etkinlik, profil, bağlama, motor, takvim bağlantısı): aynı sayfadaki diğer bölümler yeniden
// okur. from: yazan bölüm (kendi yazdığını zaten yeniden okuduğu için yok sayar).
export const CALENDAR_CHANGED = 'klx-calendar-changed';
export type CalendarFrom = 'grid' | 'rules' | 'sources' | 'refresh';
export function emitCalendarChanged(from: CalendarFrom): void {
  try { window.dispatchEvent(new CustomEvent<CalendarFrom>(CALENDAR_CHANGED, { detail: from })); } catch { /* olay yok: bölümler kendi yoklamasıyla yenilenir */ }
}
export function onCalendarChanged(fn: (from: CalendarFrom) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<CalendarFrom>).detail);
  window.addEventListener(CALENDAR_CHANGED, h);
  return () => window.removeEventListener(CALENDAR_CHANGED, h);
}
