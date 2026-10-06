-- 0007_identity_event_classes (T-112d; T-117b inceleme MINOR-8; 0005 genişletmesi, genişlet–taşı–daralt: yalnızca işlev gövdesi):
-- `wms_auth`'ın yazdığı hesap/sıfırlama bağlantısı/demo hesap olayları da kimlik sınıfına alınır; `wms_app` sahteleyemez.
-- Yeni önekler: `account[_.]`, `password_reset_link[_.]`, `demo.(account|password)[_.]` (T-123a olayları: demo.account_created/
-- demo.account_taken_over/demo.password_reset; nokta ve alt çizgi; lower() ile). `demo.action_forbidden` bilerek DIŞARIDA: wms_app'e açık kalır (supervisor kararı).
-- NOT: `password_reset_link.*` 0005'teki `password[_.]` ile zaten kapsanıyordu; burada açıkça yazılarak niyet belgelenir.
-- Doğrulama: `packages/auth` bu olayları yalnızca `wms_auth` bağlantısıyla yazar (emit → recordSecurityEvent); `wms_app` ile
-- yazan üretim kodu YOKTUR (grep).
-- Tetikleyici ve ENABLE ALWAYS değişmez; işlev SECURITY INVOKER + search_path sabit kalır. Yetki değişmez.
CREATE OR REPLACE FUNCTION public.security_events_restrict_identity_writers() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF pg_catalog.lower(NEW.event_type) ~ '^(login_|logout|password[_.]|two_factor_|reauth[_.]|session[_.]|mfa[_.]|account[_.]|password_reset_link[_.]|demo\.(account|password)[_.])'
     AND current_user::text <> 'wms_auth' THEN
    RAISE EXCEPTION 'security_events: kimlik olayı (%) yalnızca wms_auth tarafından yazılabilir', NEW.event_type
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;

DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid = 'public.security_events_restrict_identity_writers()'::regprocedure AND prosecdef) THEN
    RAISE EXCEPTION '0007_identity_event_classes: tetikleyici işlevi SECURITY INVOKER olmalı';
  END IF;
  IF pg_catalog.has_function_privilege('wms_app', 'public.security_events_restrict_identity_writers()', 'EXECUTE') THEN
    RAISE EXCEPTION '0007_identity_event_classes: wms_app tetikleyici işlevinde EXECUTE taşıyor';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = 'public.security_events'::regclass AND tgname = 'security_events_identity_writers'
       AND tgenabled = 'A' AND (tgtype & 7) = 7
  ) THEN
    RAISE EXCEPTION '0007_identity_event_classes: tetikleyici BEFORE INSERT ROW + ENABLE ALWAYS olmalı';
  END IF;
END
$verify$;
