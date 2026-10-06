-- 0014_reliability (T-211, ADR-019 §1-§2, §8-§10; ADR-016 §9; I-14): kuyruk tüketici tekilleştirme tablosu, tutarlılık sonuç ve
-- platform sinyal tabloları, zamanlayıcının ACTIVE tenant listesini RLS'i atlamadan almasını sağlayan dar wms_probe işlevi.
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * processed_events: tenant_id NULL olabilir (platform işi, ADR-019 §2). UNIQUE NULLS NOT DISTINCT (tenant_id, consumer, event_id).
--   Politika (tek PERMISSIVE, USING + WITH CHECK aynı ifade): tenant satırı tenant_id = bağlam; NULL satırı yalnızca tenant bağlamı BOŞKEN.
--   wms_app yalnızca SELECT + INSERT (tenant_id, consumer, event_id); UPDATE/DELETE yok; processed_at sunucu varsayılanıdır.
--   Platform satırlarının bağlamsız web yolundan da yazılabilmesi ADR-019 §2 (MINOR-7) bilinen, kabul edilmiş risktir.
--   event_id uuid (pg-boss iş kimliği = ctx.jobId; A-98).
-- * stock_consistency_runs: RUNNING durumu YOK; satır yalnızca tamamlanan koşunun son transaction'ında (OK|MISMATCH) bir kez yazılır;
--   UNIQUE (tenant_id, job_id) ikinci teslimi ikinci satırdan korur. created_xid BEFORE INSERT tetikleyicisiyle sunucu değerine
--   zorlanır (ENABLE ALWAYS). wms_app SELECT + sütun bazlı INSERT (created_xid yok); UPDATE/DELETE yok. Yazma koşulu
--   app.system_reason = 'queue.stock.consistency.check' SERT BİR GÜVENLİK SINIRI DEĞİLDİR (ADR-019 §1 MINOR-6): sıradan GUC'tur.
-- * stock_consistency_signals: tenant kimliği YOK (M-7); append-only (UPDATE/DELETE/TRUNCATE tetikleyiciyle ret, ENABLE ALWAYS).
--   wms_app yalnızca INSERT (aynı system_reason koşulu, RLS INSERT politikası); SELECT yok → RETURNING kullanılamaz. wms_ops SELECT
--   (yalnızca bu tabloda; politika TO wms_ops FOR SELECT). /api/health bu tabloyu okumaz.
-- * wms_ops, tenant tablolarında (processed_events, stock_consistency_runs) hiçbir yetkiye sahip değildir (A-94; 0010-0013 deseni).
-- * wms_probe.active_tenant_ids(after, lim): SECURITY DEFINER, sahibi wms_identity_probe, SET ROLE kalıbı (ADR-015), sabit
--   search_path, gövde şema nitelikli. YALNIZ wms_worker EXECUTE (+ şema USAGE); wms_worker'a tenants SELECT/politika VERİLMEZ.
--   Okuma probe'un mevcut tenants SELECT USING (true) politikasıyla işlev içinden yapılır. ADR-016 §9 izinli listesine bilinçli
--   istisna (security-reviewer 2. tur koşullu kabul): tek alıcı, yalnız kimlik, tenants SELECT yok, izinli listeler güncel.
-- Koşturucu tek transaction içinde çalıştırır.

DO $pre$
DECLARE
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'wms_probe') THEN
    RAISE EXCEPTION '0014_reliability: wms_probe şeması yok (0003_tenancy önkoşulu)';
  END IF;
  IF pg_catalog.to_regclass('public.tenants') IS NULL OR pg_catalog.to_regclass('public.stock_ledger') IS NULL THEN
    RAISE EXCEPTION '0014_reliability: tenants/stock_ledger tabloları yok (0003/0013 önkoşulu)';
  END IF;
  FOR r IN SELECT unnest(ARRAY['wms_app', 'wms_worker', 'wms_ops', 'wms_identity_probe']) AS rolname LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r.rolname) THEN
      RAISE EXCEPTION '0014_reliability: % rolü yok (altyapı adımı)', r.rolname;
    END IF;
  END LOOP;
END
$pre$;

-- ---------------------------------------------------------------------------------------------
-- 1. Tablolar
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.processed_events (
  tenant_id    uuid,
  consumer     text        NOT NULL,
  event_id     uuid        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT processed_events_natural_key UNIQUE NULLS NOT DISTINCT (tenant_id, consumer, event_id),
  CONSTRAINT processed_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT processed_events_consumer_chk CHECK (btrim(consumer) <> '' AND char_length(consumer) <= 200)
);

