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

## 2026-10-06 03:45Z — Supervisor turu
- E-03 sürüyor (Actions: 03:35Z koşuları 4 s'de logsuz FAIL). Birleştirme yok; yerel hat tam kapasite.
- T-117b HAZIR @ee15ffa: B1 (saklanan yönetici kimliği belirteç olarak kullanılabiliyordu) → `reset-password:h.<özet>` + before kancasında belirteç biçimi kısıtı (POST ve GET); MINOR 1/2/3/5 ve yeniden inceleme MINOR'ları kapandı; son inceleme 0·0·0, identity 96/96, tam test:int 483/483.
- T-115c: inceleme 0·1·6 → job.output temizliği (SanitizedJobError, safeErrorName), platform işi görünürlüğü nullif, RLS+yetki tek tx, job üst tablo INSERT kaldırıldı, MFA testi; yeniden 0·0·2 → 0·0·1 (son tek satır). Q-34/A-60 (FORCE RLS altında pg-boss bakımı).
- T-127: CSP nonce, Origin denetimi, DB hız sınırı üretimde bağlı (`@wms/db consumeRateLimit`). İnceleme 0·2·11 → MAJOR tenant kovası istemci slug'ıyla tüketiliyordu (DoS) → doğrulanmış tenant; server-only worker/vitest'i bozduğu için T-127b (korunan lint kuralı) kartına taşındı.
- T-119 DUR (okuma verisi yok) → T-119a kartı (domain okuyucuları). T-119a inceleme 0·1·7: liste yolunda `users FOR UPDATE` kilidi (tenant'lar arası login bekletme) → karar: liste probsuz, `resetLinkAvailable` iyimser, kesin karar sıfırlama komutunda; A-61 (üye listesi görünürlüğü).
- T-008l: protected.test kök nedeni (git spawn 2092→~1550, 4×paralel 5 tur yeşil). İnceleme BLOCKER 2 · MAJOR 2: check:scope gevşemişti (geri alma, sahte merge, uç öneki, iç merge konusu) → kart keşfi değişikliği geri, taban birleştirme düşürmesi yalnızca dar biçimde; negatif testler.
- T-116c başladı (taban T-116b + T-117).
- Yeni kayıtlar: T-119a, T-127b kartları; T-115c/T-127/T-117b/T-119 ekleri; T-105, T-129, T-131 notları; Q-34, A-60, A-61.

## 2026-10-06 04:45Z — Supervisor turu
- E-03 sürüyor (04:42Z koşuları 3 s'de logsuz FAIL). Birleştirme yok.
- T-008l HAZIR @eea351e: check:scope gevşemesi tamamen geri alındı (scope.mjs/cards.mjs c181ac5 ile birebir), A–D saldırıları negatif testlerle FAIL, protected.test spawn azaltma + SHA anahtarlı fileAtRef önbelleği; yeniden inceleme 0·0·1 (önceden var olan revParse MINOR → T-008m adayı).
- T-115c 932dab0 (son kontrol 0·0·1 kapandı; queue 52/52) — verify yalnızca protected.test yük zaman aşımı; düşük yükte tekrar.
- T-127 yeniden inceleme 0·1·5: MAJOR-1 kapandı; yeni MAJOR saate bağlı üretim guard testi (dakika sınırında kırılıyor) → sabit saat; Fly-Client-IP varsayımı → T-105.
- T-119a 0·1·7 → 0·0·3 (liste probsuz, membershipId, maskEmail); T-119 UI tamam (rol değişimi gerçek DB'de, bağlantı yenilemede yok), inceleme 0·0·3.
- T-116c 0·1·2 → 0·0·1 (web eylem testi mutasyonla kanıtlandı).
- T-123 (demo seed) 0·0·4; hesap bağdaştırıcısı T-123a kartına ayrıldı; A-62; T-105/T-106 notları. Ajan trailer'ı yanlış model adıyla yazmıştı → kart dalında amend.
- Yük notu: load 16–30; protected.test (5 s) ve migrations.int (30 s) zaman aşımları yük kaynaklı, eşikler gevşetilmedi.

## 2026-10-06 05:45Z — Supervisor turu
- E-03 sürüyor. Repo private (doğrulandı); işler adım çalışmadan 1–2 s'de düşüyor → büyük olasılıkla ücretsiz plan Actions kotası (2000 dk/ay) doldu. Kullanıcı 08:30 TR'de durum sordu; seçenekler (kart + Actions bütçesi önerisi / public / ay başını bekleme) ve public'in güvenlik etkisi açıklandı; karar bekleniyor.
- HAZIR olanlar: T-116c 0203602, T-119a eb6c733, T-119 0ed52df (error.tsx — Next 16 retry() kurulu dokümanla doğrulandı), T-123 a4a5fb7, T-127 e11695f (son kontrol 0·0·2; MINOR'lar T-131), T-127b 6a943ff (istemci içe aktarım grafı testi fail-closed; 0·0·2 gelecek notları).
- T-123a: BLOCKER (worker argon2 statik import → imajda yok, worker çöker) kapandı — createRequire ile ilk kullanımda, Dockerfile @node-rs kopyası, imajda kanıt; devralma koruması A-64 (ayrılmış alan, migration yok); A-63 worker wms_auth yalnızca demo. Yeniden inceleme 0·0·5.
- T-129 (izleme): log maskeleme, request ID, derin sağlık, uptime.yml. İnceleme 1·2·7 — kimliksiz ReDoS (proxy her istekte maskeleme regex'i), sağlık yoklaması havuzu tüketebiliyor, gömülü key:value maskelenmiyor → düzeltiliyor; sığ /api/health/live Fly için.
- Entegrasyon düzeltmeleri (dilim birleşiminde tekrar): T-117b×T-116b memberships.ts `tenantId: null`; T-115c×T-116c STACK.md; T-116c×T-127 actions.ts (kip denetimi önce, limitVerifiedTenant sonra) + actions.test.ts hız sınırı/tenant mock'ları.
- Kayıtlar: A-62, A-63, A-64; T-123a, T-127b kartları; T-105 (Fly-Client-IP, DEMO_PASSWORD, prod migrate ortamı), T-106 (staging migrate/DEMO_*), T-131 notları.

## 2026-10-06 06:45Z — Supervisor turu
- E-03 sürüyor (06:41Z 3 s'de FAIL). Kullanıcı kararı bekleniyor (Actions bütçesi / public).
- HAZIR: T-123a e002035 (Dockerfile korunan; son kontrol 0·0·1 → T-106 staging demo/argon2 doğrulaması), T-129 ce74c03 (ReDoS BLOCKER kapandı; maskeleme turları 1·2·7 → 0·0·6 → 0·0·3 → kapandı; uptime.yml son rapor sonrası değişmedi), T-122a eeb6c60 (A-65; now genel API'den çıktı).
- T-122: landing, demo girişi (demo-config ortak karar, DEMO_EMAIL_DOMAIN fail-closed), sihirbaz (POST + httpOnly taslak çerezi, sabit requestId, guard), ana ekran + "Bugün yaptıkların" + ayarlar (47 IANA saat dilimi sabit listesi); inceleme turları 0·1·6 → 0·0·3 → 0·0·2; son tur sürüyor.
- Yeni kartlar: T-122a. Kayıtlar: A-65; T-106, T-131 notları (layout next hedefi, demo giriş sayacı, maskeli members logu, saat dilimi tek kaynak, toplam karakter bütçesi, CSP oturumlu denetim, isProductionEnv tek kaynak).
