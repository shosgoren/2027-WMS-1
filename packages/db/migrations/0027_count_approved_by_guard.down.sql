-- 0027_count_approved_by_guard geri alma (G-08): tetikleyici işlevi gövdesini 0017'deki haline döndürür. Veri kaybı yoktur (yalnızca kural gevşer).
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
  IF NEW.status = 'APPROVED' AND OLD.status <> 'APPROVED' THEN
    NEW.approved_at := pg_catalog.now();
  ELSIF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    NEW.approved_at := CASE WHEN NEW.approved_by IS NULL THEN NULL ELSE pg_catalog.now() END;
  END IF;
  RETURN NEW;
END
$fn$;