CREATE TABLE public.stock_consistency_runs (
  tenant_id          uuid        NOT NULL,
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  job_id             uuid        NOT NULL,
  started_at         timestamptz NOT NULL,
  finished_at        timestamptz NOT NULL,
  status             text        NOT NULL,
  checked_dimensions bigint      NOT NULL,
  mismatch_count     integer     NOT NULL,
  findings           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_xid        xid8        NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT stock_consistency_runs_pkey PRIMARY KEY (id),
  CONSTRAINT stock_consistency_runs_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT stock_consistency_runs_tenant_id_job_id_key UNIQUE (tenant_id, job_id),
  CONSTRAINT stock_consistency_runs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT stock_consistency_runs_status_chk CHECK (status IN ('OK', 'MISMATCH')),
  CONSTRAINT stock_consistency_runs_counts_chk CHECK (checked_dimensions >= 0 AND mismatch_count >= 0),
  CONSTRAINT stock_consistency_runs_status_count_chk CHECK ((status = 'OK') = (mismatch_count = 0)),
  CONSTRAINT stock_consistency_runs_time_chk CHECK (finished_at >= started_at)
);
CREATE INDEX stock_consistency_runs_tenant_finished_idx ON public.stock_consistency_runs (tenant_id, finished_at);

CREATE TABLE public.stock_consistency_signals (
  id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  status         text        NOT NULL,
  mismatch_count integer     NOT NULL DEFAULT 0,
  created_xid    xid8        NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT stock_consistency_signals_pkey PRIMARY KEY (id),
  CONSTRAINT stock_consistency_signals_status_chk CHECK (status IN ('OK', 'MISMATCH', 'FAILED')),
  CONSTRAINT stock_consistency_signals_count_chk CHECK (mismatch_count >= 0)
);
CREATE INDEX stock_consistency_signals_occurred_idx ON public.stock_consistency_signals (occurred_at);

