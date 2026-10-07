-- 0026_task_progress (T-293, ADR-025 §1; ADR-015 §5 şablonu; G-08 genişlet–taşı–daralt): rehberli saha akışında görev adım ilerlemesi.
-- Yeni tablo `warehouse_task_progress`: görev başına TEK satır (PK (tenant_id, task_id)); doğrulanmış adım, doğrulanmış hedef lokasyon/ürün,
-- girilen miktar ve kayıt (Kaydet) istemci anahtarı. YALNIZCA genişletme: mevcut tablo/sütun/veri/yetki değişmez, taşınacak veri yok.
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * İlerleme STOK DEĞİLDİR (G-01): stok/defter/görev tablolarına yazmaz, bunlara tetikleyici bağlamaz, audit üretmez (ADR-025 §4; I-12 kapsamı dışı).
--   "Kaydedildi" durumu YOKTUR; tamamlandı = görevin DONE olması (ADR-021 §6). `step = 'SAVING'` yalnızca "kayıt anahtarı verildi" demektir.
-- * `step` yalnızca sıradaki BEKLENEN adımdır; satır ilk doğrulanan adımla doğar (ilk adım = ürün okutma → satır yok = SCAN_ITEM).
--   Tutarlılık DB'de CHECK ile zorlanır: ürün her satırda dolu; ENTER_QUANTITY+ hedef lokasyon dolu; CONFIRM+ miktar dolu;
--   save_client_key ⇔ SAVING. Kaynak raf/miktar kararı domain'dedir (görevle birebir, A-305-7/A-305-8).
-- * `membership_id` oturumdan türetilir (domain); DB yalnızca bileşik FK ile aynı tenant'ın üyeliği olmasını zorlar. Atanan denetimi ve
--   "atama değişti / görev DONE-CANCELLED → ilerleme geçersiz" kuralı domain'dedir (okuma sırasında yok sayılır + ilerleme yazımında/`nextTaskFor`'da silinir).
--   `task_version` = satır doğarken görevin sürümüdür: görev sürümü her atama/iptal/tamamlama/lokasyon değişiminde artar (0017 tetikleyicisi),
--   bu yüzden A → B → A yeniden atamasında eski ilerleme DÖNMEZ (sürüm eşleşmez); geçerlilik = görev ASSIGNED + atanan = üyelik + sürüm eşit;
--   tenant RLS tek politikadır (üyelik başına RLS yoktur: `app.current_membership_id` ayarı bu kod tabanında yok).
-- * 0010-0017 deseni: tenant_id NOT NULL, ENABLE + FORCE RLS, tek PERMISSIVE USING + WITH CHECK tenant politikası, FK'lerin hepsi (tenant_id, …)
--   BİLEŞİK ve NO ACTION, PUBLIC'e hiçbir şey. wms_app: SELECT + DELETE (tablo) ve sütun düzeyi INSERT/UPDATE (kimlik sütunları UPDATE'te YOK).
--   Diğer roller (wms_auth, wms_ops, wms_worker, wms_identity_probe, … ve PUBLIC) hiçbir yetki almaz; bu migration sonunda doğrulanır.
-- * Miktar numeric(20,6) (I-09); float yok. Tablo büyümesi: tamamlanan/iptal görev satırları domain'de silinir; kalıcı geçmiş tutulmaz (ADR-025).
-- Koşturucu tek transaction içinde çalıştırır.

DO $pre$
BEGIN
  IF pg_catalog.to_regclass('public.warehouse_tasks') IS NULL
     OR pg_catalog.to_regclass('public.locations') IS NULL
     OR pg_catalog.to_regclass('public.items') IS NULL
     OR pg_catalog.to_regclass('public.tenant_memberships') IS NULL
     OR pg_catalog.to_regclass('public.tenants') IS NULL THEN
    RAISE EXCEPTION '0026_task_progress: 0003 / 0010 / 0011 / 0017 önkoşulu yok';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_app') THEN
    RAISE EXCEPTION '0026_task_progress: wms_app rolü yok (altyapı adımı)';
  END IF;
END
$pre$;

