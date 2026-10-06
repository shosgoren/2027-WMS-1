-- 0009_ops_role (T-105c, Q-32 (c), A-66, I-03): NOBYPASSRLS operasyon rolü `wms_ops` için yetkiler, denetim-zorunlu
-- RESTRICTIVE politikalar ve oturum açma işlevi. Rol BU migration'da YARATILMAZ (ADR-015: roller altyapı adımıdır;
-- yerelde infra/postgres/init/01-roles.sh, staging'de T-105 yolu). Rol yoksa migration RAISE eder (0003/0004 deseni).
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * Neon dal sahibi rolü BYPASSRLS'tir (Q-32); destek/düzeltme/backfill sahip rolle DEĞİL, bu rolle ve yalnızca
--   tenant bağlamında (transaction-local ayar) yapılır. Mevcut izolasyon politikaları TO'suzdur, wms_ops'a da uygulanır:
--   bağlamsız SELECT 0 satır, başka tenant'a yazma WITH CHECK ile reddedilir.
-- * Yetki listesi (A-80 olarak raporlandı): kartın "grep'le çıkar" yönergesi — yazma yolu olan mevcut tenant tabloları
--   (tenants, tenant_memberships, membership_roles, invitations, tenant_settings, audit_logs) için wms_app yetkilerinin
--   DAR bir alt kümesi + tenants.status (askıya alma). Stok defteri/bakiye tablolarına HİÇBİR yetki yoktur (G-01):
--   düzeltme yalnızca domain komutlarıyla. users/sessions/accounts/verifications/security_events/request_rate_limits/
--   admin_reset_grants'a yetki yoktur. DDL yok (CREATE ŞEMA'da verilmez, hiçbir nesnenin sahibi değildir).
-- * Denetim zorunluluğu VERİTABANINDA zorlanır: tablolardaki RESTRICTIVE politika (TO wms_ops, FOR ALL), AYNI transaction'da
--   ve AYNI tenant için yazılmış, gerekçeli ve operatör adlı `ops.session_opened` audit_logs satırı yoksa hiçbir satırı
--   göstermez/yazdırmaz (public.ops_session_audited()). Denetim satırı yazılamazsa (RLS/CHECK/FK) işlem zaten geri alınır.
--   audit_logs'a politika KONMAZ (aksi halde ilk satır yazılamazdı); audit_logs append-only tetikleyicileri (0004)
--   wms_ops için de geçerlidir.
-- * public.ops_open_session(tenant, operator, reason): tenant bağlamını transaction-local kurar (G-02), app.system_reason
--   doluysa (withSystemTenant) REDDEDER, bağlam başka bir tenant'taysa REDDEDER, denetim satırını yazar. SECURITY INVOKER
--   (wms_ops'un kendi yetkileriyle çalışır; yetki yükseltmez). Güvenlik sınırı politikadır; işlev kolaylıktır (wms_ops
--   set_config'i elle de çağırabilir, ama denetim satırı olmadan satır göremez/yazamaz).
-- * Sınır: operatör adı (change_summary.operator) ve gerekçe wms_ops'un beyanıdır; kimlik doğrulaması Actions ortam
--   sırrına erişimdir (docs/RUNBOOK-ops.md). Bu migration kişisel veri içermez.
-- Koşturucu tek transaction içinde çalıştırır; denetim ihlali = RAISE = hiçbir şey uygulanmaz.

DO $pre$
DECLARE
  r pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'wms_ops';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0009_ops_role: wms_ops rolü yok (altyapı adımı: infra/postgres/init/01-roles.sh veya T-105 rol yolu)';
  END IF;
  IF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication THEN
    RAISE EXCEPTION '0009_ops_role: wms_ops NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION olmalı (Q-32; LOGIN yerelde, NOLOGIN staging ortaminda — A-80)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid) THEN
    RAISE EXCEPTION '0009_ops_role: wms_ops hiçbir role üye olamaz (neon_superuser dahil)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid = r.oid) THEN
    RAISE EXCEPTION '0009_ops_role: wms_ops hiçbir rolün parçası/yöneticisi olamaz (üyelik satırı var)';
  END IF;
  IF pg_catalog.to_regclass('public.audit_logs') IS NULL OR pg_catalog.to_regclass('public.tenant_settings') IS NULL THEN
    RAISE EXCEPTION '0009_ops_role: 0003_tenancy/0004_audit önkoşulu yok';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------------------------
-- 1. Tablo yetkileri (tablo başına açık ve en dar; PUBLIC'e hiçbir şey)
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON TABLE public.tenants, public.tenant_memberships, public.membership_roles, public.invitations,
                    public.tenant_settings, public.audit_logs FROM wms_ops;
GRANT USAGE ON SCHEMA public TO wms_ops;

GRANT SELECT ON public.tenants TO wms_ops;
GRANT UPDATE (name, status) ON public.tenants TO wms_ops;

GRANT SELECT ON public.tenant_memberships TO wms_ops;
GRANT INSERT (tenant_id, id, user_id, status, is_owner, joined_at) ON public.tenant_memberships TO wms_ops;
GRANT UPDATE (status, is_owner, removed_at, roles_version) ON public.tenant_memberships TO wms_ops;

GRANT SELECT, DELETE ON public.membership_roles TO wms_ops;
GRANT INSERT (tenant_id, id, membership_id, role_key) ON public.membership_roles TO wms_ops;

GRANT SELECT ON public.invitations TO wms_ops;
GRANT UPDATE (expires_at, revoked_at) ON public.invitations TO wms_ops;

GRANT SELECT, INSERT ON public.tenant_settings TO wms_ops;
GRANT UPDATE (locale, time_zone, sector_template_key, sector_template_version, terminology,
              onboarding_status, onboarding_steps) ON public.tenant_settings TO wms_ops;

-- audit_logs: wms_app ile aynı en dar küme (tenant_id/id/occurred_at/created_xid sütunlarında INSERT yok).
GRANT SELECT ON public.audit_logs TO wms_ops;
GRANT INSERT (actor_user_id, on_behalf_of_user_id, action, entity_type, entity_id, reason, ip, user_agent,
              request_id, change_summary) ON public.audit_logs TO wms_ops;

-- ---------------------------------------------------------------------------------------------
-- 2. Denetim kanıtı işlevi + RESTRICTIVE politikalar
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.ops_session_audited() RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.audit_logs a
     WHERE a.tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid
       AND a.created_xid = pg_catalog.pg_current_xact_id()
       AND a.action = 'ops.session_opened'
       AND pg_catalog.btrim(COALESCE(a.reason, '')) <> ''
       AND pg_catalog.btrim(COALESCE(a.change_summary ->> 'operator', '')) <> ''
  )
$fn$;
REVOKE ALL ON FUNCTION public.ops_session_audited() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_session_audited() TO wms_ops;

CREATE POLICY ops_session_required ON public.tenants
  AS RESTRICTIVE FOR ALL TO wms_ops
  USING (public.ops_session_audited()) WITH CHECK (public.ops_session_audited());
CREATE POLICY ops_session_required ON public.tenant_memberships
  AS RESTRICTIVE FOR ALL TO wms_ops
  USING (public.ops_session_audited()) WITH CHECK (public.ops_session_audited());
CREATE POLICY ops_session_required ON public.membership_roles
  AS RESTRICTIVE FOR ALL TO wms_ops
  USING (public.ops_session_audited()) WITH CHECK (public.ops_session_audited());
CREATE POLICY ops_session_required ON public.invitations
  AS RESTRICTIVE FOR ALL TO wms_ops
  USING (public.ops_session_audited()) WITH CHECK (public.ops_session_audited());
CREATE POLICY ops_session_required ON public.tenant_settings
  AS RESTRICTIVE FOR ALL TO wms_ops
  USING (public.ops_session_audited()) WITH CHECK (public.ops_session_audited());

-- ---------------------------------------------------------------------------------------------
-- 3. Oturum açma işlevi (G-02: transaction-local ayar)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.ops_open_session(target_tenant uuid, operator text, reason text) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  cur text;
BEGIN
  IF target_tenant IS NULL THEN
    RAISE EXCEPTION 'ops_open_session: açık tenant kimliği gerekli' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF pg_catalog.btrim(COALESCE(operator, '')) = '' OR pg_catalog.btrim(COALESCE(reason, '')) = '' THEN
    RAISE EXCEPTION 'ops_open_session: operatör adı ve gerekçe zorunlu' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NULLIF(pg_catalog.current_setting('app.system_reason', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'ops_open_session: withSystemTenant/sistem gerekçesi operasyon oturumunda yasak'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  cur := NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '');
  IF cur IS NOT NULL AND cur <> target_tenant::text THEN
    RAISE EXCEPTION 'ops_open_session: bir oturum tek tenant içindir (bağlam zaten başka tenant)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_catalog.set_config('app.current_tenant_id', target_tenant::text, true);
  INSERT INTO public.audit_logs (action, entity_type, entity_id, reason, change_summary)
  VALUES ('ops.session_opened', 'tenant', target_tenant::text, pg_catalog.btrim(reason),
          pg_catalog.jsonb_build_object('operator', pg_catalog.btrim(operator)));
END
$fn$;
REVOKE ALL ON FUNCTION public.ops_open_session(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_open_session(uuid, text, text) TO wms_ops;

-- ---------------------------------------------------------------------------------------------
-- 4. Yetki denetimi: ihlal = RAISE.
-- ---------------------------------------------------------------------------------------------
DO $verify$
DECLARE
  bad text;
BEGIN
  -- wms_ops yalnızca izinli tablolarda yetki taşır (stok defteri vb. dahil diğer her tablo kapalı).
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'wms_meta', 'wms_probe', 'pgboss')
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND c.relname NOT IN ('tenants', 'tenant_memberships', 'membership_roles', 'invitations', 'tenant_settings', 'audit_logs')
     AND (pg_catalog.has_table_privilege('wms_ops', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
          OR pg_catalog.has_any_column_privilege('wms_ops', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0009_ops_role: wms_ops izin listesi dışındaki tablolarda yetki taşıyor (%)', bad;
  END IF;
  IF pg_catalog.has_table_privilege('wms_ops', 'public.audit_logs', 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR pg_catalog.has_table_privilege('wms_ops', 'public.audit_logs', 'INSERT')
     OR pg_catalog.has_column_privilege('wms_ops', 'public.audit_logs', 'tenant_id', 'INSERT')
     OR pg_catalog.has_column_privilege('wms_ops', 'public.audit_logs', 'created_xid', 'INSERT')
     OR NOT pg_catalog.has_column_privilege('wms_ops', 'public.audit_logs', 'action', 'INSERT') THEN
    RAISE EXCEPTION '0009_ops_role: wms_ops audit_logs yetkileri beklenenden farklı';
  END IF;
  IF pg_catalog.has_table_privilege('wms_ops', 'public.tenants', 'INSERT, DELETE, TRUNCATE')
     OR pg_catalog.has_column_privilege('wms_ops', 'public.tenants', 'slug', 'UPDATE')
     OR pg_catalog.has_column_privilege('wms_ops', 'public.tenants', 'is_demo', 'UPDATE') THEN
    RAISE EXCEPTION '0009_ops_role: wms_ops tenants yetkileri beklenenden farklı (yalnızca name/status UPDATE)';
  END IF;
  IF pg_catalog.has_schema_privilege('wms_ops', 'public', 'CREATE')
     OR pg_catalog.has_database_privilege('wms_ops', pg_catalog.current_database(), 'CREATE') THEN
    RAISE EXCEPTION '0009_ops_role: wms_ops DDL/TEMP yetkisi taşıyor';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
              WHERE c.oid IN ('public.tenants'::regclass, 'public.audit_logs'::regclass, 'public.tenant_settings'::regclass)
                AND a.grantee = 0) THEN
    RAISE EXCEPTION '0009_ops_role: PUBLIC yetkisi var';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.tenants'::regclass, 'public.tenant_memberships'::regclass,
                              'public.membership_roles'::regclass, 'public.invitations'::regclass,
                              'public.tenant_settings'::regclass, 'public.audit_logs'::regclass)
                AND NOT (c.relrowsecurity AND c.relforcerowsecurity)) THEN
    RAISE EXCEPTION '0009_ops_role: ENABLE + FORCE ROW LEVEL SECURITY olmalı';
  END IF;
END
$verify$;
