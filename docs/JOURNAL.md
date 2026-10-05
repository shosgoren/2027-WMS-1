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