CREATE TABLE public.warehouse_task_progress (
  tenant_id       uuid           NOT NULL,
  task_id         uuid           NOT NULL,
  membership_id   uuid           NOT NULL,
  task_version    integer        NOT NULL,
  step            text           NOT NULL,
  location_id     uuid,
  item_id         uuid           NOT NULL,
  quantity        numeric(20, 6),
  save_client_key uuid,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT warehouse_task_progress_pkey PRIMARY KEY (tenant_id, task_id),
  CONSTRAINT warehouse_task_progress_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT warehouse_task_progress_task_fkey FOREIGN KEY (tenant_id, task_id) REFERENCES public.warehouse_tasks (tenant_id, id),
  CONSTRAINT warehouse_task_progress_membership_fkey FOREIGN KEY (tenant_id, membership_id) REFERENCES public.tenant_memberships (tenant_id, id),
  CONSTRAINT warehouse_task_progress_location_fkey FOREIGN KEY (tenant_id, location_id) REFERENCES public.locations (tenant_id, id),
  CONSTRAINT warehouse_task_progress_item_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items (tenant_id, id),
  CONSTRAINT warehouse_task_progress_task_version_chk CHECK (task_version >= 1),
  CONSTRAINT warehouse_task_progress_step_chk CHECK (step IN ('SCAN_TARGET', 'ENTER_QUANTITY', 'CONFIRM', 'SAVING')),
  CONSTRAINT warehouse_task_progress_location_chk CHECK (step = 'SCAN_TARGET' OR location_id IS NOT NULL),
  CONSTRAINT warehouse_task_progress_quantity_chk CHECK (
    (step IN ('SCAN_TARGET', 'ENTER_QUANTITY') AND quantity IS NULL) OR (step IN ('CONFIRM', 'SAVING') AND quantity IS NOT NULL AND quantity > 0)
  ),
  CONSTRAINT warehouse_task_progress_save_key_chk CHECK ((step = 'SAVING') = (save_client_key IS NOT NULL))
);
CREATE INDEX warehouse_task_progress_tenant_membership_idx ON public.warehouse_task_progress (tenant_id, membership_id);

ALTER TABLE public.warehouse_task_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_task_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouse_task_progress_isolation ON public.warehouse_task_progress
  USING      (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid);
REVOKE ALL ON TABLE public.warehouse_task_progress FROM PUBLIC;

-- Yalnızca wms_app; kimlik sütunları (tenant_id, task_id, created_at) UPDATE listesinde yok.
GRANT SELECT, DELETE ON public.warehouse_task_progress TO wms_app;
GRANT INSERT (tenant_id, task_id, membership_id, task_version, step, location_id, item_id, quantity, save_client_key) ON public.warehouse_task_progress TO wms_app;
GRANT UPDATE (step, location_id, quantity, save_client_key, updated_at) ON public.warehouse_task_progress TO wms_app;

-- Doğrulama: RLS, tek politika, wms_app yalnız DML, başka hiçbir rol/PUBLIC yetkisi yok.
DO $verify$
DECLARE
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = 'public.warehouse_task_progress'::pg_catalog.regclass AND c.relrowsecurity AND c.relforcerowsecurity) THEN
    RAISE EXCEPTION '0026_task_progress: warehouse_task_progress için RLS ENABLE+FORCE yok';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid = 'public.warehouse_task_progress'::pg_catalog.regclass) <> 1 THEN
    RAISE EXCEPTION '0026_task_progress: warehouse_task_progress için tam bir politika beklenir';
  END IF;
  IF NOT pg_catalog.has_table_privilege('wms_app', 'public.warehouse_task_progress', 'SELECT')
     OR NOT pg_catalog.has_table_privilege('wms_app', 'public.warehouse_task_progress', 'DELETE')
     OR NOT pg_catalog.has_any_column_privilege('wms_app', 'public.warehouse_task_progress', 'INSERT')
     OR NOT pg_catalog.has_any_column_privilege('wms_app', 'public.warehouse_task_progress', 'UPDATE')
     OR pg_catalog.has_table_privilege('wms_app', 'public.warehouse_task_progress', 'TRUNCATE')
     OR pg_catalog.has_table_privilege('wms_app', 'public.warehouse_task_progress', 'REFERENCES')
     OR pg_catalog.has_table_privilege('wms_app', 'public.warehouse_task_progress', 'TRIGGER')
     OR pg_catalog.has_column_privilege('wms_app', 'public.warehouse_task_progress', 'task_id', 'UPDATE')
     OR pg_catalog.has_column_privilege('wms_app', 'public.warehouse_task_progress', 'tenant_id', 'UPDATE') THEN
    RAISE EXCEPTION '0026_task_progress: wms_app yetkileri beklenenden farklı (yalnız SELECT/INSERT/UPDATE/DELETE)';
  END IF;
  -- Tablo sahibi (migration rolü) ve süper kullanıcılar örtük olarak her yetkiye sahiptir; denetim yalnızca onların dışındaki wms_* rollerine bakar.
  FOR r IN
    SELECT ro.rolname FROM pg_catalog.pg_roles ro
     WHERE ro.rolname LIKE 'wms\_%' AND ro.rolname <> 'wms_app' AND NOT ro.rolsuper
       AND ro.oid <> (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.warehouse_task_progress'::pg_catalog.regclass)
  LOOP
    IF pg_catalog.has_table_privilege(r.rolname, 'public.warehouse_task_progress', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       OR pg_catalog.has_any_column_privilege(r.rolname, 'public.warehouse_task_progress', 'SELECT, INSERT, UPDATE, REFERENCES') THEN
      RAISE EXCEPTION '0026_task_progress: % rolü warehouse_task_progress üzerinde yetki taşıyor', r.rolname;
    END IF;
  END LOOP;
  IF EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c, LATERAL pg_catalog.aclexplode(c.relacl) a
        WHERE c.oid = 'public.warehouse_task_progress'::pg_catalog.regclass AND a.grantee = 0) THEN
    RAISE EXCEPTION '0026_task_progress: PUBLIC warehouse_task_progress üzerinde yetki taşıyor';
  END IF;
END
$verify$;
