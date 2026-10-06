-- 0005_security_event_writers (T-112c; T-102 @77317fe + T-112 @f1b688f security-reviewer bulgusu; ADR-014 §14, ADR-016 §1):
-- KİMLİK olaylarını (oturum/giriş/MFA/parola/yeniden doğrulama) yalnızca `wms_auth` yazabilir; `wms_app` sahteleyemez.
--
-- Kimlik olay sınıfı (T-112/T-112b `packages/auth` emit çağrılarından; kart `password.` yazmıştı, kodda `password_*` var,
-- ikisi de kapsanır): `login_*` (login_succeeded/failed/mfa_pending), `logout`, `password_*` (password_changed/reset),
-- `two_factor_*` (enabled/disabled/failed), ve ileri kullanım için ayrılmış `reauth.*`, `session.*`, `mfa.*` ve alt çizgili benzerleri (`reauth_*`, `session_*`, `mfa_*`: kimlik sınıfına benzeyen türler de wms_auth'a
-- kısıtlanır; mevcut emit çağrılarında bu önekler YOK, grep ile doğrulandı).
-- `demo.action_forbidden` ve diğer uygulama sınıfı olaylar kısıtsızdır (`wms_app` yazmaya devam eder).
--
-- Tetikleyici SECURITY INVOKER: `current_user` = INSERT'i yapan rol. PG18 doğrulaması: BEFORE ROW tetikleyicisi INSERT'i
-- çalıştıran rolün güvenlik bağlamında çalışır (AFTER tetikleyicilerindeki "kuyruğa alan rol" davranışı bu kartta geçerli
-- değil; test: tests/integration/auth/auth-events.int.test.ts). SECURITY DEFINER OLMAMALI: aksi halde current_user işlev
-- sahibi olurdu. Sınıf denetimi `lower()` ile yapılır (EVENT_TYPE kodda küçük harf zorlar; ham SQL ile `LOGIN_X` atlatılamasın).
-- Tablo sahibi/süper kullanıcı da kimlik olayı yazamaz (current_user <> 'wms_auth'): bilinçli (yalnızca wms_auth).
-- ENABLE ALWAYS: session_replication_role = replica ile atlatılamaz.
--
-- `wms_auth` için INSERT yetkisi 0002'de zaten yalnızca (user_id, event_type, ip, user_agent, request_id, detail)
-- sütunlarındadır; SELECT yoktur → `INSERT ... RETURNING id` çalışmaz. `id` sunucu varsayılanıdır ve istemci `id`'si
-- (0002 sütun yetkisi) reddedilir; bu yüzden `recordSecurityEvent`'e `returning: false` yolu eklendi (istemci UUID'si
-- 0002 ilkesini bozardı). Bu migration yetki değiştirmez; bekçi yalnızca durumu doğrular.

-- Tür biçimi DB'de de zorlanır (kod EVENT_TYPE ile aynı): baştaki boşluk, büyük harf, Unicode benzeri harf (Kiril vb.) ile
-- sınıf denetimi atlatılamaz. NOT VALID + VALIDATE: mevcut satırlar uymuyorsa migration AÇIK hata verir (sessiz kabul yok).
ALTER TABLE public.security_events
  ADD CONSTRAINT security_events_event_type_format_chk CHECK (event_type ~ '^[a-z][a-z0-9_.]{0,63}$') NOT VALID;
ALTER TABLE public.security_events VALIDATE CONSTRAINT security_events_event_type_format_chk;

CREATE FUNCTION public.security_events_restrict_identity_writers() RETURNS trigger
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
REVOKE ALL ON FUNCTION public.security_events_restrict_identity_writers() FROM PUBLIC;

CREATE TRIGGER security_events_identity_writers
  BEFORE INSERT ON public.security_events
  FOR EACH ROW EXECUTE FUNCTION public.security_events_restrict_identity_writers();
ALTER TABLE public.security_events ENABLE ALWAYS TRIGGER security_events_identity_writers;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = 'public.security_events'::regclass AND tgname = 'security_events_identity_writers'
       AND tgenabled = 'A' AND (tgtype & 2) = 2 AND (tgtype & 4) = 4 AND (tgtype & 1) = 1
  ) THEN
    RAISE EXCEPTION '0005_security_event_writers: tetikleyici BEFORE INSERT ROW + ENABLE ALWAYS olmalı';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid = 'public.security_events_restrict_identity_writers()'::regprocedure AND prosecdef) THEN
    RAISE EXCEPTION '0005_security_event_writers: tetikleyici işlevi SECURITY INVOKER olmalı';
  END IF;
  IF pg_catalog.has_function_privilege('wms_app', 'public.security_events_restrict_identity_writers()', 'EXECUTE') THEN
    -- Tetikleyici işlevi çağrılabilir olmak zorunda değil; PUBLIC EXECUTE kaldırıldı.
    RAISE EXCEPTION '0005_security_event_writers: wms_app tetikleyici işlevinde EXECUTE taşıyor';
  END IF;
  IF pg_catalog.has_table_privilege('wms_auth', 'public.security_events', 'SELECT, UPDATE, DELETE, TRUNCATE')
     OR NOT pg_catalog.has_column_privilege('wms_auth', 'public.security_events', 'event_type', 'INSERT')
     OR pg_catalog.has_column_privilege('wms_auth', 'public.security_events', 'id', 'INSERT') THEN
    RAISE EXCEPTION '0005_security_event_writers: wms_auth security_events yetkileri beklenenden farklı (yalnızca sütun bazlı INSERT)';
  END IF;
END
$verify$;
