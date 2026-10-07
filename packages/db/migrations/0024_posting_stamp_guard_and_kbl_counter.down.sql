-- 0024_posting_stamp_guard_and_kbl_counter geri alma (G-08): tetikleyici ve işlevi kaldırır. Veri kaybettirmez (yalnızca kural kalkar). Up'taki KBL sayaç yeniden kurulumu geri alınmaz (idempotent, yalnızca eksik/geri kalmış sayacı yükseltir; 0022 down'ı zaten sayaçları siler).
DROP TRIGGER documents_posting_stamp_guard ON public.documents;
DROP FUNCTION public.documents_posting_stamp_guard();
