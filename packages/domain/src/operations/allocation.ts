// Sipariş satırı tahsis önerisi (T-306; A-138; ADR-009 sert tahsis; 16 kural 5 ve 9). SAF: veritabanı, saat, rastgelelik yok.
//
// A-138: takip modu NONE'da, kullanılabilir miktarı yeterli olan EN AZ SAYIDA boyut; eşitlikte lokasyon kodu artan.
//   1. Tek boyut yetiyorsa (available ≥ ihtiyaç): yetenler arasında lokasyon kodu en küçük olan (tek boyut = en az sayıda).
//   2. Hiçbiri tek başına yetmiyorsa: en çok kullanılabilirden başlayarak (eşitlikte lokasyon kodu artan) en az sayıda boyutla kapat; toplam
//      yetmezse bulunan kadar önerilir (kalan satırda tahsissiz açık kalır — ret değil).
// Aday olmayanlar (elenir): stok durumu AVAILABLE dışı (KABUL·KAR/QUARANTINE, DAMAGED, BLOCKED), lokasyon türü STORAGE/STAGING dışı (RECEIVING dahil),
// `pick_blocked` lokasyon (kural 9), sayımda (COUNTING) lokasyon, kullanılabilir ≤ 0 ve takipli (lot/seri) boyut (A-138 yalnızca NONE'u tanımlar;
// takipli ürün için öneri yoktur, elle tahsis gerekir — A-306-5).
// Öneri bir TAVSİYEDİR: asıl denetim kilit altında `allocateInTx`'tedir (kural 5 süzgeci ve yeterlilik orada yeniden uygulanır).
import type { StockDimensionKey } from "@wms/db";
import { dimensionIdentity } from "../stock/plan.ts";

export interface AllocationCandidate {
  readonly key: StockDimensionKey;
  readonly locationCode: string;
  readonly locationKind: string;
  readonly pickBlocked: boolean;
  /** Lokasyon sayımda (`location_count_locks.status = COUNTING`). */
  readonly counting: boolean;
  /** quantity − reserved, 1e-6 ölçekli tam sayı (negatif olabilir). */
  readonly available: bigint;
}

export interface SuggestedAllocation {
  readonly key: StockDimensionKey;
  /** 1e-6 ölçekli, pozitif. */
  readonly qty: bigint;
}

/** Aday süzgeci (saf; bkz. dosya başı). */
export function isAllocationCandidate(c: AllocationCandidate): boolean {
  return (
    c.key.stockStatus === "AVAILABLE" &&
    (c.locationKind === "STORAGE" || c.locationKind === "STAGING") &&
    !c.pickBlocked &&
    !c.counting &&
    c.available > 0n &&
    c.key.lotId === null &&
    c.key.serialId === null
  );
}

const byCode = (a: AllocationCandidate, b: AllocationCandidate): number =>
  a.locationCode < b.locationCode ? -1 : a.locationCode > b.locationCode ? 1 : dimensionIdentity(a.key) < dimensionIdentity(b.key) ? -1 : dimensionIdentity(a.key) > dimensionIdentity(b.key) ? 1 : 0;

/** `need` (1e-6 ölçekli, > 0) için A-138 önerisi; aday yoksa ya da `need ≤ 0` ise boş liste. */
export function suggestAllocation(candidates: readonly AllocationCandidate[], need: bigint): SuggestedAllocation[] {
  if (need <= 0n) return [];
  const pool = candidates.filter(isAllocationCandidate);
  const single = pool.filter((c) => c.available >= need).sort(byCode)[0];
  if (single !== undefined) return [{ key: single.key, qty: need }];
  const ordered = [...pool].sort((a, b) => (a.available === b.available ? byCode(a, b) : a.available > b.available ? -1 : 1));
  const out: SuggestedAllocation[] = [];
  let left = need;
  for (const c of ordered) {
    if (left === 0n) break;
    const take = c.available < left ? c.available : left;
    out.push({ key: c.key, qty: take });
    left -= take;
  }
  return out;
}
