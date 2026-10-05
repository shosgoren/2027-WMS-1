# CLAUDE.md — Rafta WMS (her oturumda otomatik yüklenir; kısa tutulur)

Çok kiracılı (multi-tenant) depo & stok yönetimi SaaS'ı. Modüler monolit, PostgreSQL + RLS, değişmez stok defteri.

## Oturum başlangıç ritüeli (her oturum, her ajan)
1. `docs/STATE.md` oku (≤80 satır). Başka hiçbir şeyi "genel bakış" için okuma.
2. Supervisor isen: "Sonraki adım"ı uygula. Alt ajansan: yalnızca sana verilen görev kartını (`docs/tasks/T-xxx.md`) ve kartın **Okuma listesi**ni oku.
3. Şartname gerekiyorsa önce `docs/spec/00-index.md` → yalnızca ilgili parça/bölüm.

## Altın kurallar (ihlal = görev başarısız)
- **G-01** Stok yalnızca `packages/domain` stok komutlarıyla değişir; bakiyeye doğrudan yazılmaz (bkz. `docs/INVARIANTS.md`).
- **G-02** Her tenant sorgusu transaction içinde, `set_config('app.current_tenant_id', $1, true)` ile; session-level ayar yasak.
- **G-03** Bilmediğin iş kuralını uydurma → `docs/OPEN_QUESTIONS.md`'ye `Q-xx` ekle, varsayımı `A-xx` olarak etiketle, kapalı bayrakla ilerle.
- **G-04** Kütüphane API'sini tahmin etme: sürüm `docs/STACK.md`'de; emin değilsen kurulu tip tanımını grep'le veya Context7 ile doğrula.
- **G-05** Var olduğunu doğrulamadığın dosya/fonksiyon/tabloya referans verme (önce `grep`/`glob`).
- **G-06** "Tamamlandı" demek için: `pnpm verify` çıktısının özet satırı + ilgili kabul senaryosu (`AC-xx`) testinin sonucu raporda olmalı. Çalıştırılmayan kontrol "çalıştırılmadı" diye yazılır.
- **G-07** Üretim kodunda sahte başarı, yutulan hata, gizli TODO yok. Ertelenen iş = kapalı feature flag + görev kaydı.
- **G-08** `main`'e doğrudan push yok. Dal: `feat/T-xxx-kisa-ad`, `fix/...`; bağlantılı kartlar `int/<dilim-adı>` entegrasyon dalında toplanıp paket olarak incelenir (PROTOCOL §2.5). Migration'lar genişlet–taşı–daralt; veri kaybettirmeyenlerde down migration zorunlu.
- **G-09** Sır, anahtar, gerçek kişisel veri repoya, loga, görev raporuna girmez.
- **G-10** Kartta yazmayan dosyaya dokunma. Kapsam dışı bulgu → rapora "Bulgular" olarak yaz, düzeltme. (`check:scope` CI'da zorlar.)
- **G-11** Kırmızı testi yeşile çevirmek için testi, assertion'ı, lint kuralını, CI veya test yapılandırmasını gevşetme; testi `skip`/`only` etme. Test yanlışsa bunu rapora yaz ve dur. (`check:tests`, `check:ac-ratchet`, `check:protected`, `check:assertions` zorlar.)

## Token disiplini
- Dosyayı tümüyle okumadan önce `grep -n` ile yerini bul, sadece ilgili satır aralığını oku.
- `node_modules`, `.next`, `dist`, lock dosyaları, `docs/_master/`, `docs/JOURNAL.md` (istenmedikçe) okunmaz.
- **Doğrulama tasarruf konusu değildir.** Yazdığın değişikliği `git diff` ile gözden geçir (tüm dosyayı yeniden okumaktan ucuzdur ama atlanmaz); doğruluğu typecheck, test ve ilgili AC ile kanıtla. Aracın hata vermemesi yalnızca dosyanın yazıldığını gösterir, içeriğin doğru olduğunu göstermez.
- Uzun çıktı (log, test dökümü) `.artifacts/` altına yazılır; raporda yalnızca yol + özet.
- Kod yapıştırarak rapor verme; dosya yolu ve satır aralığı ver.

## Komutlar
`pnpm verify` (lint+typecheck+unit, yalnızca hataları özetler) · `pnpm check:all` (mekanik bekçiler) · `pnpm test:int` (Testcontainers PostgreSQL, gerçek rol/RLS) · `pnpm test:e2e` · `pnpm db:migrate` · `pnpm db:reset` · `docker compose up -d` (postgres, pgbouncer — transaction mode, minio, mailpit; redis yalnızca ADR-005 broker seçtiyse)

## Haritalar
Şartname: `docs/spec/00-index.md` · Kurallar: `docs/INVARIANTS.md` · Kabul: `docs/ACCEPTANCE.md` · Fazlar: `docs/PHASES.md` · Kod haritası: `docs/MAP.md` · Kararlar: `docs/DECISIONS.md` · Sözlük: `docs/GLOSSARY.md` · Ajan protokolü: `docs/agents/PROTOCOL.md`
