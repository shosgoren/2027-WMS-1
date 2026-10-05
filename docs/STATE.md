# STATE (≤80 satır — her görev sonunda Supervisor günceller)

**Faz:** 0 — Kararlar & iskelet
**Aktif görev:** —
**Son tamamlanan:** Bootstrap (şartname parçalara bölündü)
**Sonraki adım:** Faz 0 karar görüşmesi: `docs/PHASES.md` Faz 0 karar listesini kullanıcıya tek mesajda, önerili seçeneklerle sor; cevapları ADR-001… olarak yaz.

## Kuyruk (sıralı)
- [ ] T-001 Faz 0 kararları → ADR'ler
- [ ] T-002 Monorepo iskeleti + docker compose + `pnpm verify`
- [ ] T-003 CI hattı
- [ ] T-004 `docs/STACK.md` sürüm kilidi + `docs/MAP.md` ilk sürüm
- [ ] T-005 Pooler spike: gerçek pooler arkasında `withTenant` + AC-05 ve AC-28 (geçmeden Faz 1 yok)
- [ ] T-006 Pilot tanımı → `docs/PILOT.md` (Faz 2 kart seti buna göre çıkarılır)
- [ ] T-007 `pnpm test:ac --phase N` komutu: `@AC-xx` etiketli testleri koşturur, etiketli testi olmayan AC'yi hata sayar, koşullu AC'leri `ACCEPTANCE.conditions.json`'a göre ekler/atlar
- [ ] T-008 Mekanik bekçiler (`pnpm check:all`, `check:pilot`) + commit öncesi kanca + CI'da zorunlu; AC-37 ve AC-44 ile doğrulanır
- [ ] T-009 Güven kökü (ADR-012): ajan için ayrı GitHub kimliği, `main` branch protection, CODEOWNERS = kullanıcı, bypass kapalı; AC-43 ile doğrulanır. **Kullanıcı eylemi gerektirir** (GitHub ayarları)

## Engeller
—

## Açık sorular (özet; detay OPEN_QUESTIONS.md)
—
