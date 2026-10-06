# JOURNAL (tek satır / görev; Supervisor yazar, ajanlar istenmedikçe okumaz)
- 2026-10-05 Bootstrap: master v3.6 parçalara bölündü.
- 2026-10-05 T-001/T-001b ADR-001…012 önerildi; Faz 0 kart seti yazıldı; Q-09 kapandı; E-01 ortam engeli (npm/pip/Docker Hub 403).
- 2026-10-05 T-006 PILOT.md (varsayımsal); Q-08 Etkin WMS; ADR-012 ayrı kimlik yok kaydı.
- 2026-10-05 ADR-012 rev.: kullanıcı PR incelemez, Supervisor birleştirme kapısıyla birleştirir; ADR-001…012 kabul; ADR-013 Fly.io+GitHub Actions; I-17/AC-43/AC-44 yeni onay kuralına uyarlandı; E-01 kapandı.
- 2026-10-05 #1 iskelet, #3 STACK/MAP, #2+#4 CI (5 güvenlik turu), #8 test:ac+bekçiler-1 (3 tur) main'de; pooler paketi T-005a/b/c/g + T-015 entegrasyon; bekçiler-2 T-008d/f birleşti, T-008e sürüyor; T-010 Fly staging; kullanıcı Neon/Fly/Resend sırlarını ekledi.
- 2026-10-05 Faz 1 plan güvenlik 3. tur @b400466: BLOCKER 0 · MAJOR 0 · MINOR 8 → kartlara işleniyor; T-110 başladı; #25 T-109, #26 T-008k, #27 T-005d düzeltmesi CI kuyruğunda.
- 2026-10-05 20:15Z E-02 runner kapasitesi; #26 T-008k güvenlik @524ce26 BLOCKER 1 (tazelik ağaç girdisiyle yeniden yazılıyor); Faz 1 plan delta @251503f BLOCKER 0 · MAJOR 0 · MINOR 6 (işleniyor); #28 T-110 açıldı (güvenlik 0/0/4).
- 2026-10-05 20:35Z #29 Faz 1 planı açıldı (6 güvenlik turu, son @8335c6b 0·0·6, ADR-014/015/016 kabul); int/faz1-sema açıldı, T-101 başladı.
- 2026-10-05 20:50Z T-008k @a425180 0·0·2; T-005d düzeltmesi 0·0·5; T-101 #30 0·0·8 (→T-101d); T-101b 0·0·3 (→T-101c); T-102 MAJOR 1 (security_events zaman damgası) düzeltiliyor; E-02 sürüyor, gereksiz push koşuları iptal edildi.
- 2026-10-05 21:45Z int/faz1-sema yığını: T-101b/c/d, T-102, T-103 (BLOCKER down bekçisi + MAJOR grant eşleşmesi düzeltildi, son inceleme 0·0·5 → düzeltildi), T-104 QA AC-04/AC-18 PASS; T-110b; T-107 başladı. E-02 sürüyor.
- 2026-10-05 22:45Z #25 T-109 ve #27 T-005d düzeltmesi birleşti; neon-spike koşu 2: Q-01…Q-06 ölçüldü (PG 18.6, düz parola), AC-05 pool=1 gecikme zaman aşımı → #31; T-005e PG 18 hazır; T-107 5 inceleme turu; T-108, T-111, T-112 başladı.

## 2026-10-05 23:30Z — Supervisor turu
- #31 (T-005d gecikme ölçümü) CI yeniden koşu yeşil → main (9f96a6b); neon-spike koşu 3 dispatch (run 37388724069).
- #26 T-008k tüm işler yeşil → int/faz0-kapanis (b012964).
- #28 T-110: E-02 nedeniyle iptal olan int/infra/deps işleri yeniden koşturuldu.
- T-112c kartı yazıldı (int/faz1-sema 83fe4ff): kimlik olaylarını yalnızca wms_auth yazar; T-102/T-112 inceleme takibi.

