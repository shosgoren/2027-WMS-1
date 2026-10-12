-- 0027_count_approved_by_guard (T-309 BLOCKER-1; T-302 yeniden sayım MINOR; A-03 görev ayrımı / audit izi; G-08: yalnızca tetikleyici işlevi gövdesi, şema/yetki değişmez):
-- `count_sessions.approved_by` YALNIZCA `SUBMITTED -> APPROVED` geçişinde değişebilir. Başka her durumda (özellikle `APPROVED` iken başka onaylayıcıyla ezme,
-- `COUNTING`/`SUBMITTED` iken yazma, `CANCELLED`'a geçerken değiştirme) 23514. 0017'deki sonlanmış oturum (POSTED/CANCELLED) kuralı ve durum makinesi aynen korunur.
-- GRANT'lara dokunulmaz: tetikleyici işlevi `CREATE OR REPLACE` ile yerinde değişir (tetikleyici bağı, REVOKE ve sahiplik korunur).
CREATE OR REPLACE FUNCTION public.count_sessions_guard_state() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF OLD.status IN ('POSTED', 'CANCELLED') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason THEN
      RAISE EXCEPTION 'count_sessions: sonlanmış oturum (%) değiştirilemez', OLD.status USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Atlama yok: COUNTING -> SUBMITTED -> APPROVED -> POSTED; CANCELLED her açık durumdan (POSTED terminaldir, yukarıda).
  IF NEW.status <> OLD.status AND NOT (
       NEW.status = 'CANCELLED'
       OR (OLD.status = 'COUNTING' AND NEW.status = 'SUBMITTED')
       OR (OLD.status = 'SUBMITTED' AND NEW.status = 'APPROVED')
       OR (OLD.status = 'APPROVED' AND NEW.status = 'POSTED')) THEN
    RAISE EXCEPTION 'count_sessions: geçersiz durum geçişi (% -> %)', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  -- approved_by yalnız SUBMITTED -> APPROVED geçişinde yazılır (A-03).
  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by AND NOT (OLD.status = 'SUBMITTED' AND NEW.status = 'APPROVED') THEN
    RAISE EXCEPTION 'count_sessions: approved_by yalnızca SUBMITTED -> APPROVED geçişinde değişebilir (% -> %)', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'APPROVED' AND OLD.status <> 'APPROVED' THEN
    NEW.approved_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END
$fn$;
