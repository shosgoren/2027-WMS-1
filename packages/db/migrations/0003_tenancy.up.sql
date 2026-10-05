-- 0003_tenancy (T-103, ADR-016 §2-3, §5, §8-9 ve 2.-5. tur ekleri; ADR-015 §5 şablonu ve 4.-5. tur ekleri):
-- tenants, tenant_memberships, membership_roles, invitations, tenant_settings (RLS), admin_reset_grants
-- (platform tablosu), wms_probe şeması + probe sahipli yoklama işlevleri, üyelik tetikleyicileri.
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * Tenant tabloları: tenant_id NOT NULL, (tenant_id, id) benzersiz + bileşik FK, ENABLE + FORCE RLS,
--   USING + WITH CHECK. tenants için tenant_id yoktur (id tenant kimliğidir); tenant_settings'te PK tenant_id'dir
--   (satır başına tek kayıt; ayrı id yok).
-- * ON DELETE CASCADE zinciri YOK (15 §DB sözleşmesi): tenant tablolarındaki tüm FK'ler NO ACTION.
--   İstisna: platform tablosu admin_reset_grants'ın users/verifications FK'leri CASCADE'dir (geçici kayıt).
-- * wms_probe işlevleri SET ROLE wms_identity_probe bloğunda DOĞRUDAN probe sahipliğinde oluşturulur
--   (ADR-015 4. tur eki MINOR-3). Blok RESET ROLE ile kapanır; son ifade current_user = session_user denetimidir.
-- * Demo bekçi tetikleyici işlevi (public.tenancy_guard_system_reason) migration rolü sahipli, SECURITY DEFINER DEĞİL,
--   public şemasındadır (Supervisor eki, 5. tur): wms_probe'a konmaz.
-- * Süper kullanıcı: pg_has_role(..., 'MEMBER WITH ADMIN OPTION') süper kullanıcı için daima true döner
--   (PostgreSQL 17'de doğrulandı) — bu yüzden dolaylı-ADMIN denetimi yalnızca süper kullanıcı olmayan migration
--   rolünde yapılır; süper kullanıcıda doğrudan satır denetimi (a)/(b) yine çalışır.
-- * app.system_reason (withSystemTenant) bir GÜVENLİK SINIRI DEĞİLDİR: wms_app aynı transaction'da kendi
--   set_config('app.system_reason', ...) çağrısını yapabilir. Tetikleyici bekçisi (public.tenancy_guard_system_reason)
--   KOD HATASINA karşı korumadır (yanlış gerekçeyle yanlış tenant'a üyelik/rol yazmayı yakalar); kötü niyetli bir
--   wms_app oturumuna karşı koruma değildir. Asıl sınırlar RLS + sütun yetkileridir. (ADR notu: Supervisor.)
-- * probe politikaları (TO wms_identity_probe) izolasyon politikalarıyla İZNİN VEYASI (permissive politikalar OR'lanır)
--   birleşir: probe rolü için `USING (true)` politikası tenant izolasyonunu o rol için tamamen kaldırır. Bu yüzden
--   politikalar yalnızca probe'a bağlıdır (wms_app/wms_auth etkilenmez) ve yalnızca SELECT'tir; probe satır
--   KİLİDİ yalnızca public.users üzerinde (UPDATE (id)) alınır, tenant tablolarında kilit politikası/yetkisi yoktur.
-- Koşturucu tek transaction içinde çalıştırır; denetim ihlali = RAISE = hiçbir şey uygulanmaz.

-- ---------------------------------------------------------------------------------------------
-- 1. Önkoşullar: roller ve probe üyelik denetimi (ADR-015 4. tur MINOR-3 madde 5, 5. tur MINOR-6; Supervisor m1)
-- ---------------------------------------------------------------------------------------------
DO $pre$
DECLARE
  r        pg_catalog.pg_roles%ROWTYPE;
  me       pg_catalog.pg_roles%ROWTYPE;
  n        bigint;
  bad      text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_app') THEN
    RAISE EXCEPTION '0003_tenancy: wms_app rolü yok (0001_baseline önkoşulu)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_auth') THEN
    RAISE EXCEPTION '0003_tenancy: wms_auth rolü yok (0002_identity önkoşulu)';
  END IF;

  SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'wms_identity_probe';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0003_tenancy: wms_identity_probe rolü yok (altyapı adımı: infra/postgres/init/01-roles.sh veya T-105)';
  END IF;
  IF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolcanlogin THEN
    RAISE EXCEPTION '0003_tenancy: wms_identity_probe NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION olmalı (ADR-016 §9)';
  END IF;
  SELECT count(*) INTO n FROM pg_catalog.pg_auth_members WHERE member = r.oid;
  IF n > 0 THEN
    RAISE EXCEPTION '0003_tenancy: wms_identity_probe hiçbir role üye olamaz (% üyelik bulundu)', n;
  END IF;

  SELECT * INTO me FROM pg_catalog.pg_roles WHERE rolname = current_user;

  -- (a) member = migration rolü: >=1 satır; hiçbirinde inherit_option/admin_option; en az birinde set_option.
  SELECT count(*) INTO n FROM pg_catalog.pg_auth_members WHERE roleid = r.oid AND member = me.oid;
  IF n = 0 THEN
    RAISE EXCEPTION '0003_tenancy: migration rolü wms_identity_probe üyesi değil (altyapı adımı: GRANT wms_identity_probe TO <migration rolü> WITH ADMIN FALSE, SET TRUE, INHERIT FALSE)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid = r.oid AND member = me.oid AND inherit_option) THEN
    RAISE EXCEPTION '0003_tenancy: migration rolünün wms_identity_probe üyeliğinde INHERIT olamaz (yetki devralınmaz; yalnızca SET)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid = r.oid AND member = me.oid AND admin_option) THEN
    RAISE EXCEPTION '0003_tenancy: migration rolünün wms_identity_probe üyeliğinde ADMIN OPTION olamaz (altyapı adımı; migration REVOKE çalıştırmaz)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid = r.oid AND member = me.oid AND set_option) THEN
    RAISE EXCEPTION '0003_tenancy: migration rolünün wms_identity_probe üyeliğinde SET seçeneği yok (SET ROLE kalıbı için gerekli)';
  END IF;

  -- (b) member <> migration rolü: set_option/inherit_option yok (yalnızca admin_option olabilir);
  --     üye wms_app/wms_auth olamaz.
  SELECT string_agg(m.rolname, ', ') INTO bad
    FROM pg_catalog.pg_auth_members am
    JOIN pg_catalog.pg_roles m ON m.oid = am.member
   WHERE am.roleid = r.oid AND am.member <> me.oid AND (am.set_option OR am.inherit_option);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0003_tenancy: wms_identity_probe üyeliğinde migration rolü dışında SET/INHERIT seçenekli üye var (%)', bad;
  END IF;
  SELECT string_agg(m.rolname, ', ') INTO bad
    FROM pg_catalog.pg_auth_members am
    JOIN pg_catalog.pg_roles m ON m.oid = am.member
   WHERE am.roleid = r.oid AND m.rolname IN ('wms_app', 'wms_auth');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0003_tenancy: wms_app/wms_auth wms_identity_probe üyesi olamaz (%)', bad;
  END IF;

  -- Supervisor m1: dolaylı ADMIN üyeliği (başka bir rol üzerinden). Süper kullanıcıda pg_has_role daima
  -- true döner, bu yüzden yalnızca süper kullanıcı olmayan migration rolünde denetlenir.
  IF NOT me.rolsuper AND pg_catalog.pg_has_role(current_user, 'wms_identity_probe', 'MEMBER WITH ADMIN OPTION') THEN
    RAISE EXCEPTION '0003_tenancy: migration rolü wms_identity_probe üzerinde (dolaylı olarak da) ADMIN OPTION taşıyamaz';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------------------------
-- 2. Tablolar
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.tenants (
  id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
  slug                text        NOT NULL,
  name                text        NOT NULL,
  status              text        NOT NULL DEFAULT 'ACTIVE',
  is_demo             boolean     NOT NULL DEFAULT false,
  created_by_user_id  uuid,
  creation_request_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_pkey PRIMARY KEY (id),
  CONSTRAINT tenants_slug_key UNIQUE (slug),
  CONSTRAINT tenants_creator_request_key UNIQUE (created_by_user_id, creation_request_id),
  CONSTRAINT tenants_status_chk CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSING')),
  -- Biçim: küçük harf/rakam/tire, uçlarda tire yok, 1 veya 3-63 karakter. 'demo' yalnızca demo tenant'a ayrılmıştır
  -- (wms_app is_demo yazamaz; demo tenant'ı migration/operasyon rolü kurar). Ayrılmış kelime listesi T-121'dedir.
  CONSTRAINT tenants_slug_chk CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$' AND (slug <> 'demo' OR is_demo)),
  CONSTRAINT tenants_name_chk CHECK (name <> ''),
  -- Onboarding idempotency çifti birlikte dolu ya da birlikte boş (demo tenant'ı migration/operasyon rolü kurar).
  CONSTRAINT tenants_creator_pair_chk CHECK ((created_by_user_id IS NULL) = (creation_request_id IS NULL)),
  CONSTRAINT tenants_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users (id)
);

CREATE TABLE public.tenant_memberships (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL,
  status        text        NOT NULL DEFAULT 'ACTIVE',
  is_owner      boolean     NOT NULL DEFAULT false,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  roles_version integer     NOT NULL DEFAULT 0,
  CONSTRAINT tenant_memberships_pkey PRIMARY KEY (id),
  CONSTRAINT tenant_memberships_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT tenant_memberships_tenant_user_key UNIQUE (tenant_id, user_id),
  CONSTRAINT tenant_memberships_status_chk CHECK (status IN ('ACTIVE', 'REMOVED')),
  CONSTRAINT tenant_memberships_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  -- Eklemede users satırında FOR KEY SHARE alır (ADR-016 §9 kilit sözleşmesi).
  CONSTRAINT tenant_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id)
);
CREATE INDEX tenant_memberships_user_id_idx ON public.tenant_memberships (user_id);

CREATE TABLE public.membership_roles (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL,
  role_key      text NOT NULL,
  CONSTRAINT membership_roles_pkey PRIMARY KEY (id),
  CONSTRAINT membership_roles_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT membership_roles_tenant_membership_role_key UNIQUE (tenant_id, membership_id, role_key),
  CONSTRAINT membership_roles_role_key_chk CHECK (role_key IN ('TENANT_ADMIN', 'WAREHOUSE_MANAGER', 'PICKER', 'COUNTER', 'READ_ONLY')),
  CONSTRAINT membership_roles_membership_fkey FOREIGN KEY (tenant_id, membership_id)
    REFERENCES public.tenant_memberships (tenant_id, id)
);

CREATE TABLE public.invitations (
  tenant_id                 uuid        NOT NULL,
  id                        uuid        NOT NULL DEFAULT gen_random_uuid(),
  email_normalized          text        NOT NULL,
  role_key                  text        NOT NULL,
  token_hash                text        NOT NULL,   -- yalnızca SHA-256 özeti (düz belirteç saklanmaz)
  delivered_via             text        NOT NULL,
  expires_at                timestamptz NOT NULL,
  accepted_at               timestamptz,
  revoked_at                timestamptz,
  invited_by_membership_id  uuid        NOT NULL,
  claim_id                  uuid,
  claim_expires_at          timestamptz,
  CONSTRAINT invitations_pkey PRIMARY KEY (id),
  CONSTRAINT invitations_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT invitations_token_hash_key UNIQUE (token_hash),
  CONSTRAINT invitations_token_hash_chk CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invitations_email_chk CHECK (email_normalized <> '' AND email_normalized = lower(email_normalized)),
  CONSTRAINT invitations_role_key_chk CHECK (role_key IN ('TENANT_ADMIN', 'WAREHOUSE_MANAGER', 'PICKER', 'COUNTER', 'READ_ONLY')),
  CONSTRAINT invitations_delivered_via_chk CHECK (delivered_via IN ('EMAIL', 'SCREEN')),
  CONSTRAINT invitations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT invitations_invited_by_fkey FOREIGN KEY (tenant_id, invited_by_membership_id)
    REFERENCES public.tenant_memberships (tenant_id, id)
);
-- "Aktif" davet = kabul edilmemiş ve iptal edilmemiş (now() indeks koşulunda kullanılamaz): süresi dolmuş
-- ama iptal/kabul edilmemiş davet aynı e-posta için yeni davetin önünde durur; T-117 yeniden davette
-- eskisini iptal eder (süre bilgisi komut katmanındadır).
CREATE UNIQUE INDEX invitations_active_email_key
  ON public.invitations (tenant_id, email_normalized)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE public.tenant_settings (
  tenant_id                uuid        NOT NULL,
  locale                   text        NOT NULL,
  time_zone                text        NOT NULL,
  sector_template_key      text,
  sector_template_version  integer,
  terminology              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  onboarding_status        text        NOT NULL,
  onboarding_steps         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT tenant_settings_pkey PRIMARY KEY (tenant_id),
  CONSTRAINT tenant_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id)
);

-- Platform (global, RLS'siz) tablosu: yönetici kaynaklı parola sıfırlama izni (ADR-016 §9, 3. tur m2).
-- issuing_membership_id'ye FK YOK (tenant tablosuna bağ kurmaz; tutarlılık consume_admin_reset_grant'ta denetlenir).
CREATE TABLE public.admin_reset_grants (
  id                       uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id                  uuid        NOT NULL,
  issuing_tenant_id        uuid        NOT NULL,
  issuing_membership_id    uuid        NOT NULL,
  verification_id          uuid        NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz NOT NULL,
  CONSTRAINT admin_reset_grants_pkey PRIMARY KEY (id),
  CONSTRAINT admin_reset_grants_verification_id_key UNIQUE (verification_id),
  CONSTRAINT admin_reset_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT admin_reset_grants_verification_id_fkey FOREIGN KEY (verification_id) REFERENCES public.verifications (id) ON DELETE CASCADE
);
CREATE INDEX admin_reset_grants_user_id_idx ON public.admin_reset_grants (user_id);

-- ---------------------------------------------------------------------------------------------
-- 3. RLS (ADR-015 §5 şablonu) + ek politikalar
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.tenants            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants            FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_memberships FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.membership_roles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_roles   FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.invitations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations        FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.tenant_settings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_settings    FORCE  ROW LEVEL SECURITY;

-- tenants: yazma (ve okuma) id = geçerli tenant; ek SELECT: kullanıcının ACTIVE üyeliği olan tenant'lar
-- (yalnızca tenant bağlamı BOŞKEN — withUser; m1).
CREATE POLICY tenants_isolation ON public.tenants
  USING      (id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenants_select_own_memberships ON public.tenants FOR SELECT
  USING (
    NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '') IS NULL
    AND id IN (
      SELECT m.tenant_id FROM public.tenant_memberships m
       WHERE m.user_id = NULLIF(pg_catalog.current_setting('app.current_user_id', true), '')::uuid
         AND m.status = 'ACTIVE'
    )
  );

CREATE POLICY tenant_memberships_isolation ON public.tenant_memberships
  USING      (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_memberships_select_own ON public.tenant_memberships FOR SELECT
  USING (
    NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '') IS NULL
    AND user_id = NULLIF(pg_catalog.current_setting('app.current_user_id', true), '')::uuid
  );

CREATE POLICY membership_roles_isolation ON public.membership_roles
  USING      (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY invitations_isolation ON public.invitations
  USING      (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_settings_isolation ON public.tenant_settings
  USING      (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid);

-- Yalnızca wms_identity_probe (ADR-016 §9): yalnızca okuma. Politikalar TO wms_identity_probe olduğundan diğer
-- roller için görünmez; probe için izolasyon politikalarıyla OR'lanır (yani probe tüm satırları görür — işlevlerin
-- tenant'lar arası yoklaması için gereken budur). Kilit politikası/yetkisi YOK: işlevler bu tablolarda satır
-- kilitlemez (kilit yalnızca public.users'ta, UPDATE (id) ile).
CREATE POLICY probe_select ON public.tenant_memberships FOR SELECT TO wms_identity_probe USING (true);
CREATE POLICY probe_select ON public.tenants            FOR SELECT TO wms_identity_probe USING (true);
CREATE POLICY probe_select ON public.invitations        FOR SELECT TO wms_identity_probe USING (true);
CREATE POLICY probe_select ON public.membership_roles   FOR SELECT TO wms_identity_probe USING (true);

-- ---------------------------------------------------------------------------------------------
-- 4. Tablo yetkileri (tablo başına açık ve en dar)
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON TABLE public.tenants, public.tenant_memberships, public.membership_roles, public.invitations,
                    public.tenant_settings, public.admin_reset_grants
  FROM PUBLIC, wms_app, wms_auth, wms_identity_probe;

-- wms_app. tenants: DELETE yok; UPDATE yalnızca name; INSERT'te status/is_demo yok (M8, 2. tur m4).
GRANT SELECT ON public.tenants TO wms_app;
GRANT INSERT (id, slug, name, created_by_user_id, creation_request_id) ON public.tenants TO wms_app;
GRANT UPDATE (name) ON public.tenants TO wms_app;

GRANT SELECT ON public.tenant_memberships TO wms_app;
GRANT INSERT (tenant_id, id, user_id, status, is_owner, joined_at) ON public.tenant_memberships TO wms_app;
GRANT UPDATE (status, is_owner, joined_at, removed_at, roles_version) ON public.tenant_memberships TO wms_app;

GRANT SELECT, DELETE ON public.membership_roles TO wms_app;
GRANT INSERT (tenant_id, id, membership_id, role_key) ON public.membership_roles TO wms_app;
-- MINOR-6: withMembership rol satırlarını FOR SHARE okur; PostgreSQL satır kilidi için SELECT'e ek olarak en az bir
-- sütunda UPDATE ister (DELETE yetmez — doğrulandı). Yalnızca sahte-anahtar sütunu id: role_key/membership_id/tenant_id
-- DEĞİŞTİRİLEMEZ (rol değişimi sil + ekle ile yapılır). id hiçbir FK'nin hedefi değildir.
GRANT UPDATE (id) ON public.membership_roles TO wms_app;

GRANT SELECT ON public.invitations TO wms_app;
GRANT INSERT (tenant_id, id, email_normalized, role_key, token_hash, delivered_via, expires_at,
              invited_by_membership_id, claim_id, claim_expires_at) ON public.invitations TO wms_app;
GRANT UPDATE (token_hash, delivered_via, expires_at, accepted_at, revoked_at, claim_id, claim_expires_at)
  ON public.invitations TO wms_app;

GRANT SELECT, INSERT ON public.tenant_settings TO wms_app;
GRANT UPDATE (locale, time_zone, sector_template_key, sector_template_version, terminology,
              onboarding_status, onboarding_steps) ON public.tenant_settings TO wms_app;

-- admin_reset_grants: wms_app yalnızca INSERT (sunucu alanları id/created_at hariç); wms_auth hiçbir şey.
GRANT INSERT (user_id, issuing_tenant_id, issuing_membership_id, verification_id, expires_at)
  ON public.admin_reset_grants TO wms_app;

-- wms_identity_probe (ADR-016 §9): tenant tablolarında yalnızca SELECT; tek sütunda UPDATE yalnızca public.users'ta
-- (FOR UPDATE / FOR KEY SHARE satır kilidi için; MINOR-1: kullanılmayan UPDATE (id) yetkileri kaldırıldı).
GRANT USAGE ON SCHEMA public TO wms_identity_probe;
GRANT SELECT ON public.tenant_memberships              TO wms_identity_probe;
GRANT SELECT ON public.tenants                         TO wms_identity_probe;
GRANT SELECT ON public.invitations                     TO wms_identity_probe;
GRANT SELECT ON public.membership_roles                TO wms_identity_probe;
GRANT SELECT, UPDATE (id) ON public.users              TO wms_identity_probe;
GRANT SELECT, DELETE ON public.admin_reset_grants      TO wms_identity_probe;
GRANT SELECT, DELETE ON public.verifications           TO wms_identity_probe;

-- ---------------------------------------------------------------------------------------------
-- 5. Demo bekçi tetikleyicisi (ADR-016 4. tur MINOR-6; Supervisor m3): SECURITY DEFINER DEĞİL,
--    sahibi migration rolü, public şemasında.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION public.tenancy_guard_system_reason() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  reason text;
BEGIN
  reason := NULLIF(pg_catalog.current_setting('app.system_reason', true), '');
  IF reason IS NULL THEN
    RETURN NEW;   -- withMembership/withUser/withNewTenant/withTenant: sistem gerekçesi yok
  END IF;
  IF reason <> 'demo.bootstrap' THEN
    RAISE EXCEPTION 'tenancy_guard_system_reason: sistem gerekçesi "%" üyelik/rol yazamaz', reason
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = NEW.tenant_id AND t.is_demo) THEN
    RAISE EXCEPTION 'tenancy_guard_system_reason: demo.bootstrap yalnızca is_demo=true tenant''ta üyelik/rol yazabilir'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.tenancy_guard_system_reason() FROM PUBLIC;

CREATE TRIGGER tenant_memberships_system_reason_guard
  BEFORE INSERT OR UPDATE ON public.tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION public.tenancy_guard_system_reason();
CREATE TRIGGER membership_roles_system_reason_guard
  BEFORE INSERT OR UPDATE ON public.membership_roles
  FOR EACH ROW EXECUTE FUNCTION public.tenancy_guard_system_reason();
-- ENABLE ALWAYS: session_replication_role = replica ile atlatılamaz (sahibin DISABLE TRIGGER yapabilmesi bilinen sınır).
ALTER TABLE public.tenant_memberships ENABLE ALWAYS TRIGGER tenant_memberships_system_reason_guard;
ALTER TABLE public.membership_roles   ENABLE ALWAYS TRIGGER membership_roles_system_reason_guard;

-- admin_reset_grants INSERT bekçisi (MINOR-2): grant, çağıranın tenant bağlamında ve o tenant'ın ACTIVE üyeliği adına
-- yazılabilir. SECURITY DEFINER DEĞİL: üyelik sorgusu çağıranın RLS'i altında çalışır (yalnızca kendi tenant'ı görünür),
-- yani başka tenant'ın üyeliği ayrıca görünmez. admin_reset_grants platform tablosu olduğundan RLS'i yoktur; tenant
-- tutarlılığını bu tetikleyici zorlar.
CREATE FUNCTION public.admin_reset_grants_guard_issuer() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  cur_tenant uuid;
BEGIN
  cur_tenant := NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid;
  IF cur_tenant IS NULL OR NEW.issuing_tenant_id IS DISTINCT FROM cur_tenant THEN
    RAISE EXCEPTION 'admin_reset_grants_guard_issuer: issuing_tenant_id geçerli tenant bağlamıyla eşleşmiyor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenant_memberships m
                  WHERE m.id = NEW.issuing_membership_id AND m.tenant_id = cur_tenant AND m.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'admin_reset_grants_guard_issuer: issuing_membership_id bu tenant''ın ACTIVE üyeliği değil'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.admin_reset_grants_guard_issuer() FROM PUBLIC;

CREATE TRIGGER admin_reset_grants_guard_issuer
  BEFORE INSERT ON public.admin_reset_grants
  FOR EACH ROW EXECUTE FUNCTION public.admin_reset_grants_guard_issuer();
ALTER TABLE public.admin_reset_grants ENABLE ALWAYS TRIGGER admin_reset_grants_guard_issuer;

-- ---------------------------------------------------------------------------------------------
-- 6. wms_probe şeması ve probe sahipli işlevler (SET ROLE kalıbı; ADR-015 4. tur MINOR-3, 5. tur MINOR-2)
-- ---------------------------------------------------------------------------------------------
CREATE SCHEMA wms_probe;                       -- sahibi migration rolü
REVOKE ALL ON SCHEMA wms_probe FROM PUBLIC;
GRANT USAGE ON SCHEMA wms_probe TO wms_app, wms_auth, wms_identity_probe;
-- CREATE yalnızca SET ROLE bloğu süresince (ADR-016 4. tur MINOR-4).
GRANT CREATE ON SCHEMA wms_probe TO wms_identity_probe;

SET ROLE wms_identity_probe;

-- (i) identity_exclusive_to_tenant: "bu tenant'ta ACTIVE üyelik VAR ve başka tenant'ta ACTIVE YOK"; sıfır üyelik -> false.
-- Hedefin users satırını FOR UPDATE kilitler (yeni üyelik eklemesi FK üzerinden FOR KEY SHARE ile bekler).
CREATE FUNCTION wms_probe.identity_exclusive_to_tenant(target_user uuid) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  cur_tenant uuid;
BEGIN
  cur_tenant := NULLIF(pg_catalog.current_setting('app.current_tenant_id', true), '')::uuid;
  IF cur_tenant IS NULL THEN
    RAISE EXCEPTION 'identity_exclusive_to_tenant: tenant bağlamı yok';
  END IF;
  IF $1 IS NULL THEN
    RETURN false;
  END IF;
  -- MINOR-3: kilit yalnızca çağıranın tenant'ında ACTIVE üyeliği olan hedef için alınır (yoksa false, kilit yok);
  -- rastgele kullanıcı kimliğiyle users satırı kilitlenemez. Kilit sonrası aşağıdaki sorgular güncel durumu görür.
  IF NOT EXISTS (SELECT 1 FROM public.tenant_memberships m
                  WHERE m.user_id = $1 AND m.tenant_id = cur_tenant AND m.status = 'ACTIVE') THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.users u WHERE u.id = $1 FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = cur_tenant AND NOT t.is_demo)
     AND EXISTS (SELECT 1 FROM public.tenant_memberships m
                  WHERE m.user_id = $1 AND m.tenant_id = cur_tenant AND m.status = 'ACTIVE')
     AND NOT EXISTS (SELECT 1 FROM public.tenant_memberships m
                      WHERE m.user_id = $1 AND m.tenant_id <> cur_tenant AND m.status = 'ACTIVE');
END
$fn$;

-- (ii) consume_admin_reset_grant: satır yok -> 'absent'; koşullar tamam -> 'consumed'; aksi 'invalid' (grant her iki
-- durumda silinmiş kalır — fail-closed).
-- KİLİT SIRASI (MINOR-4): her yolda ÖNCE users satırı, SONRA admin_reset_grants satırı (tetikleyici ve users ON DELETE
-- CASCADE yolları da bu sırayı izler). Grant önce KİLİTSİZ okunur (user_id değişmez), users FOR UPDATE alınır, sonra
-- DELETE ... RETURNING; eşzamanlı ikinci tüketim users kilidinde bekler ve DELETE satır bulamayınca 'absent' döner.
-- T-117b NOTU: kanca yine de deadlock (40P01) / serialization hatalarını RED olarak ele almalıdır (fail-closed;
-- parola sıfırlama tamamlanmaz, kullanıcı yeniden dener); hata yutulup devam edilmez.
CREATE FUNCTION wms_probe.consume_admin_reset_grant(verification_id uuid) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  g public.admin_reset_grants%ROWTYPE;
  target uuid;
  locked boolean;
BEGIN
  SELECT a.user_id INTO target FROM public.admin_reset_grants a WHERE a.verification_id = $1;
  IF NOT FOUND THEN
    RETURN 'absent';
  END IF;

  -- Tekillik denetimi için hedefin users satırı FOR UPDATE (ADR-016 §9 kilit sözleşmesi); grant'ten ÖNCE.
  PERFORM 1 FROM public.users u WHERE u.id = target FOR UPDATE;
  locked := FOUND;

  DELETE FROM public.admin_reset_grants a WHERE a.verification_id = $1 RETURNING a.* INTO g;
  IF NOT FOUND THEN
    RETURN 'absent';   -- eşzamanlı çağrı veya üyelik tetikleyicisi önce tükettiyse
  END IF;
  IF NOT locked THEN
    RETURN 'invalid';
  END IF;

  IF g.expires_at <= pg_catalog.now() THEN
    RETURN 'invalid';
  END IF;
  -- MAJOR-1: doğrulama kaydı VAR ve grant'in hedef kullanıcısına ait olmalı. Better Auth 1.7.7 sıfırlama kaydı
  -- (api/routes/password.mjs, requestPasswordReset / resetPassword): identifier = 'reset-password:<token>',
  -- value = user.id (metin). Başka kullanıcının kaydı (veya sıfırlama olmayan kayıt) -> 'invalid'.
  IF NOT EXISTS (SELECT 1 FROM public.verifications v
                  WHERE v.id = g.verification_id
                    AND pg_catalog.starts_with(v.identifier, 'reset-password:')
                    AND v.value = g.user_id::text) THEN
    RETURN 'invalid';
  END IF;

  -- İhraç eden tenant ACTIVE ve demo değil.
  IF NOT EXISTS (SELECT 1 FROM public.tenants t
                  WHERE t.id = g.issuing_tenant_id AND t.status = 'ACTIVE' AND NOT t.is_demo) THEN
    RETURN 'invalid';
  END IF;
  -- İhraç eden üyelik o tenant'ta ACTIVE ve users.manage taşıyan role sahip (A-45: yalnızca TENANT_ADMIN;
  -- liste burada sabittir, A-45 değişirse migration ile değişir).
  IF NOT EXISTS (
       SELECT 1
         FROM public.tenant_memberships im
         JOIN public.membership_roles ir ON ir.tenant_id = im.tenant_id AND ir.membership_id = im.id
        WHERE im.id = g.issuing_membership_id AND im.tenant_id = g.issuing_tenant_id
          AND im.status = 'ACTIVE' AND ir.role_key IN ('TENANT_ADMIN')) THEN
    RETURN 'invalid';
  END IF;
  -- Hedefin o tenant'taki üyeliği ACTIVE ve sahip değil.
  IF NOT EXISTS (SELECT 1 FROM public.tenant_memberships tm
                  WHERE tm.user_id = g.user_id AND tm.tenant_id = g.issuing_tenant_id
                    AND tm.status = 'ACTIVE' AND NOT tm.is_owner) THEN
    RETURN 'invalid';
  END IF;
  -- Tekillik: başka hiçbir tenant'ta ACTIVE üyelik yok.
  IF EXISTS (SELECT 1 FROM public.tenant_memberships om
              WHERE om.user_id = g.user_id AND om.tenant_id <> g.issuing_tenant_id AND om.status = 'ACTIVE') THEN
    RETURN 'invalid';
  END IF;
  RETURN 'consumed';
END
$fn$;

-- (iii) invitation_for_account_creation: davet geçerli VE claim_id eşleşip claim_expires_at > now() ise yalnızca
-- e-posta + delivered_via (başka sütun/tenant bilgisi yok).
CREATE FUNCTION wms_probe.invitation_for_account_creation(token_hash text, claim_id uuid)
  RETURNS TABLE (email_normalized text, delivered_via text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RETURN QUERY
    SELECT i.email_normalized, i.delivered_via
      FROM public.invitations i
     WHERE i.token_hash = $1
       AND i.claim_id = $2
       AND i.claim_expires_at > pg_catalog.now()
       AND i.accepted_at IS NULL
       AND i.revoked_at IS NULL
       AND i.expires_at > pg_catalog.now();
END
$fn$;

-- (iv) Üyelik tetikleyici işlevi (probe sahipli, SECURITY DEFINER): üyelik eklenince / ACTIVE'e geçince hedefin
-- users satırını FOR KEY SHARE kilitler; açık admin_reset_grants satırlarını ve ilgili doğrulama kayıtlarını siler.
CREATE FUNCTION wms_probe.admin_reset_cleanup_on_membership() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM 1 FROM public.users u WHERE u.id = NEW.user_id FOR KEY SHARE;
  WITH removed AS (
    DELETE FROM public.admin_reset_grants g WHERE g.user_id = NEW.user_id RETURNING g.verification_id
  )
  DELETE FROM public.verifications v USING removed r WHERE v.id = r.verification_id;
  RETURN NULL;
END
$fn$;

-- EXECUTE: PUBLIC'ten alınır; yalnızca ilgili rollere. (Probe sahipli olduğundan GRANT/REVOKE bu blokta yapılır.)
REVOKE ALL ON FUNCTION wms_probe.identity_exclusive_to_tenant(uuid)               FROM PUBLIC;
REVOKE ALL ON FUNCTION wms_probe.consume_admin_reset_grant(uuid)                  FROM PUBLIC;
REVOKE ALL ON FUNCTION wms_probe.invitation_for_account_creation(text, uuid)      FROM PUBLIC;
REVOKE ALL ON FUNCTION wms_probe.admin_reset_cleanup_on_membership()              FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wms_probe.identity_exclusive_to_tenant(uuid)            TO wms_app;
GRANT EXECUTE ON FUNCTION wms_probe.consume_admin_reset_grant(uuid)               TO wms_auth;
GRANT EXECUTE ON FUNCTION wms_probe.invitation_for_account_creation(text, uuid)   TO wms_auth;
-- Tek istisna (ADR-015 5. tur MINOR-2): CREATE TRIGGER için migration rolüne açık EXECUTE (rol adı session_user'dan).
DO $grant_trigger_fn$
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION wms_probe.admin_reset_cleanup_on_membership() TO %I', session_user);
END
$grant_trigger_fn$;

RESET ROLE;
REVOKE CREATE ON SCHEMA wms_probe FROM wms_identity_probe;

-- CREATE TRIGGER migration rolüyle (tablo sahibi; tetikleyici işlevinde EXECUTE açıkça verildi).
CREATE TRIGGER tenant_memberships_admin_reset_cleanup
  AFTER INSERT OR UPDATE OF status ON public.tenant_memberships
  FOR EACH ROW WHEN (NEW.status = 'ACTIVE')
  EXECUTE FUNCTION wms_probe.admin_reset_cleanup_on_membership();
ALTER TABLE public.tenant_memberships ENABLE ALWAYS TRIGGER tenant_memberships_admin_reset_cleanup;

-- ---------------------------------------------------------------------------------------------
-- 7. Yetki ve sahiplik denetimi: ihlal = RAISE.
-- ---------------------------------------------------------------------------------------------
DO $verify$
DECLARE
  f text;
  n bigint;
BEGIN
  -- wms_app: tenants.
  IF pg_catalog.has_table_privilege('wms_app', 'public.tenants', 'DELETE, TRUNCATE, REFERENCES, TRIGGER, UPDATE')
     OR pg_catalog.has_column_privilege('wms_app', 'public.tenants', 'is_demo', 'INSERT, UPDATE')
     OR pg_catalog.has_column_privilege('wms_app', 'public.tenants', 'status', 'INSERT, UPDATE')
     OR pg_catalog.has_column_privilege('wms_app', 'public.tenants', 'slug', 'UPDATE')
     OR NOT pg_catalog.has_column_privilege('wms_app', 'public.tenants', 'name', 'UPDATE') THEN
    RAISE EXCEPTION '0003_tenancy: wms_app tenants yetkileri beklenenden farklı (DELETE yok, yalnızca UPDATE (name), INSERT status/is_demo hariç)';
  END IF;
  -- wms_app/wms_auth: admin_reset_grants.
  IF pg_catalog.has_table_privilege('wms_app', 'public.admin_reset_grants', 'SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR pg_catalog.has_table_privilege('wms_auth', 'public.admin_reset_grants', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR NOT pg_catalog.has_column_privilege('wms_app', 'public.admin_reset_grants', 'user_id', 'INSERT') THEN
    RAISE EXCEPTION '0003_tenancy: admin_reset_grants yetkileri beklenenden farklı (wms_app yalnızca INSERT; wms_auth hiçbiri)';
  END IF;
  -- wms_auth tenant tablolarında hiçbir yetki taşımaz.
  FOREACH f IN ARRAY ARRAY['public.tenants', 'public.tenant_memberships', 'public.membership_roles',
                           'public.invitations', 'public.tenant_settings'] LOOP
    IF pg_catalog.has_table_privilege('wms_auth', f, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
      RAISE EXCEPTION '0003_tenancy: wms_auth % üzerinde yetki taşıyor', f;
    END IF;
    IF pg_catalog.has_table_privilege('wms_app', f, 'TRUNCATE, REFERENCES, TRIGGER') THEN
      RAISE EXCEPTION '0003_tenancy: wms_app % üzerinde fazla yetki taşıyor', f;
    END IF;
  END LOOP;
  IF pg_catalog.has_table_privilege('wms_app', 'public.tenant_memberships', 'DELETE')
     OR pg_catalog.has_table_privilege('wms_app', 'public.invitations', 'DELETE')
     OR pg_catalog.has_table_privilege('wms_app', 'public.tenant_settings', 'DELETE') THEN
    RAISE EXCEPTION '0003_tenancy: wms_app üyelik/davet/ayar tablolarında DELETE taşıyor';
  END IF;

  -- MINOR-6: wms_app membership_roles'ta yalnızca id'yi (satır kilidi için) güncelleyebilir; rol anahtarı değişmez.
  IF NOT pg_catalog.has_column_privilege('wms_app', 'public.membership_roles', 'id', 'UPDATE')
     OR pg_catalog.has_column_privilege('wms_app', 'public.membership_roles', 'role_key', 'UPDATE')
     OR pg_catalog.has_column_privilege('wms_app', 'public.membership_roles', 'membership_id', 'UPDATE')
     OR pg_catalog.has_column_privilege('wms_app', 'public.membership_roles', 'tenant_id', 'UPDATE') THEN
    RAISE EXCEPTION '0003_tenancy: wms_app membership_roles UPDATE yetkisi yalnızca (id) olmalı';
  END IF;
  -- MINOR-1: probe tenant tablolarında yalnızca SELECT taşır (UPDATE/INSERT/DELETE yok); users'ta yalnızca UPDATE (id).
  IF pg_catalog.has_table_privilege('wms_identity_probe', 'public.tenants', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR pg_catalog.has_table_privilege('wms_identity_probe', 'public.tenant_memberships', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR pg_catalog.has_table_privilege('wms_identity_probe', 'public.invitations', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR pg_catalog.has_table_privilege('wms_identity_probe', 'public.membership_roles', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR pg_catalog.has_any_column_privilege('wms_identity_probe', 'public.tenants', 'UPDATE')
     OR pg_catalog.has_any_column_privilege('wms_identity_probe', 'public.tenant_memberships', 'UPDATE')
     OR pg_catalog.has_any_column_privilege('wms_identity_probe', 'public.invitations', 'UPDATE')
     OR NOT pg_catalog.has_column_privilege('wms_identity_probe', 'public.users', 'id', 'UPDATE') THEN
    RAISE EXCEPTION '0003_tenancy: wms_identity_probe tenant tablolarında yalnızca SELECT taşımalı (users''ta UPDATE (id))';
  END IF;

  -- wms_meta: wms_app/wms_auth/probe hiçbir yetki taşımaz.
  IF pg_catalog.has_schema_privilege('wms_app', 'wms_meta', 'USAGE, CREATE')
     OR pg_catalog.has_schema_privilege('wms_auth', 'wms_meta', 'USAGE, CREATE')
     OR pg_catalog.has_schema_privilege('wms_identity_probe', 'wms_meta', 'USAGE, CREATE') THEN
    RAISE EXCEPTION '0003_tenancy: wms_meta şemasında yetki taşıyan uygulama/probe rolü var';
  END IF;

  -- wms_probe şeması: probe yalnızca USAGE; wms_app/wms_auth yalnızca USAGE; PUBLIC hiçbir şey.
  IF pg_catalog.has_schema_privilege('wms_identity_probe', 'wms_probe', 'CREATE')
     OR NOT pg_catalog.has_schema_privilege('wms_identity_probe', 'wms_probe', 'USAGE')
     OR pg_catalog.has_schema_privilege('wms_app', 'wms_probe', 'CREATE')
     OR pg_catalog.has_schema_privilege('wms_auth', 'wms_probe', 'CREATE')
     OR NOT pg_catalog.has_schema_privilege('wms_app', 'wms_probe', 'USAGE')
     OR NOT pg_catalog.has_schema_privilege('wms_auth', 'wms_probe', 'USAGE') THEN
    RAISE EXCEPTION '0003_tenancy: wms_probe şema yetkileri beklenenden farklı';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
              WHERE n.nspname = 'wms_probe' AND a.grantee = 0) THEN
    RAISE EXCEPTION '0003_tenancy: wms_probe şemasında PUBLIC yetkisi var';
  END IF;

  -- İşlev sahipliği, güvenlik özellikleri ve EXECUTE matrisi.
  SELECT count(*) INTO n
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace
   WHERE s.nspname = 'wms_probe';
  IF n <> 4 THEN
    RAISE EXCEPTION '0003_tenancy: wms_probe şemasında 4 işlev beklenirdi, % bulundu', n;
  END IF;
  IF EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace
        WHERE s.nspname = 'wms_probe'
          AND (p.proowner <> pg_catalog.to_regrole('wms_identity_probe')
               OR NOT p.prosecdef
               OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
               OR p.proacl IS NULL
               OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a WHERE a.grantee = 0))) THEN
    RAISE EXCEPTION '0003_tenancy: wms_probe işlevlerinin sahibi/SECURITY DEFINER/search_path/ACL beklenenden farklı';
  END IF;
  IF NOT pg_catalog.has_function_privilege('wms_app',  'wms_probe.identity_exclusive_to_tenant(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('wms_auth', 'wms_probe.identity_exclusive_to_tenant(uuid)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('wms_auth', 'wms_probe.consume_admin_reset_grant(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('wms_app',  'wms_probe.consume_admin_reset_grant(uuid)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('wms_auth', 'wms_probe.invitation_for_account_creation(text, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('wms_app',  'wms_probe.invitation_for_account_creation(text, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('wms_app',  'wms_probe.admin_reset_cleanup_on_membership()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('wms_auth', 'wms_probe.admin_reset_cleanup_on_membership()', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege(session_user, 'wms_probe.admin_reset_cleanup_on_membership()', 'EXECUTE') THEN
    RAISE EXCEPTION '0003_tenancy: wms_probe işlevlerinde EXECUTE matrisi beklenenden farklı';
  END IF;

  -- Demo bekçi işlevi: sahibi migration rolü, SECURITY DEFINER değil, search_path sabit.
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = 'public.tenancy_guard_system_reason()'::regprocedure
          AND p.proowner = pg_catalog.to_regrole(current_user::text)
          AND NOT p.prosecdef
          AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION '0003_tenancy: public.tenancy_guard_system_reason sahipliği/özellikleri beklenenden farklı';
  END IF;
END
$verify$;

-- Son ifade: SET ROLE sızmadı (defter yazımı probe rolüyle yapılamaz).
DO $final$
BEGIN
  IF current_user <> session_user THEN
    RAISE EXCEPTION '0003_tenancy: current_user (%) <> session_user (%) — SET ROLE bloğu kapanmadı', current_user, session_user;
  END IF;
END
$final$;
