-- 0024_posting_stamp_guard_and_kbl_counter (T-275 / T-222 MINOR-4; G-08 genişlet–taşı–daralt): `posting_mfa_verified_at` ve `posting_idempotency_record_id`
-- (0023) yalnızca `posting_job_id` NULL → dolu geçişini yapan AYNI UPDATE ifadesinde DOLU değere yazılabilir (posting.ts deferToWorker).
-- Bunun dışındaki her UPDATE (kilit zaten doluyken damga yazma/değiştirme, kilitsiz damga yazma, kilit değiştirirken damga yazma) reddedilir:
-- MFA damgası uygulama hatası/yan yol ile sonradan eklenemez (ADR-014 §12 fail-closed).
--
-- BİLİNÇLİ KARARLAR (inceleme için):
-- * Yalnızca GENİŞLETME (yeni tetikleyici); sütun/veri/yetki değişmez, taşınacak veri yok.
-- * TEMİZLEME serbesttir (yeni değer NULL): command.ts assignNumber, jobs.ts failPostingInTx ve her kilit kaldırma yolu damgaları NULL'lar.
-- * Değeri DEĞİŞTİRMEYEN yazım (IS NOT DISTINCT FROM) serbesttir (no-op).
-- * Yalnızca UPDATE: INSERT'te damga zaten 0023 CHECK'i ile `posting_job_id` doluluğuna bağlıdır; belge işleme kilidiyle doğmaz.
-- * 0020 deseni: SECURITY INVOKER, sabit search_path, PUBLIC EXECUTE yok, 23514 hata kodu.
-- * T-305 MINOR-4 (0022 down→up çakışması): 0022 down izinli ortamda INBOUND_RECEIPT sıra satırlarını siler; numaralı kabul belgesi kalmışsa
--   0022 up sayacı 1'den başlatırdı (UNIQUE (tenant_id, number) çakışması). Bu migration `KBL-<YYYY>-<n>` numaralı mevcut belgelerden (tenant, dönem)
--   başına `next_value = max(n) + 1` kurar (var olan sayaç GEÇMEZ: GREATEST; sayaç geri gitmez). Taze veritabanında kabul belgesi yoktur → no-op.
--   (0022 up/down yeniden yazılmadı: sağlama toplamları değişmez.) Sayım/yazım RLS'ten
--   bağımsız olmalı (0003 down BLOKER-1): NO FORCE → işlem → FORCE.
-- Koşturucu tek transaction içinde çalıştırır.

DO $pre$
BEGIN
  IF pg_catalog.to_regclass('public.documents') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = 'public.documents'::pg_catalog.regclass AND attname = 'posting_mfa_verified_at' AND NOT attisdropped) THEN
    RAISE EXCEPTION '0024_posting_stamp_guard_and_kbl_counter: 0023 önkoşulu yok (public.documents.posting_mfa_verified_at)';
  END IF;
END
$pre$;

DO $reseed$
BEGIN
  ALTER TABLE public.number_sequences NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE public.inbound_receipts NO FORCE ROW LEVEL SECURITY;
  INSERT INTO public.number_sequences (tenant_id, document_kind, period, next_value)
  SELECT r.tenant_id, 'INBOUND_RECEIPT', split_part(r.number, '-', 2), max(split_part(r.number, '-', 3)::bigint) + 1
    FROM public.inbound_receipts r
   WHERE r.number ~ '^KBL-[0-9]{4}-[0-9]{6,18}$'
   GROUP BY r.tenant_id, split_part(r.number, '-', 2)
  ON CONFLICT (tenant_id, document_kind, period)
  DO UPDATE SET next_value = GREATEST(public.number_sequences.next_value, EXCLUDED.next_value);
  ALTER TABLE public.inbound_receipts FORCE ROW LEVEL SECURITY;
  ALTER TABLE public.number_sequences FORCE ROW LEVEL SECURITY;
END
$reseed$;

CREATE FUNCTION public.documents_posting_stamp_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF (NEW.posting_mfa_verified_at IS NOT NULL AND NEW.posting_mfa_verified_at IS DISTINCT FROM OLD.posting_mfa_verified_at)
     OR (NEW.posting_idempotency_record_id IS NOT NULL AND NEW.posting_idempotency_record_id IS DISTINCT FROM OLD.posting_idempotency_record_id) THEN
    IF OLD.posting_job_id IS NOT NULL OR NEW.posting_job_id IS NULL THEN
      RAISE EXCEPTION 'POSTING_STAMP_GUARD: işleme bağlamı (MFA damgası / idempotency kaydı) yalnızca posting_job_id NULL → dolu geçişinde yazılabilir' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.documents_posting_stamp_guard() FROM PUBLIC;
CREATE TRIGGER documents_posting_stamp_guard BEFORE UPDATE OF posting_mfa_verified_at, posting_idempotency_record_id, posting_job_id ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.documents_posting_stamp_guard();