-- ---------------------------------------------------------------------------------------------
-- 2. Tetikleyiciler (SECURITY INVOKER, search_path sabit, PUBLIC'ten EXECUTE geri alınır; ENABLE ALWAYS)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.reliability_reject_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION '%: append-only: % reddedildi', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END
$fn$;
REVOKE ALL ON FUNCTION public.reliability_reject_change() FROM PUBLIC;

CREATE FUNCTION public.stock_consistency_runs_force_server_fields() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  NEW.created_xid := pg_catalog.pg_current_xact_id();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.stock_consistency_runs_force_server_fields() FROM PUBLIC;

CREATE FUNCTION public.stock_consistency_signals_force_server_fields() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  NEW.created_xid := pg_catalog.pg_current_xact_id();
  NEW.occurred_at := pg_catalog.now();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.stock_consistency_signals_force_server_fields() FROM PUBLIC;

CREATE TRIGGER stock_consistency_runs_server_fields BEFORE INSERT ON public.stock_consistency_runs
  FOR EACH ROW EXECUTE FUNCTION public.stock_consistency_runs_force_server_fields();
CREATE TRIGGER stock_consistency_signals_server_fields BEFORE INSERT ON public.stock_consistency_signals
  FOR EACH ROW EXECUTE FUNCTION public.stock_consistency_signals_force_server_fields();
CREATE TRIGGER stock_consistency_signals_append_only BEFORE UPDATE OR DELETE ON public.stock_consistency_signals
  FOR EACH ROW EXECUTE FUNCTION public.reliability_reject_change();
CREATE TRIGGER stock_consistency_signals_no_truncate BEFORE TRUNCATE ON public.stock_consistency_signals
  FOR EACH STATEMENT EXECUTE FUNCTION public.reliability_reject_change();
ALTER TABLE public.stock_consistency_runs ENABLE ALWAYS TRIGGER stock_consistency_runs_server_fields;
ALTER TABLE public.stock_consistency_signals ENABLE ALWAYS TRIGGER stock_consistency_signals_server_fields;
ALTER TABLE public.stock_consistency_signals ENABLE ALWAYS TRIGGER stock_consistency_signals_append_only;
ALTER TABLE public.stock_consistency_signals ENABLE ALWAYS TRIGGER stock_consistency_signals_no_truncate;

-- ---------------------------------------------------------------------------------------------
-- 3. RLS (ADR-015 §5)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.processed_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processed_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.processed_events FROM PUBLIC;
CREATE POLICY processed_events_isolation ON public.processed_events
  USING (
    tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid
    OR (tenant_id IS NULL AND NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid IS NULL)
  )
  WITH CHECK (
    tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid
    OR (tenant_id IS NULL AND NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid IS NULL)
  );

ALTER TABLE public.stock_consistency_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_consistency_runs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stock_consistency_runs FROM PUBLIC;
CREATE POLICY stock_consistency_runs_isolation ON public.stock_consistency_runs
  USING (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (
    tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid
    AND pg_catalog.current_setting('app.system_reason', true) = 'queue.stock.consistency.check'
  );

ALTER TABLE public.stock_consistency_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_consistency_signals FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stock_consistency_signals FROM PUBLIC;
CREATE POLICY stock_consistency_signals_insert ON public.stock_consistency_signals FOR INSERT TO wms_app
  WITH CHECK (pg_catalog.current_setting('app.system_reason', true) = 'queue.stock.consistency.check');
CREATE POLICY stock_consistency_signals_ops_select ON public.stock_consistency_signals FOR SELECT TO wms_ops
  USING (true);

-- ---------------------------------------------------------------------------------------------
-- 4. GRANT'lar (UPDATE/DELETE hiçbir tabloda yok; wms_ops yalnızca signals SELECT)
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON public.processed_events TO wms_app;
GRANT INSERT (tenant_id, consumer, event_id) ON public.processed_events TO wms_app;

-- created_xid INSERT listesinde YOK (tetikleyici yazar).
GRANT SELECT ON public.stock_consistency_runs TO wms_app;
GRANT INSERT (tenant_id, id, job_id, started_at, finished_at, status, checked_dimensions, mismatch_count, findings)
  ON public.stock_consistency_runs TO wms_app;

-- wms_app'te SELECT YOK; occurred_at/created_xid INSERT listesinde YOK.
GRANT INSERT (status, mismatch_count) ON public.stock_consistency_signals TO wms_app;
GRANT SELECT ON public.stock_consistency_signals TO wms_ops;

-- ---------------------------------------------------------------------------------------------
-- 5. wms_probe.active_tenant_ids (ADR-019 §1; SET ROLE kalıbı, 0006 ile aynı)
-- ---------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA wms_probe TO wms_identity_probe;

SET ROLE wms_identity_probe;

CREATE FUNCTION wms_probe.active_tenant_ids(after uuid, lim integer) RETURNS SETOF uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF $1 IS NULL THEN
    RAISE EXCEPTION 'active_tenant_ids: after NULL olamaz (ilk sayfa için sıfır-UUID verin)' USING ERRCODE = '22023';
  END IF;
  IF $2 IS NULL OR $2 < 1 OR $2 > 500 THEN
    RAISE EXCEPTION 'active_tenant_ids: lim 1..500 aralığında olmalı' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT t.id FROM public.tenants t
     WHERE t.status = 'ACTIVE' AND t.id > $1
     ORDER BY t.id
     LIMIT $2;
END
$fn$;

REVOKE ALL ON FUNCTION wms_probe.active_tenant_ids(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wms_probe.active_tenant_ids(uuid, integer) TO wms_worker;

RESET ROLE;
REVOKE CREATE ON SCHEMA wms_probe FROM wms_identity_probe;
GRANT USAGE ON SCHEMA wms_probe TO wms_worker;

-- ---------------------------------------------------------------------------------------------
-- 6. Doğrulama
-- ---------------------------------------------------------------------------------------------
DO $verify$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['processed_events', 'stock_consistency_runs', 'stock_consistency_signals'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = ('public.' || t)::regclass AND c.relrowsecurity AND c.relforcerowsecurity) THEN
      RAISE EXCEPTION '0014_reliability: % için RLS ENABLE+FORCE yok', t;
    END IF;
  END LOOP;
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = 'wms_probe.active_tenant_ids(uuid, integer)'::regprocedure
          AND p.proowner = pg_catalog.to_regrole('wms_identity_probe')
          AND p.prosecdef
          AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
          AND p.proacl IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a WHERE a.grantee = 0)) THEN
    RAISE EXCEPTION '0014_reliability: active_tenant_ids sahibi/SECURITY DEFINER/search_path/ACL beklenenden farklı';
  END IF;
  IF NOT pg_catalog.has_function_privilege('wms_worker', 'wms_probe.active_tenant_ids(uuid, integer)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('wms_app', 'wms_probe.active_tenant_ids(uuid, integer)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('wms_auth', 'wms_probe.active_tenant_ids(uuid, integer)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('wms_ops', 'wms_probe.active_tenant_ids(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '0014_reliability: active_tenant_ids EXECUTE yalnızca wms_worker olmalı';
  END IF;
  IF pg_catalog.has_table_privilege('wms_worker', 'public.tenants', 'SELECT') THEN
    RAISE EXCEPTION '0014_reliability: wms_worker tenants üzerinde SELECT taşıyor';
  END IF;
  IF pg_catalog.has_schema_privilege('wms_identity_probe', 'wms_probe', 'CREATE') THEN
    RAISE EXCEPTION '0014_reliability: wms_identity_probe wms_probe şemasında CREATE taşıyor';
  END IF;
  IF pg_catalog.has_table_privilege('wms_app', 'public.stock_consistency_signals', 'SELECT')
     OR pg_catalog.has_table_privilege('wms_app', 'public.processed_events', 'UPDATE, DELETE, TRUNCATE')
     OR pg_catalog.has_table_privilege('wms_app', 'public.stock_consistency_runs', 'UPDATE, DELETE, TRUNCATE')
     OR pg_catalog.has_table_privilege('wms_app', 'public.stock_consistency_signals', 'UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION '0014_reliability: wms_app yetkileri beklenenden geniş';
  END IF;
END
$verify$;

DO $final$
BEGIN
  IF current_user <> session_user THEN
    RAISE EXCEPTION '0014_reliability: current_user (%) <> session_user (%) — SET ROLE bloğu kapanmadı', current_user, session_user;
  END IF;
END
$final$;
