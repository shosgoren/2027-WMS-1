-- 0005_security_event_writers geri alma: kimlik olayı yazar kısıtını kaldırır.
-- VERİ KAYBETTİRMEZ: yalnızca tetikleyici ve işlev düşer; security_events satırlarına (FORCE RLS yok, append-only
-- tablo) dokunulmaz → veri kaybı bekçisi gerekmez. DİKKAT: geri alma güvenlik kısıtını gevşetir (wms_app yeniden kimlik
-- olayı yazabilir); yalnızca ileri/geri/ileri testleri ve acil durum için.
DROP TRIGGER security_events_identity_writers ON public.security_events;
DROP FUNCTION public.security_events_restrict_identity_writers();
