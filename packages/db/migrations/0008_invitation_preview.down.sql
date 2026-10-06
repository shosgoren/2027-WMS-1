-- 0008_invitation_preview geri alma: yalnızca önizleme işlevini kaldırır. VERİ KAYBETTİRMEZ (tabloya dokunulmaz).
-- Sahiplik: SET ROLE kalıbı (0006 down ile aynı).
SET ROLE wms_identity_probe;
DROP FUNCTION wms_probe.invitation_preview_for_token(text);
RESET ROLE;
