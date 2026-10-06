-- 0006_invitation_accept (T-117; Supervisor kararı 3, ADR-016 §3, §9): davet kabulünde belirteçten tenant çözümü.
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * Sorun: `invitations` tablosu RLS'lidir ve kabul anında tenant bağlamı yoktur; belirteçte tenant kimliği taşınmaz.
--   Çözüm yalnızca BİR okuma işlevidir: wms_probe.invitation_tenant_for_token(token_hash) -> uuid. `wms_identity_probe`
--   SALT OKUNUR kalır (0003 ilkesi): bu migration probe'a hiçbir tablo yetkisi/politikası eklemez.
-- * İşlev geçerli (ACTIVE ve demo olmayan tenant; süresi dolmamış, iptal/kabul edilmemiş) davet için YALNIZCA tenant_id
--   döndürür; aksi (yok/geçersiz/süresi dolmuş/iptal/kabul/demo) hepsi aynı biçimde NULL (varlık sızdırmaz).
-- * Yazmalar wms_app ile tenant bağlamında yapılır (withInvitationTenant, packages/db); çağıran dönen değere körü körüne
--   güvenmez: claim/complete adımları invitations satırını FOR UPDATE ile yeniden okuyup doğrular.
-- * EXECUTE yalnızca wms_app (PUBLIC ve wms_auth yok). Sahibi wms_identity_probe, SECURITY DEFINER, sabit search_path;
--   işlev SET ROLE kalıbıyla DOĞRUDAN probe sahipliğinde oluşturulur (0003 ile aynı); CREATE yetkisi blok sonunda geri alınır.

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'wms_probe') THEN
    RAISE EXCEPTION '0006_invitation_accept: wms_probe şeması yok (0003_tenancy önkoşulu)';
  END IF;
  IF pg_catalog.to_regclass('public.invitations') IS NULL OR pg_catalog.to_regclass('public.tenants') IS NULL THEN
    RAISE EXCEPTION '0006_invitation_accept: invitations/tenants tabloları yok (0003_tenancy önkoşulu)';
  END IF;
END
$pre$;

GRANT CREATE ON SCHEMA wms_probe TO wms_identity_probe;

SET ROLE wms_identity_probe;

CREATE FUNCTION wms_probe.invitation_tenant_for_token(token_hash text) RETURNS uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  found_tenant uuid;
BEGIN
  IF $1 IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT i.tenant_id INTO found_tenant
    FROM public.invitations i
    JOIN public.tenants t ON t.id = i.tenant_id
   WHERE i.token_hash = $1
     AND i.accepted_at IS NULL
     AND i.revoked_at IS NULL
     AND i.expires_at > pg_catalog.now()
     AND t.status = 'ACTIVE'
     AND NOT t.is_demo;
  RETURN found_tenant;   -- bulunamazsa NULL (tek tip "yok")
END
$fn$;

REVOKE ALL ON FUNCTION wms_probe.invitation_tenant_for_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wms_probe.invitation_tenant_for_token(text) TO wms_app;

RESET ROLE;
REVOKE CREATE ON SCHEMA wms_probe FROM wms_identity_probe;

DO $verify$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = 'wms_probe.invitation_tenant_for_token(text)'::regprocedure
          AND p.proowner = pg_catalog.to_regrole('wms_identity_probe')
          AND p.prosecdef
          AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
          AND p.proacl IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a WHERE a.grantee = 0)) THEN
    RAISE EXCEPTION '0006_invitation_accept: invitation_tenant_for_token sahibi/SECURITY DEFINER/search_path/ACL beklenenden farklı';
  END IF;
  IF NOT pg_catalog.has_function_privilege('wms_app', 'wms_probe.invitation_tenant_for_token(text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('wms_auth', 'wms_probe.invitation_tenant_for_token(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0006_invitation_accept: invitation_tenant_for_token EXECUTE yalnızca wms_app olmalı';
  END IF;
  IF pg_catalog.has_schema_privilege('wms_identity_probe', 'wms_probe', 'CREATE') THEN
    RAISE EXCEPTION '0006_invitation_accept: wms_identity_probe wms_probe şemasında CREATE taşıyor';
  END IF;
  -- Probe salt okunur kalır (0003 ilkesi): bu migration yazma yetkisi eklemedi.
  IF pg_catalog.has_table_privilege('wms_identity_probe', 'public.invitations', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR pg_catalog.has_table_privilege('wms_identity_probe', 'public.tenant_memberships', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR pg_catalog.has_table_privilege('wms_identity_probe', 'public.membership_roles', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION '0006_invitation_accept: wms_identity_probe tenant tablolarında yazma yetkisi taşıyor';
  END IF;
END
$verify$;

DO $final$
BEGIN
  IF current_user <> session_user THEN
    RAISE EXCEPTION '0006_invitation_accept: current_user (%) <> session_user (%) — SET ROLE bloğu kapanmadı', current_user, session_user;
  END IF;
END
$final$;
