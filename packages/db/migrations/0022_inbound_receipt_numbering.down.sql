-- 0022_inbound_receipt_numbering geri alma (G-08): CHECK'i 0017 haline daraltır.
-- VERİ KAYBETTİRİR: `INBOUND_RECEIPT` sıra satırı varsa (numaralı kabul belgesi var) yalnızca wms_meta.allow_destructive_down = 'on'
-- (WMS_ENV local|ci) iken çalışır ve o sıra satırları silinir. Sayım RLS'ten bağımsız olmalı (0003 down BLOKER-1): NO FORCE → sayım → FORCE.
DO $guard$
DECLARE
  has_rows boolean;
  allow boolean := coalesce(pg_catalog.current_setting('wms_meta.allow_destructive_down', true), '') = 'on';
BEGIN
  ALTER TABLE public.number_sequences NO FORCE ROW LEVEL SECURITY;
  SELECT EXISTS (SELECT 1 FROM public.number_sequences WHERE document_kind = 'INBOUND_RECEIPT') INTO has_rows;
  IF has_rows AND NOT allow THEN
    RAISE EXCEPTION '0022_inbound_receipt_numbering down: public.number_sequences tablosunda INBOUND_RECEIPT satırı var; veri kaybettiren geri alma bu ortamda kapalı';
  END IF;
  DELETE FROM public.number_sequences WHERE document_kind = 'INBOUND_RECEIPT';
  ALTER TABLE public.number_sequences FORCE ROW LEVEL SECURITY;
END
$guard$;

ALTER TABLE public.number_sequences DROP CONSTRAINT number_sequences_kind_chk;
ALTER TABLE public.number_sequences
  ADD CONSTRAINT number_sequences_kind_chk
  CHECK (document_kind IN ('STOCK_IN', 'STOCK_OUT', 'STOCK_MOVE', 'REVERSAL', 'COUNT_ADJUSTMENT')) NOT VALID;
ALTER TABLE public.number_sequences VALIDATE CONSTRAINT number_sequences_kind_chk;
