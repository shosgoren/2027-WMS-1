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
--   göstermez/yazdırmaz (wms_probe.ops_session_audited()). Denetim satırı yazılamazsa (RLS/CHECK/FK) işlem zaten geri alınır.
--   audit_logs'ta da RESTRICTIVE politika vardır (B-1, I-12): SELECT yalnızca denetlenmiş oturumda; INSERT yalnızca
--   `ops.*` eylemi, actor_user_id/on_behalf_of_user_id NULL (başka kullanıcı adına sahte kayıt yok, M-1) ve ya oturum
--   açma satırı (gerekçe + operatör dolu) ya da denetlenmiş oturum. audit_logs append-only tetikleyicileri (0004)
--   wms_ops için de geçerlidir.
-- * ÖZYİNELEME ve B-1 TASARIMI: denetim kanıtı işlevi audit_logs'u okur; politika aynı tabloda olduğundan işlev wms_ops
--   yetkisiyle çalışsa sonsuz özyineleme olurdu. Bu yüzden `wms_probe.ops_session_audited()` SECURITY DEFINER'dır ve
--   sahibi wms_identity_probe'dur (NOLOGIN NOBYPASSRLS; politikalar yalnızca TO wms_ops olduğundan probe'a uygulanmaz,
--   probe audit_logs'ta yalnızca mevcut izolasyon politikasıyla geçerli tenant satırlarını görür). Yeni rol/mekanizma
--   yok: 0003/0006/0008'deki probe kalıbı. Probe'a yalnızca 5 sütunda SELECT verilir; işlev salt-okunur, search_path
--   sabit, PUBLIC'ten EXECUTE kapalı, yalnızca wms_ops EXECUTE.
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
  bad text;
BEGIN
  SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'wms_ops';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0009_ops_role: wms_ops rolü yok (altyapı adımı: yeni volume için infra/postgres/init/01-roles.sh, staging için provision-staging; MEVCUT yerel volume için migration rolüyle: CREATE ROLE wms_ops NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION — docs/RUNBOOK-ops.md)';
  END IF;
  IF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication THEN
    RAISE EXCEPTION '0009_ops_role: wms_ops NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION olmalı (Q-32; LOGIN yerelde, NOLOGIN staging ortaminda — A-80)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid) THEN
    RAISE EXCEPTION '0009_ops_role: wms_ops hiçbir role üye olamaz (neon_superuser dahil)';
  END IF;
  -- wms_ops'a SET/INHERIT seçenekli üye olamaz. Yalnızca-ADMIN satırı kabul: Neon'da CREATEROLE sahibi rolün kaldırılamayan
  -- örtük ADMIN'i (A-67 gerekçesi; yeni yetenek kazandırmaz) provizyon betiği tarafından ayrıca raporlanır.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid = r.oid AND (set_option OR inherit_option)) THEN
    RAISE EXCEPTION '0009_ops_role: wms_ops üzerinde SET/INHERIT seçenekli üyelik var (yalnızca-ADMIN satırı kabul edilir)';
  END IF;
  -- MINOR-1: yalnızca-ADMIN satırını yalnızca migration rolü ya da (A-67 koşulu) rolbypassrls AND rolcreaterole taşıyan,
  -- süper kullanıcı olmayan sahip rol taşıyabilir; wms_app/wms_auth/wms_worker/diğerleri kendine SET verip SET ROLE yapabilir.
  SELECT string_agg(m.rolname, ', ') INTO bad
    FROM pg_catalog.pg_auth_members am
    JOIN pg_catalog.pg_roles m ON m.oid = am.member
   WHERE am.roleid = r.oid
     AND m.rolname <> current_user
     AND NOT (m.rolbypassrls AND m.rolcreaterole AND NOT m.rolsuper);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0009_ops_role: wms_ops üzerinde yetkisiz üye (ADMIN dahil): % (yalnızca migration rolü veya BYPASSRLS+CREATEROLE sahip rol)', bad;
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

-- Denetim kanıtı işlevinin sahibi (probe) yalnızca gereken sütunları okur.
GRANT SELECT (tenant_id, created_xid, action, reason, change_summary) ON public.audit_logs TO wms_identity_probe;
GRANT USAGE ON SCHEMA wms_probe TO wms_ops;

-- ---------------------------------------------------------------------------------------------
-- 2. Denetim kanıtı işlevi + RESTRICTIVE politikalar
-- ---------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA wms_probe TO wms_identity_probe;
SET ROLE wms_identity_probe;

