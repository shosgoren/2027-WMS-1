-- 0002_identity (T-102, ADR-014 §10/§12, ADR-016 §1): platform kimlik tabloları.
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * RLS YOK: bunlar tenant tablosu değil, global platform tablolarıdır (ADR-016 §1). Koruma, tablo
--   yetkileriyle sağlanır: Better Auth tablolarında yetki YALNIZCA wms_auth'tadır (ADR-014 §10).
-- * Alanlar Better Auth 1.7.7 çekirdek şeması (`@better-auth/core` dist/db/get-tables.mjs) + `twoFactor`
--   eklentisi (`better-auth` dist/plugins/two-factor/schema.mjs) ile birebir; tablo çoğul snake_case,
--   sütun snake_case, kimlikler uuid.
-- * Better Auth çekirdek şemasına İKİ BİLİNÇLİ EK (drift testinde istisna olarak işaretli):
--     sessions.mfa_verified_at     (ADR-014 §12; session.additionalFields, input:false)
--     users.invitation_claim_id    (ADR-016 3. tur m7; user.additionalFields, input:false)
-- * auth_rate_limits anahtarı düz IP/e-posta değil özet taşır (key_hash; Better Auth `rateLimit.fields.key`
--   eşlemesi T-112'de doğrulanır).
-- * security_events append-only: wms_app/wms_auth'a UPDATE/DELETE verilmez, ayrıca tetikleyici migration
--   rolü dahil UPDATE/DELETE/TRUNCATE'i reddeder. user_id bilerek FK değildir (kullanıcı silinse de olay
--   kalır; FK'nin SET NULL/CASCADE eylemi satırı değiştirirdi).
-- Koşturucu tek transaction içinde çalıştırır; denetim ihlali = RAISE = hiçbir şey uygulanmaz.

DO $identity$
DECLARE
  r pg_catalog.pg_roles%ROWTYPE;
  n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_app') THEN
    RAISE EXCEPTION '0002_identity: wms_app rolü yok (0001_baseline önkoşulu)';
  END IF;

  SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'wms_auth';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0002_identity: wms_auth rolü yok (altyapı adımı: infra/postgres/init/01-roles.sh veya T-105)';
  END IF;
  IF r.rolsuper OR r.rolbypassrls THEN
    RAISE EXCEPTION '0002_identity: wms_auth SUPERUSER veya BYPASSRLS olamaz (I-03)';
  END IF;
  IF r.rolcreaterole OR r.rolcreatedb OR r.rolreplication THEN
    RAISE EXCEPTION '0002_identity: wms_auth CREATEROLE, CREATEDB veya REPLICATION olamaz (I-03)';
  END IF;
  IF NOT r.rolcanlogin THEN
    RAISE EXCEPTION '0002_identity: wms_auth LOGIN olmalı (ADR-014 §10)';
  END IF;

  SELECT count(*) INTO n FROM pg_catalog.pg_auth_members WHERE member = r.oid;
  IF n > 0 THEN
    RAISE EXCEPTION '0002_identity: wms_auth hiçbir role üye olamaz (% üyelik bulundu)', n;
  END IF;

  SELECT (SELECT count(*) FROM pg_catalog.pg_class     WHERE relowner = r.oid)
       + (SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspowner = r.oid)
       + (SELECT count(*) FROM pg_catalog.pg_proc      WHERE proowner = r.oid)
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION '0002_identity: wms_auth hiçbir nesnenin sahibi olamaz (% nesne bulundu)', n;
  END IF;
END
$identity$;

GRANT USAGE ON SCHEMA public TO wms_auth;

-- ---------------------------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.users (
  id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
  name                text        NOT NULL,
  email               text        NOT NULL,
  email_verified      boolean     NOT NULL DEFAULT false,
  image               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  two_factor_enabled  boolean     NOT NULL DEFAULT false,   -- twoFactor eklentisi (user.twoFactorEnabled)
  invitation_claim_id uuid,                                 -- BİLİNÇLİ EK (ADR-016 3. tur m7)
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_email_lowercase_chk CHECK (email = lower(email))
);

-- ---------------------------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.sessions (
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  expires_at      timestamptz NOT NULL,
  token           text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  ip_address      text,
  user_agent      text,
  user_id         uuid        NOT NULL,
  mfa_verified_at timestamptz,                              -- BİLİNÇLİ EK (ADR-014 §12)
  CONSTRAINT sessions_pkey PRIMARY KEY (id),
  CONSTRAINT sessions_token_key UNIQUE (token),
  CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE
);
CREATE INDEX sessions_user_id_idx ON public.sessions (user_id);

-- ---------------------------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.accounts (
  id                       uuid        NOT NULL DEFAULT gen_random_uuid(),
  account_id               text        NOT NULL,
  provider_id              text        NOT NULL,
  user_id                  uuid        NOT NULL,
  access_token             text,
  refresh_token            text,
  id_token                 text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  password                 text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_pkey PRIMARY KEY (id),
  CONSTRAINT accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE
);
CREATE INDEX accounts_user_id_idx ON public.accounts (user_id);

-- ---------------------------------------------------------------------------------------------
-- verifications
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.verifications (
  id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  identifier text        NOT NULL,
  value      text        NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verifications_pkey PRIMARY KEY (id)
);
CREATE INDEX verifications_identifier_idx ON public.verifications (identifier);

-- ---------------------------------------------------------------------------------------------
-- two_factors (twoFactor eklentisi; secret ve backup_codes Better Auth tarafından şifreli yazılır)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.two_factors (
  id                        uuid        NOT NULL DEFAULT gen_random_uuid(),
  secret                    text        NOT NULL,
  backup_codes              text        NOT NULL,
  user_id                   uuid        NOT NULL,
  verified                  boolean     NOT NULL DEFAULT true,
  failed_verification_count integer     NOT NULL DEFAULT 0,
  locked_until              timestamptz,
  CONSTRAINT two_factors_pkey PRIMARY KEY (id),
  CONSTRAINT two_factors_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE
);
CREATE INDEX two_factors_user_id_idx ON public.two_factors (user_id);

-- ---------------------------------------------------------------------------------------------
-- auth_rate_limits (Better Auth `rateLimit` modeli; key -> key_hash, SHA-256 özeti — ADR-014 §13)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.auth_rate_limits (
  id           uuid    NOT NULL DEFAULT gen_random_uuid(),
  key_hash     text    NOT NULL,
  count        integer NOT NULL,
  last_request bigint  NOT NULL,   -- ms cinsinden epoch (Better Auth: number, bigint)
  CONSTRAINT auth_rate_limits_pkey PRIMARY KEY (id),
  CONSTRAINT auth_rate_limits_key_hash_key UNIQUE (key_hash)
);

-- ---------------------------------------------------------------------------------------------
-- security_events (append-only)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.security_events (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id     uuid,
  event_type  text        NOT NULL,
  ip          text,
  user_agent  text,
  request_id  text,
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_xid xid8        NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT security_events_pkey PRIMARY KEY (id)
);
CREATE INDEX security_events_user_occurred_idx ON public.security_events (user_id, occurred_at);

CREATE FUNCTION public.security_events_reject_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'security_events append-only: % reddedildi', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$fn$;
REVOKE ALL ON FUNCTION public.security_events_reject_change() FROM PUBLIC;

CREATE TRIGGER security_events_no_update_delete
  BEFORE UPDATE OR DELETE ON public.security_events
  FOR EACH ROW EXECUTE FUNCTION public.security_events_reject_change();
CREATE TRIGGER security_events_no_truncate
  BEFORE TRUNCATE ON public.security_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.security_events_reject_change();

-- ---------------------------------------------------------------------------------------------
-- GRANT'lar (tablo başına açık ve en dar; ADR-014 §10, ADR-016 §1)
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON TABLE public.users, public.sessions, public.accounts, public.verifications,
                    public.two_factors, public.auth_rate_limits, public.security_events
  FROM PUBLIC, wms_app, wms_auth;

-- wms_app: users'ta yalnızca dört sütun; Better Auth tablolarında hiçbir yetki.
GRANT SELECT (id, name, email, email_verified) ON public.users TO wms_app;
GRANT INSERT, SELECT ON public.security_events TO wms_app;

-- wms_auth: users'ta SELECT, INSERT, DELETE + sütun bazlı UPDATE (id ve invitation_claim_id YOK;
-- liste Better Auth 1.7.7 update-user/change-email/doğrulama/2FA akışlarının yazdığı sütunlardır).
GRANT SELECT, INSERT, DELETE ON public.users TO wms_auth;
GRANT UPDATE (name, image, email, email_verified, updated_at, two_factor_enabled) ON public.users TO wms_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions, public.accounts, public.verifications,
                                        public.two_factors, public.auth_rate_limits TO wms_auth;
