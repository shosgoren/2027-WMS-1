-- 0020_target_status_guard geri alma (G-08): up'ın yarattığı tetikleyici ve işlevi kaldırır. Veri kaybı yoktur (yalnızca kural kalkar).
DROP TRIGGER stock_move_target_status_guard ON public.document_lines;
DROP FUNCTION public.stock_move_target_status_guard();
