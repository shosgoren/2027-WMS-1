-- 0002_identity geri alma (ADR-015 §9): up'ın yarattığı tabloları, işlevi ve tetikleyicileri kaldırır.
-- VERİ KAYBETTİRİR: herhangi bir tabloda satır varsa yalnızca wms_meta.allow_destructive_down = 'on'
-- (WMS_ENV local|ci) iken çalışır. `GRANT USAGE ON SCHEMA public TO wms_auth` geri alınır (up verdi;
-- öncesinde yoktu); wms_app'in 0001'den gelen yetkisine dokunulmaz.
DO $guard$
DECLARE
  t text;
  has_rows boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'sessions', 'accounts', 'verifications', 'two_factors',
                           'auth_rate_limits', 'security_events'] LOOP
    IF pg_catalog.to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', t) INTO has_rows;
      IF has_rows AND coalesce(pg_catalog.current_setting('wms_meta.allow_destructive_down', true), '') <> 'on' THEN
        RAISE EXCEPTION '0002_identity down: public.% tablosunda satır var; veri kaybettiren geri alma bu ortamda kapalı', t;
      END IF;
    END IF;
  END LOOP;
END
$guard$;

DROP TABLE public.security_events;
DROP FUNCTION public.security_events_reject_change();
DROP FUNCTION public.security_events_force_server_fields();
DROP TABLE public.auth_rate_limits;
DROP TABLE public.two_factors;
DROP TABLE public.verifications;
DROP TABLE public.accounts;
DROP TABLE public.sessions;
DROP TABLE public.users;

DO $down$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_auth') THEN
    REVOKE USAGE ON SCHEMA public FROM wms_auth;
  END IF;
END
$down$;