GRANT INSERT ON public.security_events TO wms_auth;

-- Yetki denetimi: ihlal = RAISE.
DO $verify$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.sessions', 'public.accounts', 'public.verifications',
                           'public.two_factors', 'public.auth_rate_limits'] LOOP
    IF pg_catalog.has_table_privilege('wms_app', t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
      RAISE EXCEPTION '0002_identity: wms_app % üzerinde yetki taşıyor', t;
    END IF;
    IF pg_catalog.has_table_privilege('wms_auth', t, 'TRUNCATE, REFERENCES, TRIGGER') THEN
      RAISE EXCEPTION '0002_identity: wms_auth % üzerinde fazla yetki taşıyor', t;
    END IF;
  END LOOP;
  IF pg_catalog.has_table_privilege('wms_app', 'public.users', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION '0002_identity: wms_app users üzerinde tablo düzeyi yetki taşıyor';
  END IF;
  IF pg_catalog.has_column_privilege('wms_app', 'public.users', 'invitation_claim_id', 'SELECT, INSERT, UPDATE, REFERENCES') THEN
    RAISE EXCEPTION '0002_identity: wms_app users.invitation_claim_id üzerinde yetki taşıyor';
  END IF;
  IF pg_catalog.has_column_privilege('wms_auth', 'public.users', 'invitation_claim_id', 'UPDATE')
     OR pg_catalog.has_column_privilege('wms_auth', 'public.users', 'id', 'UPDATE') THEN
    RAISE EXCEPTION '0002_identity: wms_auth users.id/invitation_claim_id için UPDATE taşıyor';
  END IF;
  IF pg_catalog.has_table_privilege('wms_app', 'public.security_events', 'UPDATE, DELETE, TRUNCATE')
     OR pg_catalog.has_table_privilege('wms_auth', 'public.security_events', 'SELECT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION '0002_identity: security_events yetkileri append-only ilkesini aşıyor';
  END IF;
  IF pg_catalog.has_schema_privilege('wms_auth', 'wms_meta', 'USAGE, CREATE') THEN
    RAISE EXCEPTION '0002_identity: wms_auth wms_meta şemasında yetki taşıyor';
  END IF;
END
$verify$;
