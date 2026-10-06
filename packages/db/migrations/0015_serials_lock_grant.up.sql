-- 0015_serials_lock_grant (T-237, Q-56): I-15 adım 6 (seri kilidi) wms_app ile çalışsın.
-- PostgreSQL SELECT ... FOR UPDATE / NO KEY UPDATE / SHARE / KEY SHARE için tabloda en az bir sütun üzerinde UPDATE yetkisi ister.
-- serials'ta zararsız sütun yok (hepsi kimlik; A-87) → yalnızca created_at için UPDATE yetkisi verilir ve satır değişmezliği
-- tetikleyiciyle DB'de zorlanır: değeri değiştiren her UPDATE 23514 SERIAL_IMMUTABLE ile reddedilir. Aynı değeri yazan (no-op) UPDATE
-- geçer (emsal: membership_roles id=id, AC-04 UPDATE kontrolü her yazılabilir tabloda kendi satırına ≥1 ister); veri değişmez.
-- SELECT ... FOR <kilit> satır kilidi UPDATE tetikleyicisini çalıştırmaz → kilit alınır, veri değişmez.
-- Kural her rol için aynıdır (sahip/süper kullanıcı dahil, replica modunda da): lot_id dışındaki sütunların değişimi reddedilir;
-- lot_id değişimi 0013 serials_guard_lot kuralına bırakılır (o tetikleyici alfabetik olarak önce çalışır; ENABLE ALWAYS).

CREATE FUNCTION public.serials_reject_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  -- Tüm satır karşılaştırılır (yalnız lot_id hariç): ileride eklenecek sütunlar da kendiliğinden kapsamda (fail-closed; T-237 inceleme MINOR-2).
  IF (to_jsonb(NEW) - 'lot_id') IS DISTINCT FROM (to_jsonb(OLD) - 'lot_id') THEN
    RAISE EXCEPTION 'SERIAL_IMMUTABLE: serials satırı değiştirilemez (UPDATE yetkisi yalnızca satır kilidi içindir; lot_id yalnızca 0013 kuralıyla)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.serials_reject_update() FROM PUBLIC;

CREATE TRIGGER serials_reject_update BEFORE UPDATE ON public.serials
  FOR EACH ROW EXECUTE FUNCTION public.serials_reject_update();
ALTER TABLE public.serials ENABLE ALWAYS TRIGGER serials_reject_update;

GRANT UPDATE (created_at) ON public.serials TO wms_app;
