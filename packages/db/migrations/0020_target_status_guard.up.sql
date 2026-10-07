-- 0020_target_status_guard (T-258; T-248 inceleme MINOR-2): document_lines.target_stock_status DB düzeyinde STOCK_MOVE'a ve izinli çifte bağlanır.
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * Kural, uygulama katmanıyla (packages/domain/src/stock/plan.ts ALLOWED_STATUS_TRANSITION_PAIRS, A-154/A-248-1) AYNI listedir:
--   hedef durum NULL değilse (a) üst belge türü STOCK_MOVE olmalı, (b) (stock_status, target_stock_status) çifti ya aynı durum ya da
--   yalnızca QUARANTINE>AVAILABLE / AVAILABLE>QUARANTINE olmalı. SQL'deki sabit liste ile TS listesinin eşitliği
--   tests/integration/stock/posting.int.test.ts'te 4x4 durum çifti üzerinden doğrulanır. Matris genişlemesi (Q-49) iki yeri birlikte değiştirir.
-- * CHECK değil TETİKLEYİCİ: kural üst belge türünü (başka tablo) okur. Tetikleyici SECURITY INVOKER; documents okuması RLS altında
--   yapılır (satırın kendi tenant'ı bağlamdadır). BEFORE INSERT OR UPDATE OF (target_stock_status, stock_status, document_id).
--   Varsayılan ENABLE ORIGIN: yalnızca olağanüstü süper kullanıcı bakımı (session_replication_role=replica) atlatabilir; posting
--   denetimi (savunma derinliği) bu durumda yine reddeder.
-- * Genişlet–taşı–daralt: yalnızca yeni işlev + tetikleyici (sütun/veri değişmez). Mevcut satırlar için "taşı" adımı bir doğrulamadır:
--   kuralı ihlal eden satır varsa migrasyon yüksek sesle başarısız olur (T-248 öncesi kod hedef durumu yalnız STOCK_MOVE'da saklıyordu).
-- * Yetki değişmez (0016 GRANT'ları aynen kalır).

-- Sayım RLS'ten bağımsız olmalı (tablo sahibi FORCE RLS altındadır; tenant bağlamı olmadan 0 satır görür → bekçi sessizce geçerdi; 0003/0016
-- deseni): sayımdan önce NO FORCE, sonra FORCE geri (koşturucu tek transaction'dır; RAISE hepsini geri alır).
DO $guard$
BEGIN
  ALTER TABLE public.documents NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE public.document_lines NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (
    SELECT 1
      FROM public.document_lines l
      JOIN public.documents d ON d.tenant_id = l.tenant_id AND d.id = l.document_id
     WHERE l.target_stock_status IS NOT NULL
       AND (d.kind <> 'STOCK_MOVE'
            OR (l.target_stock_status <> l.stock_status
                AND (l.stock_status || '>' || l.target_stock_status) NOT IN ('QUARANTINE>AVAILABLE', 'AVAILABLE>QUARANTINE')))
  ) THEN
    RAISE EXCEPTION '0020_target_status_guard: kuralı ihlal eden document_lines.target_stock_status satırı var; önce düzeltilmeli';
  END IF;
  ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;
  ALTER TABLE public.document_lines FORCE ROW LEVEL SECURITY;
END
$guard$;

CREATE FUNCTION public.stock_move_target_status_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  parent_kind text;
BEGIN
  IF NEW.target_stock_status IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT d.kind INTO parent_kind FROM public.documents d WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.document_id;
  IF parent_kind IS DISTINCT FROM 'STOCK_MOVE' THEN
    RAISE EXCEPTION 'TARGET_STATUS_KIND: hedef stok durumu yalnızca STOCK_MOVE belgesinde kullanılabilir (belge türü %)', coalesce(parent_kind, '(yok)') USING ERRCODE = '23514';
  END IF;
  IF NEW.target_stock_status <> NEW.stock_status
     AND (NEW.stock_status || '>' || NEW.target_stock_status) NOT IN ('QUARANTINE>AVAILABLE', 'AVAILABLE>QUARANTINE') THEN
    RAISE EXCEPTION 'TARGET_STATUS_TRANSITION: izinsiz stok durumu geçişi % > % (A-154)', NEW.stock_status, NEW.target_stock_status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.stock_move_target_status_guard() FROM PUBLIC;
CREATE TRIGGER stock_move_target_status_guard BEFORE INSERT OR UPDATE OF target_stock_status, stock_status, document_id ON public.document_lines
  FOR EACH ROW EXECUTE FUNCTION public.stock_move_target_status_guard();
