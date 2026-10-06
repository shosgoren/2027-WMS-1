-- 0015_serials_lock_grant geri alma: yalnızca yetki ve tetikleyici; veri kaybı yok (bekçi gerekmez).
REVOKE UPDATE (created_at) ON public.serials FROM wms_app;
DROP TRIGGER serials_reject_update ON public.serials;
DROP FUNCTION public.serials_reject_update();
