-- 0008_invitation_preview (T-117d; ADR-016 §3): davet sayfasında kabulden önce çalışma alanı adı + rol önizlemesi.
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * Tek, dar, SALT OKUNUR işlev: wms_probe.invitation_preview_for_token(token_hash) -> (tenant_name, role_key, expires_at).
--   Probe'a hiçbir tablo yetkisi/politikası eklenmez (0003/0006 ilkesi). Sonuç satırı e-posta, davet/tenant kimliği, slug,
--   davet eden bilgisi İÇERMEZ.
-- * Numaralandırma sızıntısı yok: geçerli (ACTIVE ve demo olmayan tenant; süresi dolmamış, iptal/kabul edilmemiş) davet
--   dışındaki her durum (yok/biçimsiz/süresi dolmuş/iptal/kabul/askıda/demo) AYNI biçimde 0 satır döner. Geçerlilik
--   koşulları invitation_tenant_for_token (0006) ile birebir aynıdır.
-- * Süre sonu yalnızca geçerli davet için döner (kalan süre gösterimi); ham belirteç özeti hiçbir zaman dönmez.
-- * EXECUTE yalnızca wms_app (PUBLIC ve wms_auth yok). Sahibi wms_identity_probe, SECURITY DEFINER, sabit search_path;
--   SET ROLE kalıbıyla doğrudan probe sahipliğinde oluşturulur (0006 ile aynı); CREATE yetkisi blok sonunda geri alınır.
-- * Hız sınırı uygulama katmanındadır (web sayfası, T-127 IP sınırı); işlev kendisi sınırlamaz.

DO $pre$
BEGIN
  IF pg_catalog.to_regprocedure('wms_probe.invitation_tenant_for_token(text)') IS NULL THEN
    RAISE EXCEPTION '0008_invitation_preview: 0006_invitation_accept önkoşulu yok';
  END IF;
END
$pre$;

GRANT CREATE ON SCHEMA wms_probe TO wms_identity_probe;

SET ROLE wms_identity_probe;

CREATE FUNCTION wms_probe.invitation_preview_for_token(token_hash text)
  RETURNS TABLE (tenant_name text, role_key text, expires_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT t.name, i.role_key, i.expires_at
    FROM public.invitations i
    JOIN public.tenants t ON t.id = i.tenant_id
   WHERE i.token_hash = $1
     AND i.accepted_at IS NULL
     AND i.revoked_at IS NULL
     AND i.expires_at > pg_catalog.now()
     AND t.status = 'ACTIVE'
     AND NOT t.is_demo
   LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION wms_probe.invitation_preview_for_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wms_probe.invitation_preview_for_token(text) TO wms_app;

RESET ROLE;
REVOKE CREATE ON SCHEMA wms_probe FROM wms_identity_probe;

DO $verify$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = 'wms_probe.invitation_preview_for_token(text)'::regprocedure
          AND p.proowner = pg_catalog.to_regrole('wms_identity_probe')
          AND p.prosecdef
          AND p.provolatile = 's'
          AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
          AND p.proacl IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a WHERE a.grantee = 0)) THEN
    RAISE EXCEPTION '0008_invitation_preview: invitation_preview_for_token sahibi/SECURITY DEFINER/STABLE/search_path/ACL beklenenden farklı';
  END IF;
  IF NOT pg_catalog.has_function_privilege('wms_app', 'wms_probe.invitation_preview_for_token(text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('wms_auth', 'wms_probe.invitation_preview_for_token(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0008_invitation_preview: invitation_preview_for_token EXECUTE yalnızca wms_app olmalı';
  END IF;
  IF pg_catalog.has_schema_privilege('wms_identity_probe', 'wms_probe', 'CREATE') THEN
    RAISE EXCEPTION '0008_invitation_preview: wms_identity_probe wms_probe şemasında CREATE taşıyor';
  END IF;
  IF pg_catalog.has_table_privilege('wms_identity_probe', 'public.invitations', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR pg_catalog.has_table_privilege('wms_identity_probe', 'public.tenants', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION '0008_invitation_preview: wms_identity_probe tenant tablolarında yazma yetkisi taşıyor';
  END IF;
END
$verify$;

DO $final$
BEGIN
  IF current_user <> session_user THEN
    RAISE EXCEPTION '0008_invitation_preview: current_user (%) <> session_user (%) — SET ROLE bloğu kapanmadı', current_user, session_user;
  END IF;
END
$final$;
