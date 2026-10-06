-- 0007_identity_event_classes geri alma: işlev gövdesi 0005 sürümüne döner (account/demo.account_/demo.password_ önekleri
-- artık wms_app'e kapalı değil; `password_reset_link.*` yine `password[_.]` ile kapalı kalır). VERİ KAYBETTİRMEZ:
-- yalnızca işlev gövdesi; tablo ve satırlara dokunulmaz.
CREATE OR REPLACE FUNCTION public.security_events_restrict_identity_writers() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF pg_catalog.lower(NEW.event_type) ~ '^(login_|logout|password[_.]|two_factor_|reauth[_.]|session[_.]|mfa[_.])'
     AND current_user::text <> 'wms_auth' THEN
    RAISE EXCEPTION 'security_events: kimlik olayı (%) yalnızca wms_auth tarafından yazılabilir', NEW.event_type
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