## 2026-10-05 23:55Z — Supervisor turu
- Neon koşu 3 PASS (https://github.com/shosgoren/2027-WMS-1/actions/runs/37388724069): Q-01…Q-06 yanıtlandı (PgBouncer sürümü gözlenemedi), AC-05 pool1/2 + AC-28 + harness PASS (kapı ve tanı koşuları). T-005f architect'e verildi.
- #33 T-005e (compose PG 18.6, korunan; inceleme 0·0·2) → int/faz0-neon. #28 T-110 → int/faz1-ui-temel (iptal işler yeniden koşuldu, hepsi yeşil).
- T-115: T-115b incelemesi BLOCKER (index.ts→migrate.ts worker bundle'ında; açılışta migrate main) → kök T-115'te düzeltildi (connection-target.ts + gerileme testi + Dockerfile bundle kontrolü). Son: T-115 0·0·1, T-115b 0·0·0.
- T-112b: A-41 e-posta kilidi T-112 IP testinin öncülünü bozdu → kart eki (farklı e-postalar, assertion sayısı korunur) → test:int 245/245. reauth.succeeded T-112c'ye devredildi.
- T-116 kapsam eki (shared exports, MAIL_FROM, platform işi). T-113, T-112c başlatıldı.

## 2026-10-06 00:20Z — FAZ 0 KAPI RAPORU (Supervisor, ADR-012 rev. §3)
- `main` c6103a7 (#36 int/faz0-neon + #37 int/faz0-kapanis birleşik).
- `pnpm test:ac -- --phase 0` → 5 AC · PASS 5 · FAIL 0 · NO_TEST 0 · SKIPPED 0 (AC-05 4 test, AC-28 105, AC-37 78, AC-43 12, AC-44 11); ayrıntı `.artifacts/test-ac/0.json` (yerel).
- `pnpm check:pilot` OK · `pnpm verify` lint OK · typecheck OK · unit OK (904 test) · `check:all` CI'da #36/#37'de yeşil (yerelde main ayrık HEAD → scope GIT_ERROR; kart yok).
- Neon gerçek pooler: koşu 3 PASS (https://github.com/shosgoren/2027-WMS-1/actions/runs/37388724069); ADR-004 teknik alanları dolduruldu (Q-01…Q-06; Q-02 PgBouncer sürümü gözlenemedi).
- **Bilinen risk (ADR-012):** onay değişikliği yapan sistemden bağımsız değil; mekanik bekçiler + bağımsız security-reviewer ile azaltıldı.
- Açık takipler: T-008j (bekçi MINOR'ları + taban birleştirmesinde scope/protected yanlış pozitifleri + protected.test.mjs yük altında 5 s zaman aşımı), A-56 düz parola (yalnızca spike), Q-31/Q-32.
- Faz 1'e geçildi.

## 2026-10-06 00:25Z — Supervisor turu (gece)
- Birleşenler: #35 T-005f, #36, #37 (main), #34 T-110b, #33 T-005e, #28 T-110. Açık: #38 T-110c.
- T-115/T-115b: BLOCKER (migrate.ts worker bundle'ında) kökten düzeltildi → 0·0·1 / 0·0·0. T-116: 0·0·7 → 3 MINOR düzeltildi → 0·0·6 (kalanlar T-105/T-117 eklerinde).
- T-112b: 0·2·7 (e-posta kilidi TOCTOU, sosyal örtük kayıt) → düzeltildi → 0·0·3 (T-114). T-113: 0·0·5 → 0·0·2. T-112c: T-112b ile birleşti (262/262), inceleme sürüyor. T-110c 0·0·3 (T-131).
- Yeni kartlar: T-105c (operasyon rolü), T-110c, T-112c, T-133 (hata kodları); ekler: T-105, T-112b, T-113, T-114, T-115, T-115b, T-115c, T-116, T-117.

## 2026-10-06 00:45Z — Supervisor turu
- #29 Faz 1 planı → main (413a547 tazeleme 0·0·8). #38 T-110c → int/faz1-ui-temel. #30 kapatıldı (T-101 #39 içinde).
- int/faz1-sema dilimi kuruldu (main + 7 kart), entegrasyon düzeltmeleri (KNOWN_APP_SETTINGS, drift importu, PG 18.6 nonsuper testi), paket incelemesi 0·1·2 → 0·0·1; #39 açıldı.
- T-112c düzeltmeleri 0·0·2 ile geçti; T-133 hata kodu listesi yazıldı.
- int/faz1-auth entegrasyonu sürüyor (T-101d × T-115 connection-target çakışması).

## 2026-10-06 01:45Z — Supervisor turu
- E-03: 00:32Z'den beri Actions işleri başlamıyor (tüm dallar, docs-only dahil; yeniden koşu da aynı) → U-08 kullanıcıya (Actions dakika/harcama sınırı). Birleştirme durdu.
- Hazır: #39 (şema dilimi), #40 (ui dilimi), int/faz1-auth paketi (0·0·2; T-113 × T-115 connection-target çakışması sertleştirilmiş sürümle çözüldü; kuyruk kartları auth dilimine).
- Yeni kartlar: T-109b (paket bağlantıları ✓), T-116b, T-117c (not), T-105c→0007. Kararlar: T-117 B seçeneği (probe salt okunur; tek okuma işlevi + token bağlı withInvitationTenant). OPEN_QUESTIONS: Q-33, A-57…A-59.
- T-121 ✓, T-125 MAJOR düzeltiliyor, T-117 inceleniyor.

## 2026-10-06 02:45Z — Supervisor turu
- E-03 sürüyor (Actions). Yerel hat: T-117 (davet; 0006 tek okuma işlevi + withInvitationTenant; teslim tx dışı; web kuyruğu; getAppDb) ✓, T-118 (kimlik ekranları; Principal isDemo/twoFactorEnabled) ✓, T-121 ✓, T-125 (bağlam üreticisi storage iç modülü) ✓, T-127a lint sınırları ✓ (0·0·0), T-116b ✓ (kritik bulgu → T-115c öncelik).
- Yeni kartlar: T-116c, T-127a, T-109b; ekler: T-115c (öncelik + job.output), T-129 (log maskeleme), T-118 (QR/önizleme kararları).
- Tekrarlayan kırılganlık: scripts/guards/protected.test.mjs 5 s zaman aşımı (paralel ajan yükü) → T-008j önceliği.
