-- 0003_tenancy geri alma (ADR-015 §9, 4. tur MINOR-3, 5. tur MINOR-2): up'ın yarattığı her şeyi kaldırır.
-- VERİ KAYBETTİRİR: herhangi bir tabloda satır varsa yalnızca wms_meta.allow_destructive_down = 'on'
-- (WMS_ENV local|ci) iken çalışır.
-- Sıra: veri koruması -> tetikleyiciler (migration rolü) -> SET ROLE wms_identity_probe bloğunda DROP FUNCTION
-- (sahiplik yeterli, CREATE gerekmez) -> RESET ROLE -> bekçi işlevi -> tablolar -> DROP SCHEMA wms_probe (RESTRICT;
-- içindeki tüm işlevler önceden kaldırıldığından CASCADE gerekmez) -> up'ın verdiği yetkilerin geri alınması.
-- Öncesinde var olan güvenlik ayarı gevşetilmez: PUBLIC'e/başka role hiçbir şey geri verilmez.
-- BLOKER-1: bekçi sayımı RLS'ten BAĞIMSIZ olmalı. Tablolar FORCE ROW LEVEL SECURITY altındadır; süper kullanıcı olmayan
-- tablo sahibi (Neon üretim yolu) tenant bağlamı olmadan HİÇ SATIR GÖRMEZ -> dolu tablolar "boş" sayılıp bayraksız
-- düşerdi. Çözüm: sayımdan önce RLS tablolarında NO FORCE ROW LEVEL SECURITY (tablo sahibi için RLS devre dışı kalır;
-- sahip = migration rolü, down'u çalıştıran rol). Kabul edilebilir çünkü bu betik zaten tabloları düşürür ve koşturucu
-- tek transaction'da çalıştırır: bekçi RAISE ederse NO FORCE de geri alınır (FORCE korunur, veri korunur); başarılıysa
-- tablolar düşer. Sayım ayrıca count(*) yerine EXISTS ile yapılır (tek satır yeter). Yalnızca RLS'li tablolar
-- değiştirilir (admin_reset_grants platform tablosudur, RLS'i yoktur).
DO $guard$
DECLARE
  t text;
  has_rows boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_settings', 'invitations', 'membership_roles', 'tenant_memberships', 'tenants'] LOOP
    IF pg_catalog.to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['admin_reset_grants', 'tenant_settings', 'invitations', 'membership_roles',
                           'tenant_memberships', 'tenants'] LOOP
    IF pg_catalog.to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', t) INTO has_rows;
      IF has_rows AND coalesce(pg_catalog.current_setting('wms_meta.allow_destructive_down', true), '') <> 'on' THEN
        RAISE EXCEPTION '0003_tenancy down: public.% tablosunda satır var; veri kaybettiren geri alma bu ortamda kapalı', t;
      END IF;
    END IF;
  END LOOP;
END
$guard$;

-- Tetikleyiciler (tablo sahibi = migration rolü).
DROP TRIGGER membership_roles_id_immutable ON public.membership_roles;
DROP TRIGGER admin_reset_grants_guard_issuer ON public.admin_reset_grants;
DROP TRIGGER tenant_memberships_admin_reset_cleanup ON public.tenant_memberships;
DROP TRIGGER tenant_memberships_system_reason_guard ON public.tenant_memberships;
DROP TRIGGER membership_roles_system_reason_guard ON public.membership_roles;

-- Probe sahipli işlevler: SET ROLE kalıbı (migration rolü INHERIT'siz üyedir; sahip yetkisi yalnızca SET ROLE ile).
SET ROLE wms_identity_probe;
DROP FUNCTION wms_probe.admin_reset_cleanup_on_membership();
DROP FUNCTION wms_probe.invitation_for_account_creation(text, uuid);
DROP FUNCTION wms_probe.consume_admin_reset_grant(uuid);
DROP FUNCTION wms_probe.identity_exclusive_to_tenant(uuid);
RESET ROLE;

DROP FUNCTION public.tenancy_guard_system_reason();
DROP FUNCTION public.admin_reset_grants_guard_issuer();
DROP FUNCTION public.membership_roles_id_immutable();

-- tenants okuma politikası tenant_memberships'e bağımlıdır (alt sorgu): tablolardan önce kaldırılır.
DROP POLICY tenants_select_own_memberships ON public.tenants;

DROP TABLE public.admin_reset_grants;
DROP TABLE public.tenant_settings;
DROP TABLE public.invitations;
DROP TABLE public.membership_roles;
DROP TABLE public.tenant_memberships;
DROP TABLE public.tenants;

DROP SCHEMA wms_probe;

-- up'ın 0002 tabloları ve public şeması üzerinde probe'a verdiği yetkiler (öncesinde yoktu).
REVOKE ALL ON TABLE public.users, public.verifications FROM wms_identity_probe;
REVOKE USAGE ON SCHEMA public FROM wms_identity_probe;

DO $final$
BEGIN
  IF current_user <> session_user THEN
    RAISE EXCEPTION '0003_tenancy down: current_user (%) <> session_user (%) — SET ROLE bloğu kapanmadı', current_user, session_user;
  END IF;
END
$final$;
