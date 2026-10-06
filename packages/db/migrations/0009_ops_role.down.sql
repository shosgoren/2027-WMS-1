-- 0009_ops_role geri alma (G-08): politikaları, işlevleri ve wms_ops yetkilerini kaldırır. Veri kaybettirmez
-- (yalnızca yetki/politika/işlev), bu yüzden yıkıcı-geri-alma bekçisi YOKTUR. Rol KENDİSİ düşürülmez (altyapı adımı).
DROP POLICY IF EXISTS ops_session_required ON public.tenants;
DROP POLICY IF EXISTS ops_session_required ON public.tenant_memberships;
DROP POLICY IF EXISTS ops_session_required ON public.membership_roles;
DROP POLICY IF EXISTS ops_session_required ON public.invitations;
DROP POLICY IF EXISTS ops_session_required ON public.tenant_settings;
DROP FUNCTION IF EXISTS public.ops_open_session(uuid, text, text);
DROP FUNCTION IF EXISTS public.ops_session_audited();

DO $revoke$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wms_ops') THEN
    REVOKE ALL ON TABLE public.tenants, public.tenant_memberships, public.membership_roles, public.invitations,
                        public.tenant_settings, public.audit_logs FROM wms_ops;
    REVOKE ALL ON SCHEMA public FROM wms_ops;
  END IF;
END
$revoke$;
