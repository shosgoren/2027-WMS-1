# STATE (≤80 satır — her görev sonunda Supervisor günceller)

**Faz:** 0 — Kararlar & iskelet
**Aktif görev:** — (kod kartları ortam engeli yüzünden bekliyor, bkz. Engeller)
**Son tamamlanan:** T-006 PILOT.md (varsayımsal ambalaj profili, A-11…A-35); ürün adı "Etkin WMS" (Q-08); T-009a K2 = ayrı kimlik yok (ADR-012)
**Sonraki adım:** Engel E-01 çözülünce T-002a (devops) başlar. Kullanıcı bulut ortamın ağını açacak (E-01); açılınca npm/Docker Hub yeniden denenir. `chore/bootstrap` ve `int/faz0-plan` PR'larını kullanıcı birleştirir (I-17: ADR'ler PR onayıyla "kabul" olur).

## Kararlar (özet; detay DECISIONS.md)
ADR-001 Next.js + ayrı worker · ADR-002 İngilizce kod/DB, Türkçe UI · ADR-003 Drizzle · ADR-004 Neon (teknik alanlar T-005) · ADR-005 Postgres kuyruğu · ADR-006 S3 uyumlu · ADR-007 AB bölgesi + hukukçu onayı · ADR-008 4S'e ertelendi · ADR-009 sert tahsis · ADR-010 keystroke · ADR-011 taşıma birimi modeli Faz 2 · ADR-012 ayrı GitHub kimliği (henüz yok)

## Kuyruk (bağımlılık sırası; kartlar docs/tasks/)
- [x] T-001 / T-001b Faz 0 kararları → ADR'ler
- [ ] T-002a Kök pnpm çalışma alanı + `pnpm verify` → `int/faz0-iskelet`
- [ ] T-002b Web iskeleti · T-002c Worker iskeleti (seri, lock dosyası) · T-002d docker compose (T-002a sonrası paralel)
- [ ] T-003 CI hattı → `int/faz0-ci` (iskelet birleşince)
- [ ] T-004 STACK sürüm kilidi + MAP → `int/faz0-docs` (iskelet birleşince)
- [ ] T-005a entegrasyon test düzeneği → T-005b `withTenant` (security-reviewer zorunlu) → T-005c AC-05/AC-28 (qa-verifier) → `int/faz0-pooler`
- [ ] T-005d Neon gerçek pooler koşusu (**kullanıcı eylemi**: Neon hesabı + bağlantı dizesi sır kanalından) → T-005e CI eşdeğerliği → `int/faz0-neon`
- [x] T-006 PILOT.md — varsayımsal profil; değerler gerçek pilotla doğrulanacak (Q-12, en geç Faz 3A başı)
- [ ] T-007 `pnpm test:ac` → T-008a/b/c bekçiler → `int/faz0-bekciler-1`
- [ ] T-008d/e/f/g bekçiler (T-008g için T-009a birleşmiş olmalı) → `int/faz0-bekciler-2`
- [ ] T-009a Güven kökü — K2: ayrı kimlik yok (bilinen risk, ADR-012); kalan: CODEOWNERS PR'ı, `main` için PR zorunlu + force push kapalı (zorunlu CODEOWNERS onayı açılmaz) · T-009b canlı AC-43

## Engeller
- **E-01 (2026-10-05):** Bu bulut çalışma alanında kuruluş ağ politikası npm, pip ve Docker Hub'ı 403 ile kapatıyor (yerelde Docker daemon ve PostgreSQL 16 ikilisi var, PgBouncer yok). Paket kurulamadığı için T-002 ve sonrası burada yürütülemez. Kural: dolanılmaz, raporlanır.

## Supervisor kararı bekleyen tasarım noktaları (T-006…T-009 kart raporu)
- T-007 `test:ac --ci`: PR'da mevcut `@AC` testleri koşar, `NO_TEST` yalnızca kapısı geçilmiş fazlar için hata → T-007 PR'ında kullanıcı onayıyla kesinleşir
- `check:pilot` `check:all`'a girmez; Faz 0 kapısında ayrıca denetlenir
- Karantina: `skip` hiç serbest değil; karantinalı test koşar, kapıyı kırmaz

## Açık sorular (özet; detay OPEN_QUESTIONS.md)
Q-01…Q-06 Neon teknik alanları (T-005) · Q-07 KVKK hukukçu onayı · Q-12 pilot değerleri · Q-13 pilot hacim tanımı · Q-10 Neon sır kanalı · Q-11 BullMQ eşikleri
