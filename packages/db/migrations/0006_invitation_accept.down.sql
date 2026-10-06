-- 0006_invitation_accept geri alma: yalnızca okuma işlevini kaldırır. VERİ KAYBETTİRMEZ (tabloya dokunulmaz).
-- Sahiplik: SET ROLE kalıbı (migration rolü probe'un INHERIT'siz üyesidir; DROP için sahiplik yeterli, CREATE gerekmez).
SET ROLE wms_identity_probe;
DROP FUNCTION wms_probe.invitation_tenant_for_token(text);
RESET ROLE;
