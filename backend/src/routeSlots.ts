// Yedek tünelli yönlendirme kurallarının işaret yuvaları (routeMarks.ts TUNNEL_FALLBACK_BIT): yuva = (ana VPS, yedek VPS ya
// da 0 = otomatik) çifti; işaretin alt 12 biti yuva numarasıdır, aynı yuvanın tablosu (system.ts syncMarkTable) ana tünel
// düşünce yedeğe yönelir. Kalıcı (routing_slots): bir yuva hiç silinmez ve başka bir çifte verilmez — açık bağlantıların
// işareti (conntrack) yeniden başlatmadan / kural değişikliğinden sonra da aynı çifti gösterir. Yedeğe girmez: her cihaz
// kendi yuvalarını kural uygulanırken üretir. En çok 4095 yuva.
import { dbAll, dbRun } from './db';
import { setRouteSlots, VPS_ID_MAX } from './routeMarks';

interface SlotRow { slot: number; primary_id: number; backup_id: number }

let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  tableReady ??= dbRun(`CREATE TABLE IF NOT EXISTS routing_slots (
    slot INTEGER PRIMARY KEY, primary_id INTEGER NOT NULL, backup_id INTEGER NOT NULL, UNIQUE (primary_id, backup_id))`)
    .catch(e => { tableReady = null; throw e; });
  return tableReady;
}

// Kuralların istediği çiftlere yuva verir (yoksa) ve tüm yuvaları işaret kaydına yükler.
export async function prepareRouteSlots(pairs: { primary: number; backup: number }[]): Promise<void> {
  await ensureTable();
  const rows = await dbAll('SELECT slot, primary_id, backup_id FROM routing_slots') as SlotRow[];
  const have = new Set(rows.map(r => `${r.primary_id}:${r.backup_id}`));
  const used = new Set(rows.map(r => Number(r.slot)));
  let next = 1;
  let added = false;
  for (const p of pairs) {
    const key = `${p.primary}:${p.backup}`;
    if (have.has(key)) continue;
    while (used.has(next)) next++;
    if (next > VPS_ID_MAX) {
      console.error('[routing] yedek tünel yuvası kalmadı — kural yedeksiz (son seçimiyle) uygulanır');
      break;
    }
    await dbRun('INSERT OR IGNORE INTO routing_slots (slot, primary_id, backup_id) VALUES (?, ?, ?)', [next, p.primary, p.backup]);
    used.add(next);
    have.add(key);
    added = true;
  }
  setRouteSlots(added ? await dbAll('SELECT slot, primary_id, backup_id FROM routing_slots') as SlotRow[] : rows);
}
