# Test karantinası

PROTOCOL §Karantina kuralı · AC-44 · denetim: `pnpm check:tests` (`scripts/guards/lib/quarantine.mjs`), sonuç: `pnpm test:ac`.
Korunan dosya: her satır ekleme/değişikliği §Onay kaynağı (ADR-012 rev.) onayı ister (`check:protected`).

Kurallar (makinece uygulanır):
- Karantina atlama değildir: test `@quarantine Q-xx` etiketiyle (test veya describe **başlığında**) normal koşar; sonucu `QUARANTINED_PASS` / `QUARANTINED_FAIL` olarak raporlanır, kırmızısı yalnızca kayıt geçerliyse kapıyı kırmaz. `skip`/`only`/`todo` yine yasak.
- Etiket ancak kayıt satırı `main`'de birebir bulunduğunda geçerlidir. Bu yüzden iki adım: (1) bu tabloya satır ekleyen onaylı PR birleşir; (2) testi etiketleyen PR açılır. Kayıt PR'ında etiket olursa `QUARANTINE_NOT_APPROVED`.
- Kapısı değerlendirilen fazın (`docs/ACCEPTANCE.conditions.json` `currentGatePhase`) `@AC` testi karantinaya alınamaz (`QUARANTINE_GATE_AC`).
- Bitiş tarihi ≤ eklendiği tarih + 14 gün (`QUARANTINE_TOO_LONG`) ve sonraki faz kapısından önce; bitiş geçince (UTC) CI kırmızı (`QUARANTINE_EXPIRED`): test düzeltilir ya da kayıt yeniden onaylanır.
- Tarihler `YYYY-MM-DD`; Dosya depo köküne göre yol; Sahip kart `T-xxx`.

| Q | Test adı | Dosya | Neden | Sahip kart | Eklendiği tarih | Bitiş tarihi |
|---|---|---|---|---|---|---|
