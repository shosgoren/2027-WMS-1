-- T-284: restore sonrası bağımsız stok tutarlılık sorgusu (YALNIZCA OKUMA; yazma ifadesi yok).
-- Stok komutlarından bağımsız yazılmıştır (domain koduna dayanmaz): defter = bakiye, rezervasyon = bakiye.reserved.
-- Çıktı: tek `SC:` satırı, yalnızca SAYILAR (kimlik, miktar, tenant, kişisel veri yok; G-09).
-- Satır düzeyi güvenliği atlayan sahip rolü gerekir (aksi 0 satır görünür): `rls_bypass=false` ise sonuç KULLANILAMAZ.
-- Tutarlılık kriteri "boyut" (stock_dimensions: tenant/ürün/lokasyon/durum/lot/seri/sahip/taşıma birimi) başına yapılır;
-- bu, tenant/ürün/lokasyon/durum kırılımından daha incedir (daha sıkı).
-- Not: bu dosya transaction sarmalayıcısı İÇERMEZ; çağıran `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` ile sarar.
WITH l AS (
  SELECT sl.tenant_id, sl.stock_dimension_id AS d, sum(sl.quantity) AS q FROM public.stock_ledger sl GROUP BY 1, 2
), b AS (
  SELECT bb.tenant_id, bb.stock_dimension_id AS d, bb.quantity AS q, bb.reserved_quantity AS r FROM public.stock_balances bb
), r AS (
  SELECT rr.tenant_id, rr.stock_dimension_id AS d, sum(rr.quantity) AS q FROM public.reservations rr WHERE rr.status = 'ACTIVE' GROUP BY 1, 2
)
SELECT 'SC:' || json_build_object(
  'rls_bypass', (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user),
  'dimensions', (SELECT count(*) FROM public.stock_dimensions),
  'balances', (SELECT count(*) FROM b),
  'ledger_rows', (SELECT count(*) FROM public.stock_ledger),
  'ledger_ne_balance', (SELECT count(*) FROM l FULL OUTER JOIN b ON l.tenant_id = b.tenant_id AND l.d = b.d
                         WHERE coalesce(l.q, 0) <> coalesce(b.q, 0)),
  'reservations_ne_reserved', (SELECT count(*) FROM r FULL OUTER JOIN b ON r.tenant_id = b.tenant_id AND r.d = b.d
                                WHERE coalesce(r.q, 0) <> coalesce(b.r, 0)),
  'reserved_gt_quantity', (SELECT count(*) FROM b WHERE b.r > b.q),
  'negative_quantity', (SELECT count(*) FROM b WHERE b.q < 0),
  'negative_reserved', (SELECT count(*) FROM b WHERE b.r < 0)
)::text;
