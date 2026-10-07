-- 0026_task_progress geri alma (ADR-015 §9, G-08): up'ın yarattığı tabloyu kaldırır (indeks, politika, kısıtlar, yetkiler tabloyla düşer).
-- VERİ KAYBI KABUL (ADR-025 §1): tablo yalnızca geçici adım ilerlemesi taşır; stok/defter/görev verisi taşımaz, kalıcı geçmiş değildir. Başka nesne bu tabloya bağlı değildir.
DROP TABLE public.warehouse_task_progress;
