-- 0021_easy_setup_indexes geri alma (G-08): yalnızca indeksler düşer; veri kaybı yok (bekçi gerekmez).
DROP INDEX public.locations_search_code_idx;
DROP INDEX public.audit_logs_tenant_bulk_ref_idx;
