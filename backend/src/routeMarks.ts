// Yönlendirme işaretleri (fwmark; VPS işaretinde aynı zamanda ip rule tablo numarası). v2.24.55 şeması, v2.24.75'te
// yalnız-DPI işareti 200 → 0x4000:
//   0             → ISP (işaretsiz)
//   0x4000        → ISP + DPI (kural/tablo yok). Zapret liste yerine bu bite bakar (config FILTER_MARK=0x4000):
//                   işaretli trafik modemden (IFACE_WAN) çıkarken nfqws'ten geçer.
//   0x8000 | id   → wg_vps<id> tüneli (id 1–4095; 0x1000 yedek tünel bitine yer açılana dek 8191'di)
//     + 0x4000    → DPI de istendi: tünel çalışırken etkisiz (trafik wg'den çıkar, Zapret yalnız modem çıkışına bakar);
//                   tünel düşüp operatörden devam edilirse (0x2000) trafik modemden DPI ile çıkar
//     + 0x2000    → tünel yoksa / yanıt vermiyorsa operatörden devam; bit yoksa ENGELLE (tabloda kalıcı unreachable)
//     + 0x1000    → YEDEK TÜNEL: alt 12 bit VPS kimliği değil YUVA numarası. Yuva = (ana VPS, yedek VPS ya da 0 =
//                   otomatik) çifti (routeSlots.ts, routing_slots tablosu — kalıcı, silinmez). Ana tünel yoksa tablo yedeğe
//                   yönelir (system.ts syncMarkTable); o da yoksa 0x2000'e göre engelle / operatör.
// Panel işaretin yalnız alt 16 bitini yazar (ROUTE_MARK_MASK): üst bitler Zapret'indir (0x40000000 kendi paketleri,
// 0x20000000 POSTNAT, bağlantı işaretinde de) — tamamını ezmek Zapret'in döngü korumasını bozardı.
//   0x10000 (LEARN_MARK_BIT, v2.24.80) → alt 16 biti 0 olan (panelin yönlendirmediği, modemden çıkan) web trafiği: Zapret'in
//                   otomatik listesi (autohostlist) engeli algılayabilsin diye nfqws'e gider; atlatma yalnız listedeki /
//                   öğrenilen sitelere. Alt 16 bitin dışında: sayaçlar, ip rule'lar ve bağlantı işareti etkilenmez.
// Eski şema (≤ v2.24.54): 100+id tünel, 300+id tünel + DPI — id ≥ 100'de 200 ve 300+id ile çakışıyordu, tünel düşünce
// ne olacağını da taşımıyordu. Sayaçlar (topology.ts) ve geçiş (system.ts) için hâlâ çözülür.
export const VPS_MARK_BIT = 0x8000;
export const DPI_MARK_BIT = 0x4000;
export const DPI_ONLY_MARK = DPI_MARK_BIT;
// v2.24.55–74'ün yalnız-DPI işareti: seti (rt_m200) geçişte yenisine kopyalanır, sayaçlarda tanınır.
export const LEGACY_DPI_ONLY_MARK = 200;
export const ROUTE_MARK_MASK = 0xffff;
export const LEARN_MARK_BIT = 0x10000;
// Zapret config FILTER_MARK: DPI kuralı ya da öğrenme işareti taşıyan paket nfqws'e gider.
export const ZAPRET_FILTER_MARK = DPI_MARK_BIT | LEARN_MARK_BIT;
export const ISP_FALLBACK_BIT = 0x2000;
export const TUNNEL_FALLBACK_BIT = 0x1000;
export const VPS_ID_MAX = 0x0fff;

// Kural başına, tünel düşünce: engelle (varsayılan), operatörden devam, başka tünelden (yoksa engelle / yoksa operatörden).
export type VpsFallback = 'block' | 'isp' | 'tunnel' | 'tunnel-isp';
export const normFallback = (v: unknown): VpsFallback => (v === 'isp' || v === 'tunnel' || v === 'tunnel-isp' ? v : 'block');
export const tunnelFallback = (f: VpsFallback) => f === 'tunnel' || f === 'tunnel-isp';
export const ispFinal = (f: VpsFallback) => f === 'isp' || f === 'tunnel-isp';
// Yedek tünel: 0 = otomatik (çalışan ilk tünel), n = o VPS ('' / 'auto' / geçersiz → 0)
export const normBackup = (v: unknown): number => {
  const s = String(v ?? '').trim();
  return /^\d{1,4}$/.test(s) && Number(s) >= 1 && Number(s) <= VPS_ID_MAX ? Number(s) : 0;
};