CREATE FUNCTION wms_probe.ops_session_audited() RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
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
REVOKE ALL ON FUNCTION wms_probe.ops_session_audited() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wms_probe.ops_session_audited() TO wms_ops;

RESET ROLE;
REVOKE CREATE ON SCHEMA wms_probe FROM wms_identity_probe;

CREATE POLICY ops_session_required ON public.tenants
  AS RESTRICTIVE FOR ALL TO wms_ops
  USING (wms_probe.ops_session_audited()) WITH CHECK (wms_probe.ops_session_audited());
CREATE POLICY ops_session_required ON public.tenant_memberships
  AS RESTRICTIVE FOR ALL TO wms_ops
  USING (wms_probe.ops_session_audited()) WITH CHECK (wms_probe.ops_session_audited());
CREATE POLICY ops_session_required ON public.membership_roles
  AS RESTRICTIVE FOR ALL TO wms_ops
  USING (wms_probe.ops_session_audited()) WITH CHECK (wms_probe.ops_session_audited());
CREATE POLICY ops_session_required ON public.invitations
  AS RESTRICTIVE FOR ALL TO wms_ops
  USING (wms_probe.ops_session_audited()) WITH CHECK (wms_probe.ops_session_audited());
CREATE POLICY ops_session_required ON public.tenant_settings
  AS RESTRICTIVE FOR ALL TO wms_ops
  USING (wms_probe.ops_session_audited()) WITH CHECK (wms_probe.ops_session_audited());

-- audit_logs (B-1, M-1): SELECT yalnızca denetlenmiş oturumda; INSERT yalnızca ops.* ve sahte kullanıcı alanı olmadan.
CREATE POLICY ops_session_required_select ON public.audit_logs
  AS RESTRICTIVE FOR SELECT TO wms_ops
  USING (wms_probe.ops_session_audited());
CREATE POLICY ops_session_required_insert ON public.audit_logs
  AS RESTRICTIVE FOR INSERT TO wms_ops
  WITH CHECK (
    action LIKE 'ops.%'
    AND actor_user_id IS NULL
    AND on_behalf_of_user_id IS NULL
    AND (
      (action = 'ops.session_opened'
        AND pg_catalog.btrim(COALESCE(reason, '')) <> ''
        AND pg_catalog.btrim(COALESCE(change_summary ->> 'operator', '')) <> '')
      OR wms_probe.ops_session_audited()
    )
  );

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
  -- MINOR-4: sequence yetkisi, açık EXECUTE alıcıları ve varsayılan yetkiler (pg_default_acl).
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND CASE WHEN c.relkind = 'S' THEN pg_catalog.has_sequence_privilege('wms_ops', c.oid, 'USAGE, SELECT, UPDATE') ELSE false END;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0009_ops_role: wms_ops sequence yetkisi taşıyor (%)', bad;
  END IF;
  SELECT string_agg(n.nspname || '.' || p.proname, ', ') INTO bad
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
   WHERE a.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'wms_ops')
     AND a.privilege_type = 'EXECUTE'
     AND (n.nspname || '.' || p.proname) NOT IN ('public.ops_open_session', 'wms_probe.ops_session_audited');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0009_ops_role: wms_ops beklenmeyen işlevlerde açık EXECUTE taşıyor (%)', bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d, pg_catalog.aclexplode(d.defaclacl) a
              WHERE a.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'wms_ops')) THEN
    RAISE EXCEPTION '0009_ops_role: pg_default_acl wms_ops için varsayılan yetki içeriyor';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = 'wms_probe.ops_session_audited()'::regprocedure
          AND p.proowner = pg_catalog.to_regrole('wms_identity_probe')
          AND p.prosecdef AND p.provolatile = 's'
          AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a WHERE a.grantee = 0)) THEN
    RAISE EXCEPTION '0009_ops_role: ops_session_audited sahibi/SECURITY DEFINER/search_path/ACL beklenenden farklı';
  END IF;
  IF pg_catalog.has_schema_privilege('wms_identity_probe', 'wms_probe', 'CREATE')
     OR pg_catalog.has_table_privilege('wms_identity_probe', 'public.audit_logs', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION '0009_ops_role: wms_identity_probe beklenmeyen yetki taşıyor';
  END IF;
END
$verify$;

DO $final$
BEGIN
  IF current_user <> session_user THEN
    RAISE EXCEPTION '0009_ops_role: current_user (%) <> session_user (%) — SET ROLE bloğu kapanmadı', current_user, session_user;
  END IF;
END
$final$;