// Yuva kaydı (yuva → ana / yedek): routeSlots.ts veritabanından doldurur; işaret üretimi ve çözümü (sayaçlar dahil) okur.
const slots = new Map<number, { primary: number; backup: number }>();
const slotOfPair = new Map<string, number>();
export function setRouteSlots(rows: { slot: number; primary_id: number; backup_id: number }[]): void {
  slots.clear();
  slotOfPair.clear();
  for (const r of rows) {
    const slot = Number(r.slot), primary = Number(r.primary_id), backup = Number(r.backup_id);
    if (!Number.isInteger(slot) || slot < 1 || slot > VPS_ID_MAX) continue;
    slots.set(slot, { primary, backup });
    slotOfPair.set(`${primary}:${backup}`, slot);
  }
}
export const routeSlotFor = (primary: number, backup: number): number | null => slotOfPair.get(`${primary}:${backup}`) ?? null;

// exitNode: 'isp' ya da VPS kimliği ('7'). Geçersiz / aralık dışı kimlik ISP sayılır (null döner: çağıran günlüğe yazar).
// Yedek tünelli kuralın yuvası henüz yoksa (beklenmez: routeSlots önce hazırlar) yedeksiz işaret verilir — son seçimle
// (engelle / operatör) aynı davranır, trafik sızmaz.
export function encodeRouteMark(exitNode: string, dpi: boolean, fallback: VpsFallback, backup = 0): number | null {
  if (exitNode === 'isp') return dpi ? DPI_ONLY_MARK : 0;
  const id = /^\d{1,10}$/.test(exitNode) ? Number(exitNode) : NaN;
  if (!Number.isInteger(id) || id < 1 || id > VPS_ID_MAX) return null;
  const base = VPS_MARK_BIT | (dpi ? DPI_MARK_BIT : 0) | (ispFinal(fallback) ? ISP_FALLBACK_BIT : 0);
  if (tunnelFallback(fallback)) {
    const slot = routeSlotFor(id, backup === id ? 0 : backup);
    if (slot !== null) return base | TUNNEL_FALLBACK_BIT | slot;
  }
  return base | id;
}

// backup: null = yedek tünel yok; 0 = otomatik; n = o VPS
export interface VpsMark { vpsId: number; dpi: boolean; ispFallback: boolean; backup: number | null }
export function decodeVpsMark(mark: number): VpsMark | null {
  if (!Number.isInteger(mark) || mark < 0 || mark > 0xffff || !(mark & VPS_MARK_BIT)) return null;
  const low = mark & VPS_ID_MAX;
  if (!low) return null;
  const dpi = !!(mark & DPI_MARK_BIT);
  const ispFallback = !!(mark & ISP_FALLBACK_BIT);
  if (mark & TUNNEL_FALLBACK_BIT) {
    const s = slots.get(low);
    return s ? { vpsId: s.primary, dpi, ispFallback, backup: s.backup } : null;
  }
  return { vpsId: low, dpi, ispFallback, backup: null };
}

// İşaretin trafiği hangi tünelden çıkar: ana tünel kullanılabilirse o; değilse yedek tünel (kural istediyse) — seçilen VPS
// ya da otomatikte kullanılabilir ilk aday (ids: system.ts vpsTunnelIds — interneti taşıyan tüneller, kimliğe göre artan);
// hiçbiri yoksa null (tablonun son seçimi: engelle / operatör). usable: arayüz var ve "yanıt vermiyor" onaylanmamış.
export function pickMarkTunnel(v: VpsMark, usable: (id: number) => boolean, ids: () => number[]): number | null {
  if (usable(v.vpsId)) return v.vpsId;
  if (v.backup === null) return null;
  if (v.backup > 0) return v.backup !== v.vpsId && usable(v.backup) ? v.backup : null;
  return ids().find(id => id !== v.vpsId && usable(id)) ?? null;
}

// Eski şemanın VPS işareti (100+id / 300+id, id 1–99; 200–299 aralığı DPI ile çakıştığı için tanınmaz).
export function decodeLegacyVpsMark(mark: number): { vpsId: number; dpi: boolean } | null {
  if (mark >= 101 && mark <= 199) return { vpsId: mark - 100, dpi: false };
  if (mark >= 301 && mark <= 399) return { vpsId: mark - 300, dpi: true };
  return null;
}

// Panelin yönettiği "fwmark N lookup N" kuralları: yeni şemanın VPS işaretleri (yuvası henüz bilinmeyenler dahil — eski
// kurallar temizlenebilsin) ve eski şemanın 100–999 aralığı.
export const isManagedRuleMark = (mark: number) =>
  (Number.isInteger(mark) && mark > 0 && mark <= 0xffff && !!(mark & VPS_MARK_BIT) && (mark & VPS_ID_MAX) !== 0) || (mark >= 100 && mark <= 999);
