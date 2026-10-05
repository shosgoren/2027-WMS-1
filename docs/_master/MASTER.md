# Rafta WMS — Master Şartname + Ajan İşletim Sistemi (v3.6)

**Tarih:** 5 Ekim 2026 · **Repo:** `git@github.com:shosgoren/2027-WMS-1.git`
**Kaynak:** `saas-1.md` (ürün vizyonu) + `wms_saas_master_architecture_specification-2.md` (v2.0 düzeltilmiş şartname) birleştirildi; eksikler tamamlandı.

> **Bu dosya bir başlangıç paketidir.** İlk oturumda Supervisor, §0 Bootstrap adımıyla bu dosyayı repo içinde küçük, bağımsız dosyalara böler. Bölmeden sonra **tek doğru kaynak parça dosyalarıdır**; master dosya arşivdir ve günlük çalışmada okunmaz. Ajanlar yalnızca görev kartlarında listelenen parçaları okur. Böylece her fazda tüm şartnameyi tekrar okumadan, düşük token tüketimiyle ve kalıcı durum kaydı üzerinden ilerlenir.

---

## 0. BOOTSTRAP — yalnızca ilk oturumda, sırayla

1. Repo erişimini kur, `main`'den `chore/bootstrap` dalını aç. (Ajan kimliği ve branch protection Faz 0'da T-009 ile kurulur; o tamamlanana kadar `main`'e birleştirmeyi yalnızca kullanıcı yapar.)
2. Bu dosyayı `docs/_master/MASTER.md` olarak repoya kopyala.
3. Aşağıdaki betiği `scripts/split_master.py` olarak kaydet ve çalıştır: `python3 scripts/split_master.py docs/_master/MASTER.md`. Betik, dosyadaki dosya işaretçileri arasındaki her bloğu belirtilen yola yazar (LLM ile kopyalama yapılmaz → sıfır token).
4. Oluşan dosya listesini kontrol et (`find docs .claude -name "*.md" | sort`), commit et: `chore: bootstrap agent OS and spec shards`.
5. `docs/STATE.md` içindeki "Sonraki adım" satırını izleyerek Faz 0 karar görüşmesine geç (`docs/PHASES.md` → Faz 0).
6. Bundan sonra **parça dosyaları tek doğru kaynaktır.** Şartname değişiklikleri yalnızca ilgili parçaya ve ADR'ye yazılır; master güncellenmez, bu yüzden zamanla eskir ve kural kaynağı olarak kullanılamaz. Master yalnızca arşivdir: bölme hatasından şüphelenildiğinde veya bir kuralın ilk hâli araştırılırken, ilgili bölüm `grep` ile bulunarak okunur.

```python
# scripts/split_master.py — master dosyayı parça dosyalara böler
import re, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
START = "<!-" + "- FILE: "          # işaretçi literal olarak bu betikte geçmesin diye parçalı
END = "<!-" + "- END FILE -" + "->"
pat = re.compile(re.escape(START) + r"(.+?) -" + r"->\n(.*?)" + re.escape(END), re.S)
force = "--force" in sys.argv
for path, body in pat.findall(src):
    p = pathlib.Path(path.strip())
    if p.exists() and not force:
        print("SKIP (var):", p); continue
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body.strip() + "\n", encoding="utf-8")
    print("OK:", p)
```

> Ortam `.claude/agents/*.md` dosyalarını ajan tipi olarak tanımazsa Supervisor aynı dosyanın içeriğini Agent çağrısında rol tanımı olarak kullanır (dosya yolu verir, içeriği kopyalamaz).

---

<!-- FILE: CLAUDE.md -->
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
<!-- END FILE -->

<!-- FILE: docs/agents/PROTOCOL.md -->
# Supervisor & Ajan Protokolü

## 1. Roller
- **Kullanıcı (Sercan)** yalnızca **Supervisor** ile konuşur. Alt ajanlar kullanıcıya soru sormaz.
- **Supervisor** = ana oturum. Planlar, görev kartı yazar/onaylar, ajan çağırır, sonuç doğrular, `STATE.md`'yi günceller, kullanıcıya rapor verir. **Uygulama kodu yazmaz.** Varsayılan okuması STATE, kart, ajan raporu, `git diff --stat` ve test özetidir; ancak doğrulama için gerektiğinde kodu okur (aşağıdaki §2 adım 4–5). Okuma kararı token değil risk ile verilir.
- **Alt ajanlar** (`.claude/agents/`): tek görev kartı alır, kartın sınırları içinde çalışır, standart rapor döner.

| Ajan | Model | Ne yapar | Ne yapmaz |
|---|---|---|---|
| `architect` | opus | Faz planı, görev kartlarına bölme, ADR, şema tasarımı | Uygulama kodu yazmaz |
| `db-engineer` | sonnet | Migration, RLS, kısıtlar, stok SQL'i, entegrasyon testleri | UI |
| `backend-dev` | sonnet | Domain servisleri, API/Server Action, worker işleri | Şema değişikliği (kartta yoksa) |
| `frontend-dev` | sonnet | Ekranlar, i18n, PWA, tarayıcı/kamera | Domain kuralı |
| `qa-verifier` | sonnet | Kabul senaryosu testleri, bağımsız doğrulama | Üretim kodunu düzeltmez |
| `security-reviewer` | opus | Tenant/yetki/stok/auth dokunan değişikliği diff + çağrı ve yetki bağlamıyla inceler | Kod düzeltmez; ilgisiz modülleri taramaz |
| `devops` | sonnet | CI, docker, deploy, gözlemlenebilirlik, yedek | Domain kodu |
| `scout` | haiku | Kod/doküman konumu bulma, log özetleme | Kod yazmaz, yorum yapmaz |

## 2. Supervisor döngüsü (her görev için)
1. `STATE.md` → sıradaki görev. Kart yoksa `architect`'ten fazın kart setini iste (bir kerede tüm faz).
2. Kartı kontrol et: amaç tek cümle mi, okuma listesi ≤5 öğe mi, dokunulacak dosyalar ≤10 mu, kabul ölçütü test edilebilir mi? Değilse böl.
3. Ajanı çağır. **Prompt ≤ 15 satır:** rol dosyası yolu + kart yolu + "rapor şablonuna uy". İçerik kopyalama yok.
4. Raporu al → doğrula: `git diff --stat` kartın dosya listesiyle uyumlu mu, `pnpm verify` özeti var mı, AC testleri gerçekten koşturuldu ve geçti mi (`pnpm test:ac -- AC-xx` çıktısı), `pnpm check:all` beş bekçide de OK mi, raporda "ATLANAN TEST: 0" yazıyor mu; "YENİ KARANTİNA" veya "KORUNAN DOSYA DEĞİŞİKLİĞİ" sıfır değilse her biri için insan onaylı PR bağlantısı var mı ve `check:protected` / `check:tests` bunu doğruluyor mu; mevcut karantinalarda süresi dolmuş kayıt yok mu. Bunlardan biri eksikse rapor kabul edilmez; ajana iade edilir.
   **Supervisor şu durumlarda diff'in ilgili kısmını ve gerekirse çevresindeki kodu kendisi okur:** kart I-01…I-17'dan birine dokunuyorsa; migration veya RLS politikası değiştiyse; rapor "PARTIAL" ise veya varsayım (`A-xx`) içeriyorsa; diff kartın dosya listesi dışına taştıysa; test sayısı azaldıysa ya da bir test atlandıysa (`skip`/`only`). Okuma hedeflidir: `git diff main...<dal> -- <yol>` ve gerekirse çağıranlar (`grep`).
5. **İnceleme gereksinimi risk matrisine göre belirlenir** (kontroller azaltılmaz, yalnızca doğru yere ve doğru zamana konur):

   | Kartın dokunduğu alan | `security-reviewer` | Bağımsız `qa-verifier` |
   |---|---|---|
   | Tenant izolasyonu, RLS, auth, oturum, yetki (I-01…03, I-12, I-13) | Zorunlu | Zorunlu (izolasyon testleri) |
   | Stok motoru, kilit, idempotency, ters kayıt, kuyruk tüketicisi (I-04…08, I-15, I-16) | Zorunlu | Zorunlu (AC + `16-stock-effects`) |
   | Dosya yükleme, import/export, haricî entegrasyon, sırlar | Zorunlu | Uygulayıcının testleri yeterli |
   | Diğer (UI, rapor görünümü, i18n, metin) | Gerekmez | Uygulayıcının testleri yeterli |

   **İnceleme paketi kuralı:** Aynı dikey dilime ait bağlantılı kartlar (örn. migration + domain komutu + API + test) ayrı ayrı değil **tek paket** olarak incelenir. Kartlar ortak bir entegrasyon dalında (`int/<dilim-adı>`) birleşir; inceleme ve bağımsız QA paket tamamlanınca bir kez yapılır; `main`'e paket olarak girer. Paket sınırı: en fazla 5 kart veya 30 değişen dosya (daha büyüğü inceleme kalitesini düşürür). Paket içindeki bir kart BLOCKER alırsa paket `main`'e girmez. Migration içeren paketlerde migration kartı paketin ilk kartıdır.
6. PR/merge → `STATE.md` güncelle (aktif görev, son tamamlanan, sonraki adım) → `JOURNAL.md`'ye tek satır ekle.
7. Faz bitince kullanıcıya **faz kapısı raporu** (aşağıda) ve onay iste.

## 3. Paralellik
- Yalnızca dosya kümeleri ayrık kartlar paralel çalışır; her biri ayrı worktree/dal.
- Şema (migration) kartları **seri** çalışır; aynı anda tek migration dalı.
- Paralel ajan sayısı ≤3.

## 3b. Mekanik bekçiler (disiplin LLM dikkatine bırakılmaz)
Ajanların "şunu da aradan çıkarayım" diye kart dışına çıkması, testi `skip` etmesi veya kırmızı testi yeşile çevirmek için testi/lint'i gevşetmesi bilinen eğilimlerdir. Supervisor da bir LLM'dir ve uzun oturumda dikkati azalabilir. Bu yüzden aşağıdaki kontroller **CI'da ve commit öncesi kancada makine tarafından** uygulanır; Supervisor bunların çıktısını denetler, yerine geçmez. Herhangi biri kırmızıysa paket `main`'e girmez.
| Bekçi | Ne yakalar | Nasıl |
|---|---|---|
| `check:scope` | Kart dışı dosya değişikliği | Daldaki değişen dosyalar, kartın "Dokunulacak dosyalar" listesiyle (glob) karşılaştırılır; fazlası = hata. Kapsam genişletmek kart güncellemesi ister |
| `check:tests` | Devre dışı testler | `skip`, `only`, `todo`, `xit`, `describe.skip`, koşullu atlama (`if (CI) return`) lint ile yasak. Tek istisna §Karantina kuralına uyan onaylı karantinadır |
| `check:ac-ratchet` | AC testlerinin silinmesi veya azalması | `tests/.ac-baseline.json`: her `@AC-xx` için test sayısı; azalma = hata. Taban dosyası korunan dosyadır; düşürülmesi §Onay kaynağı kuralına tabidir |
| `check:protected` | Korunan dosyaların sessizce değişmesi | Korunanlar: `docs/INVARIANTS.md`, `docs/ACCEPTANCE.md`, `docs/spec/16-stock-effects.md`, `packages/db/src/locking.ts`, birleşmiş migration'lar, CI tanımları, lint/tsconfig/test yapılandırması, bekçi betikleri, sürücü/ORM/pooler sürümleri. Değişiklik yalnızca §Onay kaynağı kuralındaki insan onayıyla geçer. Karttaki `protected: true` yalnızca **beyandır** (ajanın niyeti), onay değildir |
| `check:assertions` | İçi boşaltılmış testler | `@AC` etiketli test dosyasında assertion sayısı tabana göre azalırsa veya `expect(true)` benzeri sabit assertion varsa hata |
| `pnpm verify` + `pnpm test:ac` | Kırık kod ve eksik kabul | Önceki bölümler |

Bekçilerin kendisi korunan dosyadır: bir ajanın bekçiyi gevşeterek geçmesi `check:protected` ile engellenir.

### Karantina kuralı
Kararsız (flaky) veya geçici olarak çalıştırılamayan bir test ancak şu koşulların **hepsiyle** karantinaya alınabilir; aksi hâlde `check:tests` kırmızıdır:
1. Testte `@quarantine Q-xx` etiketi ve `tests/QUARANTINE.md`'de kaydı vardır: test adı, neden, sahibi olan kart (T-xxx), **bitiş tarihi** (en fazla 14 gün veya sonraki faz kapısı, hangisi önceyse).
2. Karantinaya **alındığı PR** §Onay kaynağı kuralıyla insan tarafından onaylanmıştır (kayıt `main`'de bulunur).
3. Test, **o anda kapısı değerlendirilen fazın `@AC` testi değildir.** Kapı AC'si karantinaya alınamaz; kapı AC'si geçmiyorsa kapı kapalıdır.
4. Bitiş tarihi geçen karantina kaydı CI'ı kırmızıya çevirir: test düzeltilir ya da yeniden onaylanır.
Karantinadaki testler her CI çalıştırmasında yine koşturulur ve sonucu raporlanır (sessizce yok sayılmaz); yalnızca kapıyı kırmazlar.

### Onay kaynağı (I-17)
Onay, incelenen değişiklikten **bağımsız** ve ajanın yazamayacağı bir kaynaktan gelmelidir. Ajanın kendi dalında değiştirebildiği hiçbir dosya (kart, ADR, `APPROVALS` listesi, karantina kaydı) onay sayılmaz. Supervisor'ın sohbette "kullanıcı onayladı" demesi de onay sayılmaz; Supervisor bir LLM'dir ve onayı yanlış hatırlayabilir.
- **Kimlik ayrımı (ADR-012, Faz 0):** Ajanlar GitHub'a **ayrı bir kimlikle** (GitHub App veya makine kullanıcısı) push eder. Bu kimliğin yönetici yetkisi, branch protection'ı aşma (bypass) yetkisi ve korunan yollar için inceleme yetkisi yoktur. İnsan onayı yalnızca kullanıcının kendi hesabından gelir.
- **Onayın biçimi:** `main` için branch protection: zorunlu durum kontrolleri (`check:all`, `test:ac`), korunan yollar için **CODEOWNERS = kullanıcı** zorunlu inceleme, "yeni commit gelince eski onayları düşür", yöneticiler dahil bypass kapalı. `check:protected` korunan yol değişikliğinde GitHub API'den PR'ın **son commit'ine** ait, CODEOWNERS listesindeki bir insan hesabından gelen onaylı inceleme olup olmadığını doğrular. CODEOWNERS ve onaylayıcı listesi PR'ın kendi dalından değil, **hedef daldan (`main`)** okunur.
- **İnsan onayı gerektirenler (tek liste):** korunan dosya değişikliği; `tests/.ac-baseline.json` düşürülmesi; yeni test karantinası; AC'nin faz değiştirmesi veya koşullu hâle getirilmesi; `ACCEPTANCE.conditions.json` değişikliği; ADR'nin "kabul" durumuna geçmesi; geri dönüşsüz işlemler.
- **Akış:** Supervisor korunan değişikliği ayrı ve küçük bir PR'da toplar, kullanıcıya PR bağlantısıyla tek mesaj gönderir (ne değişiyor, neden, risk); kullanıcı GitHub'da inceleyip onaylar. Bu nadir olmalıdır; sık oluyorsa kart tasarımı gözden geçirilir.
- **Ayrı kimlik kurulamıyorsa** (geçici durum, ADR-012'de yazılır): korunan yol değişikliği içeren PR'ları yalnızca kullanıcı birleştirir; ajan kimliği bu PR'ları birleştiremez ve `check:protected` bunu birleştiren hesap üzerinden doğrular. Bu durumda ajanın kullanıcının kimlik bilgileriyle çalışıp çalışmadığı ADR'de açıkça kayıt altına alınır; çalışıyorsa koruma tam değildir ve bu bilinen risk olarak faz kapısı raporlarında tekrar edilir.

## 4. Eskalasyon ve durma kuralları
- Aynı hata için 2 başarısız deneme → ajan durur, "BLOCKED" raporlar. Supervisor bir üst modelle (sonnet→opus) tek deneme yaptırır; yine olmazsa kullanıcıya **tek, çoktan seçmeli** soru.
- İş kuralı belirsizliği → `Q-xx` kaydı; Supervisor soruları toplar, faz başında veya kapısında **tek mesajda** sorar (her soru için ayrı mesaj yok).
- Geri dönüşsüz işlem (veri silen migration, prod deploy, force push, ödeme sağlayıcısında canlı ayar) → her zaman kullanıcı onayı.

## 5. Kullanıcıya iletişim (yalnızca şu 3 durumda)
1. **Faz başlangıcı:** 5–8 satır plan + gereken kararlar.
2. **Karar/engel:** çoktan seçmeli soru, önerilen seçenek işaretli, etkisi tek cümle.
3. **Faz kapısı raporu:** tamamlanan kartlar (sayı), geçen AC listesi, çalıştırılmayan kontroller, bilinen sınırlamalar, açık sorular, sonraki faz önerisi. ≤25 satır.
Ara ilerleme görev listesi widget'ında görünür; anlatım yapılmaz.

## 6. Bağlam (context) yönetimi
- Bir oturum = en fazla bir faz veya ~8 kart. Bağlam ağırlaşınca Supervisor `STATE.md`'yi günceller, oturumu kapatır; yeni oturum yalnızca `STATE.md` ile devam eder.
- `STATE.md` ≤80 satır. Taşan geçmiş `JOURNAL.md`'ye özetlenir (haftalık gruplar).
- `docs/MAP.md` (≤60 satır): modül → klasör → giriş noktaları. Her faz sonunda `scout` günceller. Ajanlar keşif yerine önce MAP'e bakar.
- Bilgi tekrar yazılmaz, ID ile referans verilir: `I-xx` (değişmez kural), `AC-xx` (kabul), `ADR-xxx`, `T-xxx`, `Q-xx`, `A-xx`.

## 7. Halüsinasyon önleme kontrol listesi (her raporda örtük)
- Referans verilen her yol/sembol grep ile doğrulandı.
- Kullanılan kütüphane çağrıları kurulu sürümle uyumlu (`docs/STACK.md`).
- Test sonucu gerçek komut çıktısından; tahmin değil.
- Varsayımlar `A-xx` ile işaretli ve `OPEN_QUESTIONS.md`'de.
<!-- END FILE -->

<!-- FILE: docs/agents/REPORT_TEMPLATE.md -->
# Ajan Rapor Şablonu (≤20 satır, kod yapıştırma yok)

```
GÖREV: T-xxx — <başlık>
DURUM: DONE | PARTIAL | BLOCKED
DEĞİŞEN DOSYALAR: <yol> (+satır/-satır) ...
KOMUTLAR:
  pnpm verify → <özet satırı>
  pnpm test:int -- <filtre> → <özet satırı>
  pnpm check:all → scope OK | tests OK | ac-ratchet OK | protected OK | assertions OK
AC: AC-xx PASS | AC-yy FAIL (<neden, 1 satır>)
ATLANAN TEST: 0 (karantina dışında hiçbir atlama kabul edilmez)
YENİ KARANTİNA: 0 (değilse: test adı + Q-xx + onay PR bağlantısı; onay yoksa rapor DONE olamaz)
MEVCUT KARANTİNA: <sayı> (her biri Q-xx + bitiş tarihi; süresi dolmuş: 0)
KORUNAN DOSYA DEĞİŞİKLİĞİ: yok (varsa: dosya + insan onaylı PR bağlantısı; onay yoksa rapor DONE olamaz)
ÇALIŞTIRILMAYAN: <kontrol> — <neden>
VARSAYIMLAR: A-xx ...  SORULAR: Q-xx ...
BULGULAR (kapsam dışı): ...
SONRAKİ: <tek cümle öneri>
```
<!-- END FILE -->

<!-- FILE: .claude/agents/architect.md -->
---
name: architect
description: Faz planlama, görev kartlarına bölme, ADR yazımı ve veri şeması tasarımı. Uygulama kodu yazmaz.
tools: Read, Grep, Glob, Write, Edit
model: opus
---
Sen Rafta WMS'in mimarısın. Önce `docs/STATE.md`, `docs/PHASES.md` (ilgili faz), `docs/spec/00-index.md`.
Görev: istenen fazı `docs/tasks/_TEMPLATE.md` formatında, dikey dilimler halinde kartlara böl (kart başına ≤10 dosya, ≤5 okuma öğesi, test edilebilir AC). Kartları bağımlılık sırasıyla numaralandır, `STATE.md` kuyruğuna ekle.
Mimari karar gerektiren her şey için `docs/adr/ADR-xxx.md` (şablon: `_TEMPLATE.md`) yaz ve `docs/DECISIONS.md`'ye tek satır ekle.
İş kuralı uydurma; belirsizliği `Q-xx` olarak kaydet. Rapor: `docs/agents/REPORT_TEMPLATE.md`.
<!-- END FILE -->

<!-- FILE: .claude/agents/db-engineer.md -->
---
name: db-engineer
description: PostgreSQL migration, RLS politikaları, kısıtlar, stok defteri SQL'i ve gerçek veritabanıyla entegrasyon testleri.
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
---
Yalnızca verilen görev kartını ve Okuma listesini oku. Zorunlu: `docs/INVARIANTS.md` (ilgili I-xx), `docs/spec/15-engineering.md` §DB sözleşmesi.
Her tenant tablosu: `tenant_id NOT NULL`, RLS ENABLE+FORCE, USING+WITH CHECK, `(tenant_id,id)` benzersiz + bileşik FK. Miktarlar `numeric`, float yok.
Her migration: up + (güvenliyse) down + Testcontainers entegrasyon testi (uygulama rolü `wms_app` ile, superuser ile değil). Rapor şablonuna uy.
<!-- END FILE -->

<!-- FILE: .claude/agents/backend-dev.md -->
---
name: backend-dev
description: Domain servisleri, stok komutları, API route/Server Action, worker işleri; Zod validasyonu ve idempotency.
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
---
Yalnızca kartı ve Okuma listesini oku. Kod `packages/domain` (iş kuralı), `apps/web` (giriş noktası), `apps/worker` (kuyruk) ayrımına uyar; UI ve worker aynı domain komutunu çağırır.
Stok değiştiren her komut `docs/spec/05-stock-engine.md` §İşlem sözleşmesi 7 adımını izler ve kilitleri yalnızca `acquireStockLocks` ile, tam kilit planını önceden bildirerek alır (§Kilit sözleşmesi, I-15); kendi `FOR UPDATE` sorgunu yazma. Stok etkisi `docs/spec/16-stock-effects.md` ile çelişirse tablo kazanır; tabloyu değiştirmek ADR ve kullanıcı onayı ister. Tüm tenant erişimi `withTenant(ctx, tx => …)` içinde ve yalnızca `tx` üzerinden. Hata kodları `docs/spec/15-engineering.md` listesinden. Kütüphane API'sini tahmin etme (G-04). Rapor şablonuna uy.
<!-- END FILE -->

<!-- FILE: .claude/agents/frontend-dev.md -->
---
name: frontend-dev
description: Next.js ekranları, Shadcn/Radix bileşenleri, next-intl, PWA, barkod/kamera, sanallaştırılmış listeler, dinamik form renderer.
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
---
Yalnızca kartı ve Okuma listesini oku. Kurallar: `docs/spec/08-ux-i18n.md`. Dokunma hedefi ≥48×48 px, mobil görev ekranında yatay taşma yok, büyük listelerde TanStack Virtual, tüm metinler i18n anahtarı.
Domain kuralını UI'da yeniden yazma; sunucu hatasını (kod + sonraki eylem) göster. Playwright ile ilgili akışın mobil viewport testi. Rapor şablonuna uy.
<!-- END FILE -->

<!-- FILE: .claude/agents/qa-verifier.md -->
---
name: qa-verifier
description: Kabul senaryolarını (AC-xx) uygulayandan bağımsız test eder; concurrency, tenant sızıntısı, idempotency testleri yazar ve çalıştırır.
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
---
Uygulama kodunu düzeltme; yalnızca `tests/` altına yaz. Okuma: kart + `docs/ACCEPTANCE.md` ilgili AC + `docs/INVARIANTS.md`. Stok testlerinde beklenen değerleri `docs/spec/16-stock-effects.md`'den al; kendi hesabını yapma.
Concurrency testleri gerçek paralel bağlantılarla; RLS testleri `wms_app` rolüyle. Stok defteri için özellik tabanlı test (ledger toplamı == bakiye). Başarısızlıkta: AC, beklenen, gerçekleşen, tekrar adımı. Rapor şablonuna uy.
<!-- END FILE -->

<!-- FILE: .claude/agents/security-reviewer.md -->
---
name: security-reviewer
description: Tenant izolasyonu, yetki, auth, stok bütünlüğü veya dosya erişimine dokunan diff'leri inceler. Tüm repoyu değil yalnızca diff'i okur.
tools: Read, Grep, Glob, Bash
model: opus
---
Girdi: `git diff main...<dal>`. Diff'in doğru olup olmadığını anlamak için gereken bağlamı okumakta serbestsin: değişen fonksiyonu çağıranlar ve çağırdıkları, ilgili route/Server Action ve middleware, yetki kontrolü, RLS politikası ve migration, ilgili testler. Bağlamı `grep` ile hedefli bul; ilgisiz modülleri tarama. Kontrol: I-01…I-17, RLS bypass yolu, session-level tenant ayarı, istemciden gelen tenant_id'ye güven, eksik yetki kontrolü, idempotency eksikliği, decimal/float, log'a sır/kişisel veri, SSRF/dosya yükleme, IDOR.
Çıktı: BLOCKER / MAJOR / MINOR listesi (dosya:satır + tek cümle). Kod yazma. BLOCKER varsa merge yok.
<!-- END FILE -->

<!-- FILE: .claude/agents/devops.md -->
---
name: devops
description: Monorepo iskeleti, docker compose, CI, deploy, gözlemlenebilirlik, yedek/restore tatbikatı.
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
---
Okuma: kart + `docs/spec/14-reliability-ops.md` + `docs/STACK.md`. `pnpm verify` çıktısı yalnızca hata özetini basmalı (token tasarrufu). CI: lint, typecheck, unit, entegrasyon (Testcontainers), migration ileri/geri, bağımlılık taraması. Sırlar ortam değişkeni; `.env.example` güncel. Rapor şablonuna uy.
<!-- END FILE -->

<!-- FILE: .claude/agents/scout.md -->
---
name: scout
description: Hızlı, salt okunur konum bulma ve özetleme. Kod yazmaz, yorum yapmaz.
tools: Read, Grep, Glob
model: haiku
---
Verilen soruya yalnızca şu formatta cevap ver: `yol:satır-aralığı — tek satır açıklama` (en fazla 15 satır). Log/test çıktısı özetlenecekse: hata sayısı + ilk 5 farklı hata (dosya:satır, mesaj). Tahmin yok; bulamadıysan "BULUNAMADI".
<!-- END FILE -->

<!-- FILE: docs/STATE.md -->
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
<!-- END FILE -->

<!-- FILE: docs/JOURNAL.md -->
# JOURNAL (tek satır / görev; Supervisor yazar, ajanlar istenmedikçe okumaz)
- 2026-10-05 Bootstrap: master v3.0 parçalara bölündü.
<!-- END FILE -->

<!-- FILE: docs/OPEN_QUESTIONS.md -->
# Açık Sorular ve Varsayımlar
Format: `Q-xx | soru | etkilenen T/I | durum` · `A-xx | varsayım | geçerlilik koşulu | doğrulayan Q`
<!-- END FILE -->

<!-- FILE: docs/DECISIONS.md -->
# Karar Dizini (tek satır / ADR)
Format: `ADR-xxx | tarih | karar | durum (önerildi/kabul/yerine geçti)`
<!-- END FILE -->

<!-- FILE: docs/adr/_TEMPLATE.md -->
# ADR-xxx: <başlık>
**Tarih / Durum:** · **Bağlam:** (≤5 satır) · **Seçenekler:** (2–3, artı/eksi) · **Karar:** · **Sonuçlar ve riskler:** · **Doğrulama:** (hangi test/ölçüm)
<!-- END FILE -->

<!-- FILE: docs/tasks/_TEMPLATE.md -->
# T-xxx: <başlık>
**Faz:** · **Ajan:** · **Bağımlılık:** T-… · **Dal:** `feat/T-xxx-...`
**Amaç (tek cümle):**
**Okuma listesi (≤5):** `docs/spec/NN-....md §Bölüm`, `docs/INVARIANTS.md I-xx`, `src/... (satır aralığı)`
**Dokunulacak dosyalar (≤10):**
**Yapılacaklar:** (madde, en fazla 8)
**Kabul ölçütü:** AC-xx / komut + beklenen sonuç
**Kapsam dışı:**
**Gerekli inceleme:** security-reviewer? qa-verifier?
<!-- END FILE -->

<!-- FILE: docs/MAP.md -->
# Kod Haritası (≤60 satır; her faz sonunda scout günceller)
```
apps/web        Next.js App Router: (auth) (dashboard) (mobile) (superadmin) api/
apps/worker     BullMQ işçileri: import, export, ocr, notify, outbox-relay, deletion, consistency-check
packages/domain İş kuralları ve komutlar: identity, inventory, receipts, orders, warehouse, counts, metadata, billing, integrations, reporting
packages/db     Şema, migration, tenant-scoped transaction yardımcıları, RLS testleri
packages/shared Zod şemaları, hata kodları, tipler, i18n anahtar tipleri
packages/ui     Shadcn tabanlı ortak bileşenler, dynamic-form, scanner, virtualized
tests/          integration (Testcontainers), e2e (Playwright), load (k6)
docs/           spec/, adr/, tasks/, agents/, STATE, MAP, INVARIANTS, ACCEPTANCE, PHASES
```
<!-- END FILE -->

<!-- FILE: docs/STACK.md -->
# Teknoloji ve Sürüm Kilidi (Faz 0'da kesinleşir; ajanlar bu sürümlere göre kod yazar)
| Katman | Seçim (varsayılan öneri) | Sürüm | ADR |
|---|---|---|---|
| Çalışma zamanı / paket | Node.js LTS, pnpm workspace | Faz 0 | ADR-001 |
| Web | Next.js App Router, TypeScript strict, Tailwind, Shadcn/Radix, Lucide | Faz 0 | ADR-001 |
| Durum/veri | TanStack Query, TanStack Virtual, Zustand (gerektiğinde) | Faz 0 | |
| ORM | Drizzle (öneri) veya Prisma — gerekçe aşağıda; prepared statement ayarı pooler testine göre | Faz 0 | ADR-003 |
| DB | PostgreSQL + transaction pooler | Faz 0 | ADR-004 |
| Kuyruk | Postgres kuyruğu (pg-boss / graphile-worker — Faz 0–4 önerisi) · BullMQ + kalıcı TCP Redis (`noeviction`) · RabbitMQ | Faz 0 | ADR-005 |
| Dosya | S3 uyumlu özel bucket veya Azure Blob | Faz 0 | ADR-006 |
| Validasyon | Zod | | |
| i18n | next-intl | | |
| Test | Vitest, Testcontainers, Playwright, k6, fast-check | | |
| Gözlem | OpenTelemetry + Sentry (veya eşdeğeri) | | |
Kural: Yeni bağımlılık eklemek kart + gerekçe ister; lisans (GPL/AGPL) ve bakım durumu kontrol edilir. Kütüphane belgesi gerektiğinde Context7 kullanılır.

## ADR-003 için doğru gerekçe (ORM)
- Her iki ORM'de de etkileşimli transaction (`db.transaction(tx => …)` / `prisma.$transaction(async tx => …)`) tek bağlantıda çalışır; `set_config` ile RLS her ikisinde de uygulanabilir. "Prisma bağlantı değiştirir" gerekçesi **yanlıştır**, ADR'ye yazılmaz.
- Ortak gerçek risk: callback içinde `tx` yerine global istemciyi (`db.` / `prisma.`) kullanmak → sorgu bağlamsız başka bağlantıda çalışır. Önlem: `withTenant` dışında tenant tablosuna erişimi engelleyen lint kuralı + RLS'in bağlamsız durumda satır döndürmemesi ve yazmayı reddetmesi (I-02).
- Drizzle lehine gerçek nedenler: `FOR UPDATE`, `SKIP LOCKED`, `ON CONFLICT`, sıralı kilit gibi ham SQL'i tipli ve şeffaf yazmak kolay; üretilen SQL öngörülebilir; ek sorgu motoru yok.
- Prisma'nın gerçek dezavantajları: etkileşimli transaction'ın varsayılan zaman aşımı kısadır (uzun stok işlemlerinde ayar gerekir); kilit ve kuyruk sorguları büyük ölçüde `$queryRaw`'a düşer.

## ADR-005 için seçenekler (kuyruk)
| Seçenek | Artı | Eksi |
|---|---|---|
| **Postgres kuyruğu** (pg-boss / graphile-worker) | İş, stok işlemiyle **aynı transaction'da** kuyruğa yazılır → outbox = kuyruk; relay ve çift yazma sorunu yok; Redis bağımlılığı yok; `SKIP LOCKED` tabanlı | Yük arttıkça DB'ye ek iş; çok yüksek hacimde ayrı kuyruğa geçiş gerekir |
| BullMQ + Redis | Yüksek hacim, gecikmeli/tekrarlı iş, hız sınırı, tenant adaleti kolay | Outbox relay hop'u gerekir; Redis işletimi |
| RabbitMQ | Olgun yönlendirme, v1.3 seçimi | Ek altyapı, relay hop'u gerekir |
Önerilen yol: Faz 0–4 Postgres kuyruğu, ölçüm eşiği aşılınca (ADR'de sayısal eşik) BullMQ.

**`JobQueue` soyutlaması ilk günden sıkı tutulur:**
- Arayüz `packages/shared` içindedir (`enqueue(tx, job)`, `work(type, handler)`, `schedule`, `cancel`); sağlayıcı kütüphanesi (pg-boss, graphile-worker, bullmq) yalnızca `packages/queue-adapter` içinde import edilebilir — lint kuralı. Domain kodu sağlayıcıya özgü seçenek (öncelik numarası, Redis anahtarı vb.) kullanmaz.
- `enqueue` transaction parametresi alır; Postgres kuyruğunda iş, stok işlemiyle aynı transaction'da yazılır. Broker'a geçildiğinde aynı çağrı outbox'a yazar ve relay devreye girer; domain kodu değişmez.
- Her iki adapter aynı sözleşme testlerinden geçer (AC-16, 22, 23).

**Postgres kuyruğunda yük — doğru teşhis:** `SKIP LOCKED` kendisi WAL üretmez. WAL ve şişkinlik (bloat), iş satırlarının eklenmesi, durum güncellemeleri ve silinmesinden gelir. Bu yüzden:
- **İş birimi belge/olaydır, satır değildir.** 500 satırlı mal kabul veya sayım farkı tek iş (ya da tek olay) üretir; satır başına iş yasak.
- Stok kesinleştirmesinin kendisi kuyruğa bırakılmaz (yalnızca senkron eşiği aşan belgeler, §05 Senkron işlem sınırları); kuyruk yan etkiler içindir: bildirim, export, entegrasyon, rapor.
- Tamamlanan işler kısa süre sonra arşiv tablosuna taşınır/silinir; kuyruk tablosuna agresif autovacuum ayarı verilir.
- BullMQ'ya geçiş eşiği bu ölçümlerle tanımlanır: kuyruk tablosu dead tuple oranı, kuyruk kaynaklı WAL hacmi, iş gecikmesi p95, saniyedeki iş sayısı.
<!-- END FILE -->

<!-- FILE: docs/GLOSSARY.md -->
# Sözlük ve Terminoloji
- **Sipariş toplama görevlendirmesi:** Sektördeki "wave/dalga" yerine kullanılan terim; tablo, ekran ve menüde "wave" kullanılmaz.
- **Fiş:** Stok etkili veya etkisiz belge (mal kabul, transfer, sayım farkı, sevk, iade, üretim giriş/sarf).
- **Ters kayıt:** İşlenmiş fişi geri almak için orijinale referans veren karşıt hareket.
- **Stok boyutu:** tenant + ürün + lokasyon + lot/seri + stok durumu + stok sahibi + taşıma birimi (opsiyonel).
- **Kullanılabilir stok:** Σ fiziksel (durum `AVAILABLE`, lokasyon türü `STORAGE` veya `STAGING`, toplama dışı olmayan lokasyon) − Σ aktif rezervasyon. Kabul alanındaki, karantinadaki, transit ve sayım görevi bekleyen lokasyondaki stok fizikseldir ama kullanılabilir değildir.
- **Transit:** Transfer çıkışı yapılmış, hedefte kabul edilmemiş stok.
- **Tenant terminolojisi:** Kullanıcıya gösterilen etiket (örn. "Göz Kodu"); teknik alan kimliğini değiştirmez.
## Adlandırma kuralı (ADR-002 — önerilen varsayılan)
Kod, tip, DB şeması, API ve ajan istemleri **İngilizce**; arayüz metinleri **Türkçe** (next-intl anahtarları üzerinden); iş terimi ↔ teknik ad eşlemesi yalnızca bu tabloda tutulur. Gerekçe: İngilizce tanımlayıcılar daha az token'a bölünür, kütüphane kalıplarıyla tutarlıdır ve ajan hata oranını düşürür. ADR-002 Türkçe yönünde karar verirse tablo yine geçerlidir, yalnızca sütunlar yer değiştirir. v1.3'teki Türkçe 106 tabloluk katalog bu tabloya göre çevrilir (ayrı görev kartı).

| İş terimi (UI) | Teknik ad (kod/DB) | Not |
|---|---|---|
| Stok kartı / malzeme | `item` | |
| Cari | `account` | Müşteri/tedarikçi rolü alanla |
| Depo | `warehouse` | |
| Lokasyon (Bölge/Koridor/Raf/Kat/Göz) | `location` (`level` alanı) | Derinlik dinamik |
| Fiş / belge | `document`, `document_line`, `document_type` | |
| Mal kabul | `receipt` (document_type) | |
| Yerleştirme | `putaway` | |
| Sevk | `shipment` | |
| Transfer | `transfer` | Transit lokasyonu `location.kind = TRANSIT` |
| Sayım / sayım farkı | `count_session`, `count_adjustment` | |
| İade | `return` | |
| Rezervasyon | `reservation` | |
| Sipariş toplama görevlendirmesi | `pick_assignment` | **`wave` kullanılmaz** (kod dahil) |
| Toplama görevi | `pick_task` | |
| Hareket defteri | `stock_ledger` | |
| Stok boyutu | `stock_dimension` | |
| Ters kayıt | `reversal` | |
| Lot / SKT | `lot`, `lot.expiry_date` | |
| Koli / palet (izlenen kap) | `handling_unit` (`kind` KOLI/PALET, `sscc`) | "1 koli = 12 adet" ise bu değil, `unit_conversion` |
| Seri no | `serial` | |
| Stok sahibi | `inventory_owner` | |
| Paket / hak | `plan`, `entitlement` | |
<!-- END FILE -->

<!-- FILE: docs/INVARIANTS.md -->
# Değişmez Kurallar (kod, test ve inceleme bu ID'lere referans verir)
- **I-01 Tenant izolasyonu:** Tenant verisine her erişim doğrulanmış üyelikten gelen tenant bağlamıyla; istemcinin tenant_id'si yalnızca seçim bilgisidir. API, DB, dosya, cache, arama, export, worker aynı sözleşmeye uyar.
- **I-02 Transaction-local bağlam:** `set_config(..., true)`; aynı transaction/bağlantı dışında tenant sorgusu yok; eksik bağlam = ret.
- **I-03 RLS rolü:** Uygulama rolü tablo sahibi, superuser veya BYPASSRLS değildir; migration/yedek/silme rolleri ayrıdır.
- **I-04 Defter kaynaktır:** `stock_ledger` append-only; bakiye ve rezervasyon yalnızca stok komutlarıyla aynı transaction'da güncellenir; doğrudan CRUD yok.
- **I-05 Negatif stok yasak** (varsayılan); istisna yalnızca tenant politikası + özel yetki + gerekçe + audit; seri tekilliği hiçbir durumda aşılamaz.
- **I-06 Idempotency:** Stok değiştiren her komut kalıcı idempotency kaydı taşır; aynı anahtar + farklı içerik = ret; tekrar = önceki sonuç.
- **I-07 Outbox:** Haricî olaylar aynı transaction'da outbox'a yazılır; relay `FOR UPDATE SKIP LOCKED` + jobId = olay kimliği ile yayımlar; her tüketici `processed_events` ile etkiyi tek kez uygular; Redis/kuyruk stok doğruluğunun kaynağı değildir.
- **I-13 Veriye erişim hakkı:** Görüntüleme, CSV/JSON indirme ve takeout hiçbir paket, ödeme durumu veya feature flag ile kapatılmaz; yalnızca kimlik, yetki ve rate limit uygulanır. Tek istisna kapatma sürecidir (`CLOSING_GRACE`): erişim yalnızca `takeout.talep_et` yetkili kullanıcılara, salt okunur portal üzerinden açık kalır (§12 Kapatma).
- **I-14 Uzun okuma ana DB'yi kilitlemez:** Büyük export/rapor işleri worker'da, replica veya keyset parçalı kısa transaction'larla çalışır; uzun açık transaction ve OFFSET sayfalama yasak.
- **I-15 Kilit sırası:** Stok komutları kilitleri yalnızca `acquireStockLocks` ile, önceden bildirilen tam kilit planıyla alır (belge → sayım kilidi → bakiye → rezervasyon → seri; her adımda tekil anahtar artan); kilitsiz toplu stok güncellemesi yasak.
- **I-17 Onay insandan ve dışarıdan gelir:** Korunan değişiklik, karantina, AC tabanı düşürme ve AC faz değişikliği yalnızca kullanıcının GitHub hesabından, PR'ın son commit'ine verilmiş incelemeyle onaylanır. Ajanın yazabildiği dosyalar ve Supervisor'ın sohbet beyanı onay değildir.
- **I-16 Sequence commit sırası değildir:** Hiçbir kesim noktası, cursor veya "buraya kadar işlendi" işareti sequence/ID büyüklüğüne dayanmaz. Kesit, transaction görünürlüğüyle (`created_xid xid8` + `pg_visible_in_snapshot`) veya açık durum alanıyla belirlenir.
- **I-08 Ters kayıt:** İşlenmiş belge silinmez/değiştirilmez; ters kayıt kalan ters çevrilmemiş miktarı aşamaz; bağımlı işlemler kontrol edilir.
- **I-09 Decimal:** Miktar ve dönüşümler decimal; dönüşüm katsayısı belge satırına kopyalanır; float yok.
- **I-10 Offline = komut:** Offline kayıt sunucu onayı bekleyen komuttur; sunucu güncel yetki/abonelik/stok ile yeniden doğrular; last-write-wins yok.
- **I-11 Sürümlü metadata:** Belge kullandığı metadata/fiş tipi sürümünü taşır; şema değişikliği eski belgeyi bozmaz; çekirdek stok alanları metadata'ya taşınmaz.
- **I-12 Audit:** Yetkili işlemler ve destek erişimi audit'e yazılır; işlenmiş audit uygulama kullanıcısınca değiştirilemez; sır/parola loglanmaz.
<!-- END FILE -->

<!-- FILE: docs/spec/00-index.md -->
# Şartname Dizini — hangi iş için hangi parça
| Parça | Konu | Ne zaman okunur |
|---|---|---|
| 01-scope-stack | Kapsam, mimari, monorepo, ölçek/SLO | Faz planı, altyapı |
| 02-tenancy-auth | Tenant bağlamı, RLS, RBAC, oturum | Auth, her tenant tablosu |
| 03-security-legal | Güvenlik, KVKK ve TR mevzuatı | Güvenlik, veri, sözleşme |
| 04-data-model | Varlıklar, ürün/lot/seri/birim | Şema kartları |
| 05-stock-engine | Belge durumları, işlem sözleşmesi, rezervasyon, ters kayıt | Her stok etkili iş |
| 06-operations | Kabul, toplama, sevk, transfer, iade, üretim, sayım | Depo akışları |
| 07-mobile-offline | Donanım, offline kuyruk, çatışma | Mobil/saha |
| 08-ux-i18n | UI kuralları, dil, onboarding | Her ekran |
| 09-integrations | Import, ERP/Logo, webhook, e-İrsaliye, public API, B2B | Entegrasyon |
| 10-metadata-engine | No-code alanlar, fiş tipleri, entitlements | Süper yönetici |
| 11-ai | OCR/ses/tahmin, BYOK | AI |
| 12-billing-lifecycle | Abonelik, takeout, offboarding | Faturalama |
| 13-reporting-notify-print | Raporlar, uyarılar, bildirim, yazdırma | Rapor/etiket |
| 14-reliability-ops | Yedek, gözlem, deploy, olay | DevOps |
| 15-engineering | Kod standartları, test stratejisi, DB sözleşmesi, hata kodları | Her kod kartı |
| 16-stock-effects | Her operasyonun sayısal stok etkisi (beklenen değerler) | Stok etkili her kart ve her stok testi |
<!-- END FILE -->

<!-- FILE: docs/spec/01-scope-stack.md -->
# 01 — Kapsam, Mimari ve Ölçek

## Kapsam
Çok müşterili depo/stok yönetimi: mal kabul, yerleştirme, rezervasyon, toplama, sevk, transfer, iade, sayım, raporlama. Sektör şablonları: tekstil, gıda, hırdavat, e-ticaret. Cari kartlar müşteri/tedarikçi referansıdır. Tam muhasebe, e-belge düzenleme ve MRP kapsam dışıdır (entegrasyon). WMS sevk belgesi, ayrıca entegre edilmeden resmî e-İrsaliye yerine geçmez.

## Mimari
- **Modüler monolit, pnpm monorepo:** `apps/web` (Next.js), `apps/worker` (uzun ömürlü işçi süreci), `packages/domain` (iş kuralları), `packages/db`, `packages/shared`, `packages/ui`. Web ve worker **aynı domain komutlarını** paylaşır; stok/yetki kuralı ekranlara veya worker'a kopyalanmaz.
- Route Handlers ve Server Actions ince giriş katmanıdır; domain servislerini çağırır.
- Worker'lar istek süreçlerinden ayrı, serverless fonksiyonlarda değil kalıcı süreçte çalışır (import, export, OCR, bildirim, outbox relay, silme, tutarlılık kontrolü).
- PostgreSQL stok doğruluğunun tek kaynağıdır; cache/kuyruk/arama türevdir.
- Önceki v1.3 seçimi (NestJS API + RabbitMQ + Azure Blob) ile bu belgedeki (Next.js + Postgres kuyruğu/BullMQ + S3 uyumlu) arasındaki seçim **ADR-001/005/006**'da yapılır; kuyruk (`JobQueue`) ve dosya erişimi (`ObjectStorage`) arayüz arkasında soyutlanır ki değişim domain'i etkilemesin.

## Ölçek ve hizmet hedefleri
100.000 tenant / 1.000.000 bağlı kullanıcı **uzun vadeli** hedeftir, başlangıç kapasitesi değildir. Bağlı oturum, aktif kullanıcı, eş zamanlı istek ve saniyedeki stok işlemi ayrı ölçülür.

| Ölçüt | Başlangıç hedefi | Koşul |
|---|---|---|
| Aylık kesinti | ≤ 43 dakika | Kritik API'ler (planlı bakım hariç, ayrıca duyurulur) |
| Liste/detay API | p95 ≤ 500 ms | Sunucu tarafı, tanımlı veri hacmi |
| Stok kesinleştirme | p95 ≤ 1 sn | Haricî çağrı olmadan |
| RPO / RTO | ≤ 15 dk / ≤ 4 saat | Felaket senaryosu |

Faz 0'da yük profili sayısallaştırılır (aktif tenant, tenant başına SKU/hareket, sıcak satır yoğunluğu, okuma-yazma oranı, RPS, günlük dosya hacmi). Tenant kotası ve kuyruk adaleti gürültülü komşuyu sınırlar. Bölümleme, read replica, tenant'ı ayrı kümeye taşıma ölçüme göre devreye alınır. Yetki ve güncel stok kontrolü replikadan yapılmaz.
<!-- END FILE -->

<!-- FILE: docs/spec/02-tenancy-auth.md -->
# 02 — Tenant İzolasyonu, Kimlik ve Yetki

## Tenant bağlamı
- Kullanıcı birden çok tenant'a üye olabilir: `users`, `tenant_memberships`, `roles`, `permissions`, depo kapsamı ayrı modellenir.
- Sunucu; kimlik, aktif üyelik ve işlem yetkisini doğrulayarak bağlam kurar (I-01). Tenant tablolarında `tenant_id NOT NULL`; platform/global tablolar ayrı güvenlik kapsamında.
- Tenant tabloları arası FK'ler `(tenant_id, entity_id)` çiftini referans alır.
- Cache anahtarı, dosya yolu, job kimliği tenant kapsamlıdır; yine de her erişimde sahiplik doğrulanır.

## RLS
- RLS ENABLE + FORCE; okuma `USING`, yazma `WITH CHECK`. Uygulama rolü I-03'e uyar.
- Bağlam transaction-local (I-02). Pool üzerinde A→B tenant geçişi ve eşzamanlı kullanım test edilir (AC-05). Pooler modu ve prepared statement davranışı seçilen ORM/sürücüyle ADR-004'te doğrulanır.

## Pooler uyumluluğu (ADR-004 — Faz 0 çıkış kapısı)
Transaction-mode pooler (PgBouncer, Supavisor, Neon pooler) arkasında her transaction farklı fiziksel bağlantıya düşebilir. Bu nedenle:
- Tenant bağlamı yalnızca `SELECT set_config('app.current_tenant_id', $1, true)` ile kurulur. `SET` / `SET SESSION` yasak; `SET LOCAL` parametre alamadığı için kullanılmaz (string birleştirme = SQL injection riski).
- `set_config` ve tenant sorguları **aynı ORM transaction nesnesi** üzerinden çalışır (örn. Drizzle `db.transaction(tx => …)`). Transaction dışındaki `db.` çağrısı tenant tablosuna erişemez; bunu sağlayan tek yardımcı `withTenant(ctx, fn)` `packages/db` içindedir ve lint kuralıyla doğrudan `db` kullanımı tenant modüllerinde engellenir.
- **Prepared statement:** Pooler sürümü protokol düzeyi prepared statement desteklemiyorsa sürücüde kapatılır (örn. postgres.js `prepare: false`, Prisma `pgbouncer=true`); destekliyorsa (PgBouncer ≥1.21 `max_prepared_statements`) ayar ADR-004'e yazılır. Karar test sonucuna göre verilir, varsayıma göre değil.
- Advisory lock, `LISTEN/NOTIFY`, session temp table, `WITH HOLD` cursor gibi session'a bağlı özellikler pooler üzerinden kullanılmaz; gerekiyorsa ayrı doğrudan (session-mode) bağlantı havuzu tanımlanır (worker/migration).
- Migration ve uzun süren worker işleri doğrudan (pooler'sız) bağlantı kullanabilir; bu bağlantı da `wms_app` benzeri RLS'e tabi rol ile çalışır, yalnızca migration rolü ayrıdır.
- **Erken kanıt (T-005 spike):** Seçilen sağlayıcının gerçek pooler'ı arkasında; pool boyutu 1–2'ye düşürülerek bağlantı yeniden kullanımı zorlanır; 2 tenant × 50 eşzamanlı istek; her yanıt yalnızca kendi tenant'ının satırlarını döndürmeli, transaction dışı sorgu 0 satır/ret almalı, prepared statement hatası olmamalı. Bu test geçmeden Faz 1'e geçilmez.
- **İki katmanlı kanıt:** (a) T-005 bir kez **seçilen sağlayıcının gerçek pooler'ı** üzerinde koşar ve sonucu ADR-004'e (sağlayıcı, pooler sürümü, sürücü ve ORM sürümü, prepared statement ayarı) yazılır. (b) Aynı test **her CI çalıştırmasında**, docker compose'daki transaction-mode PgBouncer arkasında, üretimle aynı sürücü ayarlarıyla koşar. Yalnızca doğrudan PostgreSQL'e bağlanan bir test geçerli kanıt sayılmaz.
- **Yeniden spike tetikleyicileri:** Sağlayıcı, pooler türü/sürümü, PostgreSQL ana sürümü, sürücü veya ORM ana sürümü değiştiğinde T-005 gerçek sağlayıcıda tekrar koşturulur; koşturulmadan bu yükseltmeler `main`'e girmez (`check:protected` bu paket sürümlerini izler).
- RLS satır izolasyonudur; eylem, depo, alan ve belge durumu yetkisi ayrıca sunucuda uygulanır.

## Roller ve izinler
- Hazır roller: Tenant Sahibi/Yönetici, Depo Şefi, Toplama Personeli, Sayım Personeli, Salt Okunur.
- İzinler eylem + depo kapsamı: `stok.görüntüle`, `fiş.oluştur`, `fiş.onayla`, `stok.işle`, `ters_kayıt.oluştur`, `sayım_farkı.onayla`, `takeout.talep_et`, `ayarlar.yönet`, `kullanıcı.yönet`.
- Görev ayrımı (aynı kişinin oluşturup onaylayamaması) tenant politikasıyla açılıp kapanır (Q: Faz 0).

## Oturum
- Kısa ömürlü erişim token'ı + yenileme rotasyonu + oturum iptali; her yazmada güncel üyelik/yetki kontrolü. Kullanıcı çıkarılması/tenant askıya alınması eski token ile yazmayı engeller.
- Yönetici/süper yönetici için MFA; export, anahtar değişimi, hesap kapatma için yeniden doğrulama. Son tenant sahibi devir olmadan ayrılamaz.
- Süper yönetici müşteri verisine varsayılan erişemez; destek erişimi gerekçeli, süreli, audit'li, gerektiğinde müşteri onaylı ("adına işlem" kaydı ile).
- Auth sağlayıcıları: Google, Microsoft, e-posta (ilk kapsam); Apple sonraki. Kurumsal SSO (SAML/OIDC) Enterprise paket için sonraki faz.
<!-- END FILE -->

<!-- FILE: docs/spec/03-security-legal.md -->
# 03 — Güvenlik, KVKK ve Türkiye Mevzuatı

## Uygulama güvenliği
- Sunucuda Zod validasyonu, parametrik SQL, bağlama uygun XSS koruması, güvenli cookie, CSP; cookie tabanlı yazmalarda CSRF/origin kontrolü. IDOR'a karşı her kaynak erişiminde sahiplik kontrolü.
- Rate limit: IP, kullanıcı, tenant; import/export/AI için ek kota.
- TLS 1.3 tercih; at-rest şifreleme ve anahtar rotasyonu DB, dosya ve yedekler için doğrulanır.
- Dosya yükleme: boyut/tür, içerik doğrulama, karantina, kötü amaçlı yazılım taraması; haricî URL indirmede SSRF sınırı.
- Bağımlılık ve sır taraması CI'da; bilinen kritik açık = merge yok.
- Audit (I-12): tenant, gerçek aktör, adına işlem yapılan, işlem, kayıt, zaman, gerekçe, IP/cihaz, request ID, değişiklik özeti.

## KVKK / GDPR
- Veri envanteri, işleme amaçları, veri sorumlusu (müşteri) / veri işleyen (platform) rolleri, **veri işleme sözleşmesi (DPA)**, saklama politikası, ilgili kişi başvuruları, ihlal müdahale prosedürü.
- **Barındırma bölgesi:** Yurt dışında barındırma KVKK'daki yurt dışı aktarım kurallarına tabidir; bölge ve aktarım mekanizması ADR-007'de hukuk görüşüyle seçilir.
- VERBİS kayıt yükümlülüğü, aydınlatma metni, çerez politikası, kullanım koşulları, abonelik sözleşmesi hazırlanır (hukukçu doğrular; teknik kontrol hukuki uyum beyanı değildir).
- Ticari e-posta/SMS (pazarlama) İYS kurallarına tabidir; işlemsel bildirimler pazarlamadan ayrı tutulur.
- Operasyonel silme, hukuki saklama ve anonimleştirme ayrı süreçlerdir; süreler kayıt sınıfına göre doğrulanır.
<!-- END FILE -->

<!-- FILE: docs/spec/04-data-model.md -->
# 04 — Çekirdek Veri Modeli
(Tablo adları örnektir; adlandırma dili ADR-002.)

| Grup | Varlıklar | Kural |
|---|---|---|
| Kimlik | users, tenants, memberships, roles, sessions | Kimlik ≠ üyelik |
| Kartlar | items, item_barcodes, units, unit_conversions, accounts | Kod tenant içinde benzersiz |
| Depo | warehouses, locations (Depo→Bölge/Koridor→Raf→Kat→Göz, dinamik derinlik), location_count_locks (lokasyon başına bir satır, lokasyonla birlikte oluşur) | Ağaç döngüsüz, tenant/depo tutarlı; `location.kind` ∈ `RECEIVING` (kabul), `STORAGE` (raf), `STAGING` (sevk alanı), `TRANSIT`; yalnızca `STORAGE` ve `STAGING` sevke uygundur; `location.pick_blocked` (toplama dışı) bayrağı açık sayım görevi olan lokasyonu kullanılabilirden çıkarır |
| İzlenebilirlik | lots, serials, inventory_owners, handling_units | SKT lotta; seri tekil ürün; taşıma birimi iç içe olabilir (palet → koli), döngüsüz |
| Stok | stock_dimensions, stock_ledger, stock_balances, reservations | Defter kaynak (I-04) |
| Planlama | item_stock_policies (min/maks/yeniden sipariş noktası, depo bazlı) | Uyarı üretir, stok değiştirmez |
| Belgeler | documents, document_lines, document_type_versions, document_status_history, number_sequences | İşlenmiş satır + kural sürümü korunur; durum geçmişi append-only |
| Görünürlük | `created_xid xid8 DEFAULT pg_current_xact_id()` — stock_ledger, document_status_history, audit_logs, outbox_events | Kesim noktaları bu sütunla belirlenir (I-16) |
| Operasyon | orders, pick_assignments, tasks, shipments, transfers, counts, returns | Kısmi işlem ve durum geçişleri açık |
| Güvenilirlik | idempotency_records, outbox_events, processed_events | Tekrar teslimat tek etki |
| Platform | metadata_versions, entitlements, plans, subscriptions, feature_flags | Global yazma platform yetkisi |
| Dosya/veri | attachments, export_jobs, import_jobs, deletion_jobs, audit_logs | Sahiplik, saklama, durum |
| Bildirim | notifications, notification_prefs | Tenant/kullanıcı kapsamlı |

## Ürün, lot, seri, birim
- Ürün: temel birim, takip modu (`NONE|LOT|SERIAL|LOT_AND_SERIAL`), miktar hassasiyeti, FIFO/FEFO politikası, min-maks (politika tablosunda).
- Çoklu barkod; barkod birim/paket miktarına bağlanabilir; belirsiz barkod sessizce ilk ürüne atanmaz; GS1 ayrıştırma test edilir.
- Lot ürüne aittir: lot kodu, üretim tarihi, SKT (tarih-only), tedarikçi lotu. SKT özel alan değildir.
- Seri benzersizliği tenant politikasıyla (ürün içi / tenant geneli); seri takipli stok miktarı 1 ve tek konum.
- Birim dönüşümü decimal; katsayı belge satırına kopyalanır (I-09).
- Stok boyutundaki opsiyonel alanların NULL davranışı tek bakiye satırı üretecek şekilde tasarlanır (NULLS NOT DISTINCT veya sentinel).
- Stok durumları: `AVAILABLE` (kullanılabilir), `QUARANTINE` (karantina), `DAMAGED` (hasarlı), `BLOCKED` (bloke). Durum değişimi aynı lokasyonda iki defter satırıdır (eski durum −, yeni durum +). Transit bir durum değil lokasyon türüdür.
- **Taşıma birimi (koli/palet, LPN) kararı — ADR-011:** "1 koli = 12 adet" bir **birim dönüşümüdür** ve mevcut modelde vardır. Koli/paletin kendi kimliğiyle izlenmesi (içeriği tek okutmayla taşınan kap) ise ayrı bir kavramdır: `handling_units` (id, tür KOLI/PALET, barkod/SSCC, üst taşıma birimi, lokasyon, durum AÇIK/KAPALI/BOŞALTILDI) ve stok boyutuna nullable `handling_unit_id`. Sonradan eklemek tüm bakiye ve defter satırlarında migration gerektirdiği için **önerilen varsayılan:** boyut alanı ve tablo Faz 2'de kurulur (NULL = taşıma birimsiz stok, NULL-safe benzersizlik), akışlar yalnızca pilot (b)/(c) cevabı verirse 3A'da, yoksa 3B'de yapılır. Taşıma birimi hareketi = içindeki her boyut için `−`/`+` defter satırı çifti; taşıma biriminin kendisi stok değildir.
- **Takip modu kararı:** Lot, seri ve SKT için veri modeli, kısıtlar ve defter boyutları **her durumda Faz 2'de** kurulur (sonradan eklemek tüm stok tablolarında migration gerektirir); AC-09 bu nedenle koşulsuzdur. Saha akışları (birim başına seri tarama, lot seçimi, FEFO önerisi, SKT uyarıları) pilot `LOT`/`SERIAL` gerektiriyorsa Faz 3A'da, gerektirmiyorsa Faz 3B'de yapılır (AC-34).
- Maliyet/değerleme ayrı ADR; ERP'nin hangi verinin otoritesi olduğu açıkça yazılır.
<!-- END FILE -->

<!-- FILE: docs/spec/05-stock-engine.md -->
# 05 — Stok Motoru

## Belge durumları
| Durum | Stok etkisi | İzin |
|---|---|---|
| DRAFT | Yok | Düzenle, iptal |
| APPROVED | Fiziksel etki yok | İşleme gönder; rezervasyon ayrı işlem |
| POSTED | Kesin | Görüntüle, yetkili ters kayıt |
| CANCELLED | Yok (işlenmemiş) | Salt okunur |
Satır bazında ters çevrilen miktar ve `NONE|PARTIAL|FULL` ters kayıt durumu izlenir. Kısmi operasyonlarda gerçekleşen miktar ayrı hareketle kesinleşir, kalan açık kalır.

## İşlem sözleşmesi (her stok komutu, 7 adım)
1. Kimlik, aktif üyelik, depo/eylem yetkisi, paket hakkı.
2. Şema + idempotency anahtarı (tenant + işlem türü + istek özeti).
3. Transaction aç, tenant bağlamını kur (I-02).
4. Belge sürümü ve stok/rezervasyon satırlarını **§Kilit sözleşmesi**ne göre, yalnızca `acquireStockLocks` ile, tam kilit planını önceden bildirerek kilitle.
5. Yeterlilik, lot/seri, SKT, lokasyon, durum geçişi kontrolleri.
6. Defter + bakiye + rezervasyon tüketimi + belge durumu + audit + outbox + idempotency sonucu **aynı transaction**.
7. Commit → yanıt. Yanıt kaybolursa aynı anahtar önceki sonucu döner.
Serialization/deadlock hatasında tüm transaction sınırlı sayıda gecikmeli yeniden denenir; iş kuralı hatası denenmez. Belge başına satır limiti; uzun kilitler izlenir.

## Rezervasyon ve hareketler
- **Rezervasyon modeli (varsayılan, ADR-009 ile değiştirilebilir):** Rezervasyon, sipariş satırını belirli bir stok boyutuna (lokasyon + lot + durum + sahip) bağlayan **sert tahsistir**. Rezervasyon ve sipariş defter satırı üretmez; fiziksel bakiyeyi değiştirmez. Toplamada rezervasyon, malla birlikte hedef boyuta (sevk alanı) taşınır; sevkte tüketilir; iptalde serbest kalır ve fiziksel stok yerinde kalır (gerekirse geri yerleştirme görevi). Sayısal örnekler: `docs/spec/16-stock-effects.md`.
- Rezervasyon atomik; aynı stok iki siparişe tahsis edilemez; süre aşımı, serbest bırakma, kısmi tüketim, yeniden tahsis. Sevke uygun olmayan stok rezerve edilemez.
- Toplama = depo içi yer değişimi; sevk = müşteriye çıkış; aynı çıkış iki kez yazılmaz.
- FIFO/FEFO politikası; öneriyi değiştirmek yetkili ve gerekçeli; sevk yasağı aşılamaz.
- Fiş numarası tenant + belge türü + dönem kapsamında atomik (sequence tablosu, satır kilidi). Boşluksuz numara gereksinimi ayrıca karar (Q).
- UTC zaman damgası, iş tarihi, tenant saat dilimi ayrı. Kapalı döneme geri tarihli hareket yalnızca düzeltme prosedürüyle.
- Periyodik tutarlılık işi defter ↔ bakiye/rezervasyon karşılaştırır; fark alarmdır, defter sessizce değiştirilmez.

## Kilit sözleşmesi (I-15)
Deadlock'u önlemenin tek yolu tüm stok komutlarının aynı sırayla kilit almasıdır. Bu sıra ajanların takdirine bırakılmaz. Stok komutu kilitlerini **yalnızca tek giriş noktasıyla** alır: `packages/db/src/locking.ts` içindeki `acquireStockLocks(tx, tenantId, plan)`. Alt adımlar (`lockDocument`, `lockBalances` vb.) bu dosyadan dışarı **export edilmez**; komutlar onları tek tek çağıramaz.

**Kilit planı** (komut, kilitlemeden önce ihtiyacının tamamını bildirir; sonradan kilit eklenmez):
```ts
type StockLockPlan = {
  document?: { id: string; expectedVersion: number };   // belge başlığı + sürüm kontrolü
  locationIds: string[];                                // hareketin dokunduğu kaynak + hedef lokasyonlar (sayım kilidi kontrolü için)
  dimensions: StockDimensionKey[];                      // bakiyesi değişecek tüm boyutlar (kaynak + hedef; taşıma birimi dahil)
  reservationIds: string[];                             // tüketilecek / taşınacak / serbest bırakılacak rezervasyonlar
  serialIds: string[];                                  // hareket eden seri numaraları
  countSessionId?: string;                              // YALNIZCA sayım farkı komutu doldurur; istisnanın tek anahtarı
};
```

**`acquireStockLocks` adımları — sıra sabittir, atlanabilir ama yer değiştiremez:**
| # | Adım | SQL davranışı | Sıra anahtarı |
|---|---|---|---|
| 1 | `lockDocument` | `SELECT … FROM documents WHERE id=$1 FOR UPDATE`; `version ≠ expectedVersion` → `VERSION_CONFLICT` | tek satır |
| 2 | `assertLocationsNotCounting` | `SELECT … FROM location_count_locks WHERE location_id = ANY($1) ORDER BY location_id FOR SHARE` (sayım farkı komutunda `FOR UPDATE`). Kilit satırı yoksa → hata `COUNT_LOCK_ROW_MISSING` (veri bütünlüğü ihlali, alarm). Durum `COUNTING` ise → `LOCATION_LOCKED`; **tek istisna** aşağıdaki sayım farkı kuralıdır. Ayrıntı: `docs/spec/06-operations.md` §Sayım kilidi yaşam döngüsü | `location_id` artan |
| 3 | `ensureDimensions` + `ensureBalanceRows` | Eksik boyut ve bakiye satırları sıralı `INSERT … ON CONFLICT DO NOTHING` | boyut anahtarı / `stock_dimension_id` artan |
| 4 | `lockBalances` | `SELECT … FROM stock_balances WHERE stock_dimension_id = ANY($1) ORDER BY stock_dimension_id FOR UPDATE` | `stock_dimension_id` artan |
| 5 | `lockReservations` | `SELECT … FROM reservations WHERE id = ANY($1) ORDER BY id FOR UPDATE` | `id` artan |
| 6 | `lockSerials` | `SELECT … FROM serials WHERE id = ANY($1) ORDER BY id FOR UPDATE` | `id` artan |

Dönüş değeri: kilitlenmiş satırların anlık görüntüsü (`LockedState`). Komut iş kurallarını (yeterlilik, lot/SKT, durum geçişi) **bu görüntü üzerinde** kontrol eder ve yazma işlemlerini yalnızca bu satırlara yapar.

- **Satırlar arası sıra:** Her adımda tekil ve değişmez anahtar artan. `item_id, location_id` gibi eksik anahtarlar kullanılmaz (lot, durum, sahip de boyutun parçası). Uygulamada da (`Set` + sort) ve SQL'de de (`ORDER BY`) sıralanır.
- **Kilit, güncellemeden önce:** Bakiye, rezervasyon ve seri `UPDATE`'leri yalnızca `LockedState` içindeki satırlara yapılır. Kilitsiz toplu `UPDATE` stok tablolarında yasaktır. Plan dışında kalan bir satıra ihtiyaç doğarsa komut iptal edilir ve planı genişletilerek baştan çalıştırılır.
- `lock_timeout` kısa tutulur; deadlock/serialization hatasında tüm transaction sınırlı sayıda gecikmeli yeniden denenir (en fazla 3, jitter'lı). Uzun kilit süresi metrik ve alarm üretir.
- Doğrulama: AC-27 (ters sıralı satırlarla eşzamanlı siparişler), AC-13 (sayım kilidi koordinasyonu) ve lint kuralı: stok tablolarında `FOR UPDATE` / `FOR SHARE` yalnızca `locking.ts` içinde; `locking.ts`'den yalnızca `acquireStockLocks` ve tipleri export edilebilir.

## Senkron işlem sınırları
Stok kesinleştirmesi kısa olmalıdır; bu barındırma platformunun HTTP zaman aşımından bağımsız bir kuraldır (zaman aşımı yalnızca belirtidir, sorun uzun kilit süresidir).
- **Bir belge = bir transaction.** Atomikliği korumak için bir belgenin işlenmesi birden çok transaction'a bölünmez.
- **Senkron sınır:** Satır sayısı eşiğin (öneri 200, ADR ile kesinleşir) altındaki belgeler istek içinde işlenir. Üstündekiler worker'da, **aynı 7 adımlı sözleşme ve aynı idempotency anahtarıyla** işlenir; belge `APPROVED` kalır ve `posting_job_id` taşır, arayüz "işleniyor" gösterir, sonuç `POSTED` ya da gerekçeli hata olur. Worker'da işlemek kilit süresini kısaltmaz; yalnızca HTTP isteğini serbest bırakır.
- **Sert sınır:** Belge başına azami satır (öneri 2.000). Üstü tek belge olarak kabul edilmez; import akışı birden çok belgeye böler.
- Server Action ve Route Handler ince giriş katmanıdır: yetki + doğrulama + domain komutu çağrısı. Büyük okuma (rapor, export) Server Action'da yapılmaz; worker işine çevrilir.
- Her komut sınıfına `statement_timeout` ve `lock_timeout` verilir. İzlenen ölçüler: transaction süresi p95/p99, kilit bekleme süresi, deadlock sayısı, async belge kuyruğu yaşı. Stok kesinleştirme p95 > 1 sn alarm üretir. Test: AC-36.

## Outbox relay (I-07)
> ADR-005'te **Postgres kuyruğu** seçilirse iş, stok işlemiyle aynı transaction'da kuyruğa yazılır; ayrı relay gerekmez ve bu bölümün yalnızca **tüketici** kuralları (processed_events, haricî idempotency anahtarı, FAILED/alarm) geçerlidir. Aşağıdaki relay kuralları BullMQ/RabbitMQ seçildiğinde uygulanır.

Postgres → kuyruk aktarımı "tam bir kez" olamaz; hedef **en az bir kez teslim + etkide tam bir kez**tir.
- `outbox_events`: `id` (UUID, olay kimliği = idempotency anahtarı), `tenant_id`, `type`, `payload`, `status` (`PENDING|PUBLISHED|FAILED`), `attempts`, `next_attempt_at`, `published_at`, `created_seq` (monoton).
- Relay döngüsü: kısa transaction'da `SELECT … WHERE status='PENDING' AND next_attempt_at<=now() ORDER BY created_seq LIMIT n FOR UPDATE SKIP LOCKED` → kuyruğa ekle → `status='PUBLISHED'`. Birden çok relay örneği aynı satırı alamaz (SKIP LOCKED).
- Kuyruğa eklerken **jobId = outbox event id** verilir; relay commit'ten önce çökerse ikinci ekleme aynı jobId'ye çarpar. BullMQ jobId tekilliği yalnızca iş kuyrukta/saklanırken geçerlidir; bu yüzden asıl güvence tüketici tarafındadır.
- Tüketici: işi yan etkisiyle birlikte aynı DB transaction'ında `processed_events (consumer, event_id)` PRIMARY KEY'ine yazar; çakışma = zaten işlenmiş → sessizce onayla. Haricî sistem çağrılarında (e-posta, ERP, webhook) olay kimliği karşı tarafa idempotency anahtarı olarak gönderilir.
- Başarısızlıkta üstel geri çekilme; `attempts` eşiğinde `FAILED` + alarm + yönetici ekranından yeniden gönderme. Aynı aggregate için sıra gerekiyorsa sıralama anahtarı (`tenant_id + aggregate_id`) ile tek tüketici grubu.
- Redis tamamen kaybolursa `PUBLISHED` ama işlenmemiş olaylar `processed_events` ile karşılaştırılarak yeniden kuyruğa alınır (yeniden kurma komutu).

## Geri alma ve arşiv
- Kullanılmış kart (ürün, lot, lokasyon) silinmez, arşivlenir.
- Taslak iptal edilebilir; işlenmiş belge yalnızca ters kayıtla (I-08). Aynı ters işlem tekrar gönderilirse ikinci etki yok.
- Sonraki sevk/transfer/rezervasyon/seri hareketi ve kapalı dönem kontrol edilir; uygun değilse neden + çözüm önerisiyle ret (örn. 100 giriş, 60 sevk → tam geri alma reddedilir).
- Gerekçe, aktör, onaylayan, kaynak ve ters belge bağlantısı saklanır.
- Varsayılan negatif stok yasaktır (I-05).
<!-- END FILE -->

<!-- FILE: docs/spec/06-operations.md -->
# 06 — Depo Operasyonları

## Görevlendirme
Mal kabul, yerleştirme, toplama, sevk ve sayım görevleri depo yöneticisince personele atanır veya personel üstlenir (yetkisi olan depoda). Saha ekranı sadeleştirilmiş görev listesidir: barkod tara → ürün/lokasyon doğrula → miktar onayla → rafa koy/raftan al. Birden çok siparişin birlikte toplanması "sipariş toplama görevlendirmesi" adıyla yapılır.

## Mal kabul ve yerleştirme
Beklenen teslim referansı → fiziksel kabul → kalite/karantina → yerleştirme. Kısmi, fazla/eksik, hasarlı kabul kaydedilir. Yerleştirme ikinci stok girişi oluşturmaz.

## Sipariş, toplama, sevk
Sipariş → rezervasyon → toplama görevi → paketleme → sevk. Kısmi miktar, ürün bulunamadı, yeniden atama, iptal, barkod doğrulaması. Toplama/paket/sevk belge bağlantıları izlenebilir; kısmi sevk ve açık bakiye desteklenir.

## Transfer
Kaynak çıkışı → transit → hedef kabul. Hedef kabul edilmeden hedefte kullanılabilir olmaz. Kısmi kabul, hasar/kayıp, red ve kaynağa dönüş ayrı hareket; toplam miktar korunur.

## İade ve üretim
Müşteri iadesi orijinal sevke bağlanabilir; miktar ve lot/seri doğrulanır; varsayılan karantina. Tedarikçiye iade ayrı çıkış. Üretimden giriş ve sarf iş emri referansıyla; tam MRP sonraki kapsam.

## Sayım
İlk sürüm: seçili lokasyonlarda sunucu tarafı hareket kilidi (kaynak ve hedef hareketi kapsar; kilit süresince offline gelen hareketler de işlenmez).

### Sayım kilidi yaşam döngüsü
- **Satır önceden vardır.** Her lokasyon için `location_count_locks` satırı (`location_id` PK, `status IDLE|COUNTING`, `count_session_id`, `locked_at`, `locked_by`) **lokasyonla aynı transaction'da** oluşturulur; mevcut lokasyonlar için migration geri doldurur. Gerekçe: olmayan satıra `FOR SHARE` hiçbir şeyi kilitlemez; satır sayım başlarken oluşturulsaydı süren bir stok işlemiyle yarışırdı. Lokasyon silinmez, arşivlenir; kilit satırı da kalır. Tutarlılık işi her lokasyonun tam bir kilit satırı olduğunu denetler.
- **Sayım başlatma:** Tek transaction'da seçilen lokasyonların kilit satırları `location_id` artan sırayla `FOR UPDATE` alınır (süren stok işlemleri `FOR SHARE` tuttuğu için onların bitmesi beklenir; `lock_timeout` aşılırsa başlatma yeniden denenir veya kullanıcıya "lokasyonda süren işlem var" gösterilir) → hepsi `IDLE` ise `COUNTING` + `count_session_id` yazılır → aynı transaction'da referans bakiyeler sabitlenir. Biri zaten `COUNTING` ise başlatma tümüyle reddedilir (kısmi kilit yok).
- **Sayım süresince:** Normal stok komutları bu lokasyonlara `LOCATION_LOCKED` alır (kaynak veya hedef olarak). Okuma, rapor ve sayım gözlemi kaydı serbesttir. Lokasyon toplama önerilerinden çıkarılır.
- **Kontrollü istisna — sayım farkı komutu:** Kilitli lokasyona yalnızca şu koşulların **hepsi** sağlanırsa stok yazılır: komut türü `COUNT_ADJUSTMENT`; plan `countSessionId` taşır ve kilit satırındaki `count_session_id` ile eşleşir; oturum durumu `APPROVED` (fark onaylanmış); kullanıcı `sayım_farkı.onayla` yetkisine sahip; komutun dokunduğu **her** lokasyon bu oturuma kilitli (başka oturuma kilitli veya kilitsiz lokasyona yazamaz). Komut fark satırlarını işler ve **aynı transaction'da** kilitleri `IDLE`'a çevirir; ayrı "kilidi aç" adımı yoktur.
- **İptal:** Yetkili iptal, fark uygulamadan kilitleri aynı transaction'da `IDLE`'a çevirir; gerekçe audit'e yazılır.
- **Terk edilmiş sayım:** Tanımlı süreyi (öneri 8 saat, tenant ayarı) aşan `COUNTING` kilitleri alarm üretir; otomatik açılmaz, yalnızca yetkili iptal veya onayla kapanır.

Oturum başlayınca referans bakiye sabitlenir. Kör sayım, ikinci sayım, tolerans, fark onayı. Fark fişi işlenmeden kilit açılmaz; iptalde fark uygulanmaz. Hareket sürerken sayım (cutoff/snapshot) ayrı sürüm. Periyodik dönüşümlü sayım (cycle count) planı sonraki sürüm.
<!-- END FILE -->

<!-- FILE: docs/spec/07-mobile-offline.md -->
# 07 — Mobil, Donanım ve Offline

## Donanım
### Tarama kaynağı önceliği
1. **Donanım tarayıcı** (Zebra/Honeywell el terminalinin dahili motoru veya USB/Bluetooth HID okuyucu) — saha için birincil yol.
2. **Kamera** — yedek yol (yönetici ekranları, donanımsız küçük depolar).

### Web uygulamasının (PWA) teknik sınırı
- Tarayıcıda çalışan bir PWA, Android **DataWedge intent** çıktısını doğrudan alamaz; intent yalnızca yerel uygulamalara gider. Bu nedenle PWA'da DataWedge **keystroke çıkışı** modunda yapılandırılır. Intent entegrasyonu gerekiyorsa (daha güvenilir, odak bağımsız) üç yol vardır ve ADR-010 ile seçilir: Zebra Enterprise Browser, ince yerel kabuk (TWA/Capacitor) veya keystroke ile kalmak.
- Tüm kaynaklar tek `ScannerService` arkasındadır; ekranlar yalnızca `onScan(value, source)` olayını dinler.

### Keystroke (klavye kaması) yakalama katmanı
- DataWedge/okuyucu profili: sabit **önek** (örn. STX veya nadir bir karakter) ve **sonek** (Enter). Global `keydown` dinleyicisi önek–sonek arasını tampona alır; tuşlar arası süre eşiği (örn. < 30 ms) ve önek birlikte "tarama" kabul edilir. İnsan yazımı tarama sayılmaz.
- Tarama sırasında sanal klavyenin açılmaması için tarama alanlarında `inputmode="none"`; odak kaybında tampon kaybolmaz (global dinleyici).
- **Türkçe klavye düzeni riski:** HID okuyucular tuş kodu gönderir; cihaz klavyesi Türkçe Q iken `i/ı`, `-`, `/`, `.`, `*` gibi karakterler yanlış üretilebilir. Okuyucu ve cihaz düzeni eşleştirilir (veya okuyucu Unicode/Alt-kod moduna alınır); test matrisinde Türkçe düzen zorunludur (AC-35).
- **GS1 ayracı (FNC1 / ASCII 29)** keystroke modunda kaybolabilir; profilde görünür bir yer tutucu karaktere eşlenir ve ayrıştırıcı bunu tanır.

### Kamera yolu
- Desteklenen tarayıcıda yerel `BarcodeDetector`, yoksa WASM tabanlı çözücü; fener (torch) kontrolü, odak kilidi, aynı kodun tekrar okunmasını önleyen kısa bekleme.

### Test ve ölçüm
- Cihaz/tarayıcı matrisi: pilot cihazları × klavye düzeni × tarama kaynağı. Senaryolar: loş ışık, kirli/hasarlı etiket, buruşuk poşet, ardışık hızlı tarama, yanlış ürün okutma.
- Sayı bazlı saha ölçüleri: tarama başına süre (ms), görev başına yeniden tarama sayısı, okunamayan etiket sayısı (günlük).
- Etiket yazıcı: format (ZPL/PDF), DPI ve yazdırma yolu (tarayıcı, yerel köprü, ağ yazıcısı) ADR ile seçilir.

## Offline (Faz 5)
- İlk kapsam: önceden atanmış göreve ait tarama, miktar ve sayım gözlemi. Serbest sevk, stok düzeltme, onaysız tahsis offline kesinleşmez.
- Offline kayıt komuttur (I-10). Fiziksel hareket yapılmış ama sunucu reddetmişse düzeltme/yeniden yerleştirme görevi oluşur; kayıt sessizce atılmaz.
- Komut alanları: `operation_id`, tenant, aktör, cihaz, görev, şema sürümü, beklenen belge sürümü, yerel sıra, payload. Cihaz saati sıra otoritesi değildir.
- Durumlar: yerelde bekliyor → gönderiliyor → kabul / çatışmalı / reddedildi; her komut için sonuç ve gerekçe görünür.
- Aynı belge/görevde bağımlı komutlar sıralı; bağımsızlar kontrollü paralel; batch sonucu komut bazında.
- İki cihaz aynı son ürünü işlerse ilk geçerli kesinleşen kabul; diğeri yönetici onay ekranına "Senkronizasyon Çakışması" olarak düşer.
- Background Sync yalnızca destekleyen tarayıcıda ek kolaylık; açılışta, bağlantı dönüşünde ve manuel senkron da var. Depolama temizliği riski kullanıcıya gösterilir.
- IndexedDB verisi tenant/kullanıcı bazında ayrık; ortak cihazda çıkışta bekleyen işlem uyarısı; azami offline süre ve yerel veri temizleme politikası Faz 0 kararı.
<!-- END FILE -->

<!-- FILE: docs/spec/08-ux-i18n.md -->
# 08 — UI/UX, Dil ve Onboarding

## "Sıfır eğitim" ilkesi
Sistem kullanıcıya hizmet eder; ilk kez kullanan kişi ekranda ne yapacağını anlamalıdır. Mevcut Claude Design kanvası (16 ekran) görsel referanstır; ekran kartları ilgili kanvas ekranını referans gösterir.

## Kurallar
- Dokunma hedefi ≥48×48 CSS px; klavye erişimi, görünür odak, WCAG AA kontrast.
- Mobil görev ekranlarında yatay taşma yok. Tablolar küçük ekranda kart görünümüne döner veya sütun gizler; geniş rapor tablolarında kontrollü yatay kaydırma veya sütun seçimi kabul, veri kırpılmaz.
- Sabit üst bar + eylem çubuğu; büyük liste ve tablolarda TanStack Virtual ile liste içi dikey kaydırma.
- Hata mesajı neden + sonraki eylem. Bekleyen offline, kesinleşmiş ve reddedilmiş işlem görsel ve metinsel olarak ayrışır.
- Yıkıcı işlemler onay ister; ters kayıt ekranı etkisini önceden gösterir.

## Dil
next-intl, TR ve EN; JSON tabanlı yeni dil eklenebilir. Tarih, saat dilimi, sayı yerelleştirilir; API decimal/date formatı sabit; tarih-only SKT saat dilimiyle gün değiştirmez. Tenant terminolojisi (Koli, Metre, Parti/Lot, Göz Kodu…) yalnızca etiketi değiştirir.

## Landing ve onboarding
- Kredi kartsız 14 gün deneme; Google/Microsoft/e-posta ile 1 dakikada çalışma alanı. Telefon doğrulaması zorunluluğu ürün kararı (maliyet).
- Sektör sihirbazı: seçilen sektöre göre ölçü birimleri, varsayılan depo/lokasyon şablonu, fiş tipleri, takip modları yüklenir; şablon izlenebilirlik kurallarını gevşetmez.
- Tenant oluşturma ve şablon yükleme idempotent; yarım kalan onboarding devam eder. İlk stok kontrollü açılış fişiyle girilir. Deneme için isteğe bağlı örnek veri (ayrı işaretli, tek tıkla silinebilir).
<!-- END FILE -->

<!-- FILE: docs/spec/09-integrations.md -->
# 09 — Import ve Entegrasyonlar

## CSV/Excel import
Yükle → sütun eşleştir (akıllı öneri) → önizle/validate → hataları indir → onayla → worker'da işle. Birim, tarih, barkod, encoding (Windows-1254 dahil), yinelenen satır kuralları tanımlı. Kart import'u ≠ stok açılış import'u; stok import'u defteri atlayamaz. Her satırın dış referansı/idempotency kaydı; tekrar import çift stok yapmaz. Formül/CSV injection, zip bomb, boyut/satır sınırları.

## Logo ERP (Go/Tiger)
Ürün/sürüm, örnek export ve alan eşleme matrisi doğrulanmadan "birebir uyum" iddiası yok. ERP veritabanına doğrudan yazılmaz; belgelenmiş API, kontrollü adapter veya export/import. Ürün, sipariş, stok, cari için otorite ayrı belirlenir; dış referans ve senkron cursor'ları saklanır; hata ve mutabakat ekranı.

## Webhook ve olaylar
Gelen/giden webhook'larda imza, zaman penceresi, tekrar kontrolü, retry/backoff, dead-letter; sırasız olaylar sürüm kontrolüyle.

## e-İrsaliye
WMS sevk belgesi e-İrsaliye değildir. Gerekirse özel entegratör adapter'ı (Faz 6) ile gönderim; belge durumu geri alınır.

## Public API (Faz 6)
Tenant API anahtarları (kapsamlı izin, rotasyon, hash'li saklama), sürümlü REST, rate limit, idempotency başlığı; aynı domain komutları.

## B2B (Faz 7)
İzinli veri paylaşımı, iki tarafta ayrı belgeler; tenantlar arası genel RLS istisnası açılmaz; izin iptali ve paylaşılan alanlar açık.
<!-- END FILE -->

<!-- FILE: docs/spec/10-metadata-engine.md -->
# 10 — No-Code Metadata Motoru (Faz 6)

- JSONB özel alanlar: ürün, cari, depo, belge başlığı/satırı. Türler: metin, sayı, tarih, seçim, barkod, görsel URL. Çekirdek alanlar (miktar, rezervasyon, lot/seri, sahiplik, durum, SKT) metadata'ya taşınmaz (I-11).
- Katman 1 (süper yönetici/global) ve Katman 2 (tenant) ayrı tablolar/politikalar; global tanımlar tenant için salt okunur; tenant yalnızca paketi dahilinde etiket ve görünürlük ayarlar.
- Doğrulama sunucuda, sürümlü JSON Schema'dan; form aynı şemadan çizilir (server-driven UI).
- Sürüm durumları: taslak → doğrulanmış → yayımlanmış → emekli. Yeni zorunlu alan için backfill/default planı; tür değişiminde sessiz dönüşüm yok.
- Yeni fiş tipi yalnızca test edilmiş davranışlardan türetilir: giriş, çıkış, lokasyon/durum/sahiplik değişimi, rezervasyon, etkisiz. Keyfî kod/SQL, sınırsız kural zinciri, çekirdek kontrolü kapatma yok. Çok aşamalı semantik (transfer gibi) kod + test gerektirir.
- `feature_key` ile paketlere bağlama; entitlement sunucuda uygulanır, upsell modalı sunumdur. Feature flag (dağıtım) ≠ entitlement (ticari hak).
- JSONB sorguları için hedefli indeks ve boyut sınırı.
<!-- END FILE -->

<!-- FILE: docs/spec/11-ai.md -->
# 11 — AI ve BYOK (Faz 7)

- Kapsam: sesle fiş taslağı, fatura/irsaliye fotoğrafından OCR satır çıkarma, anomali uyarısı, talep tahmini.
- Ses/OCR yalnızca taslak üretir; sunucu validasyonu + kullanıcı düzeltmesi + yetkili onay olmadan stok kesinleşmez. Düşük güven, birim uyuşmazlığı, bilinmeyen ürün işaretlenir.
- BYOK ve yönetilen AI ayrı limit/faturalama; BYOK platform ücretini ve sağlayıcı ücretini netleştirir.
- Anahtarlar sunucuda şifreli; tarayıcıya dönmez, loglanmaz; rotasyon/silme denetimli.
- Tenant başına model, bütçe, istek/token, dosya sınırı; retry çift fiş/ücret üretmez.
- Belge içeriği güvenilmeyen girdidir; prompt injection yetki vermez; AI araç çağrıları normal yetki sözleşmesine tabi.
- PII maskeleme, veri bölgesi ve sağlayıcı saklama koşulları seçilen hizmet için doğrulanır; öneriler açıklanabilir ve kullanıcı kontrolünde.
<!-- END FILE -->

<!-- FILE: docs/spec/12-billing-lifecycle.md -->
# 12 — Abonelik, Takeout, Offboarding

## Abonelik
- Tenant durumları: `TRIAL`, `ACTIVE`, `PAST_DUE` (ödeme gecikmiş), `RESTRICTED` (kısıtlı), `SUSPENDED` (askıda; giriş ve okuma açık, yazma kapalı), `CLOSING_GRACE` (kapatma, 30 gün), `DELETION_PENDING`. Geçişler tek durum makinesinde tanımlanır; operasyon durumu ödeme sağlayıcısı durumundan ayrıdır.
- Ödeme sağlayıcısı ADR-008: TR şirketi için yinelenen ödeme destekleyen yerel sağlayıcı (iyzico/PayTR vb.); global sağlayıcıların TR desteği Faz 0'da doğrulanır.
- Abonelik ücretleri için e-Fatura/e-Arşiv düzenleme (entegratör) ve KDV kuralları Faz 4S'te (pilot ücretsiz olduğundan pilot sonrası).
- Webhook imzalı ve idempotent; sırasız olay eski durumu geri getirmez. Proration, vergi, yenileme, iptal sağlayıcı sözleşmesine göre.
- Her yazmada hak kontrolü; limitler eşzamanlı isteklerle aşılamaz.

## Paket düşürme ve veri hakları
- Paket düşürmede **hiçbir veri silinmez ve gizlenmez.** Limit aşan kayıtlar (fazla depo, kullanıcı, ürün vb.) "salt okunur" işaretlenir; yeni kayıt açma ve bu kayıtlar üzerinde yeni hareket limit dahilinde engellenir.
- Aşağıdakiler **paket, ödeme durumu ve feature flag'den bağımsız** her zaman açıktır (deneme bitmiş, ödeme gecikmiş, kısıtlı ve askıda durumları dahil; kapatma sürecinde yalnızca yetkili yöneticiler için, bkz. §Kapatma): tüm kart, belge, hareket ve stok ekranlarını görüntüleme; liste/rapor ekranlarından CSV/JSON indirme; tam takeout. Bunlar entitlement kontrolüne değil yalnızca kimlik, yetki (`takeout.talep_et`, `stok.görüntüle`) ve rate limit kontrolüne tabidir.
- Salt okunur moddaki ekranlar nedenini ve çözümünü gösterir ("Paket limiti: 3 depo. Bu depo salt okunur. Yükselt / başka depoyu arşivle"). Upsell modalı veriye erişimi engellemez.
- Başlamış operasyonlar (açık transfer, toplama, sayım kilidi) düşürme anında yarım kalmaz: tamamlanmasına veya güvenli iptaline izin verilir; bekleyen offline komutlar yeniden doğrulanır, fiziksel hareket yapılmışsa düzeltme görevi oluşur.
- Düşürme öncesi ekranda etkilenecek kayıtların özeti gösterilir; kullanıcı hangi depoların/kullanıcıların aktif kalacağını seçer.

## Takeout ve büyük veri dışa aktarımı
Yetkili yönetici + yeniden doğrulama. Kartlar, belgeler, hareketler, lot/seri, görevler, metadata sürümü, dosya manifesti; sırlar ve platform logları hariç. JSON+CSV(+Excel), manifest (format sürümü, kesim noktası, satır sayıları, checksum). Şifreli arşiv anahtarı ayrı kanaldan; kısa ömürlü signed URL; geçici dosya TTL.

**Ana DB'yi kilitlememe kuralları:**
- İş yalnızca worker'da, ayrı ve düşük öncelikli kuyrukta, tenant başına aynı anda tek takeout ile çalışır.
- Okuma kaynağı: read replica varsa replica (yetki kontrolü primary'de yapılır, iş başlamadan önce); yoksa primary üzerinde **keyset (seek) sayfalama ile parçalı okuma**: `WHERE tenant_id=$t AND id > $last ORDER BY id LIMIT 5000`, her parça ayrı kısa transaction, `statement_timeout` ve `lock_timeout` ile. Uzun açık transaction, `OFFSET` sayfalama ve tüm veriyi belleğe alma yasaktır.
**Kesim noktası protokolü (I-16):**
`max(ledger_seq)` kesim noktası olarak **kullanılmaz**: sequence değeri `nextval` anında verilir, commit sırasını garanti etmez. Seq 100'ü alan işlem beklerken 101 commit olabilir; export 101'i görüp 100'ü görmezse, 100 daha sonra commit olduğunda "≤ H" filtresi onu da içeri alır ve kesit bozulur. Bunun yerine transaction görünürlüğüne dayalı kesim kullanılır:
1. Append-only tablolar (`stock_ledger`, `document_status_history`, `audit_logs`, `outbox_events`) her satırda yazan transaction'ın kimliğini tutar: `created_xid xid8 NOT NULL DEFAULT pg_current_xact_id()`.
2. Export başında, primary'de tek kısa sorguyla `S = pg_current_snapshot()` ve `L = pg_current_wal_lsn()` alınır ve `export_jobs` satırına yazılır. Uzun süre açık tutulan transaction yoktur.
3. Kesite dahil olma kuralı: satır yalnızca `pg_visible_in_snapshot(created_xid, S)` ise export edilir. Snapshot alındığı anda commit olmamış her işlem (seq numarası ne olursa olsun) dışarıda kalır; sonradan commit olması sonucu değiştirmez.
4. Sayfalama bu filtreyle birlikte keyset ile yapılır (`ledger_seq > $last`); sayfalar farklı zamanlarda okunsa da sonuç aynı kesittir.
5. Replica kullanılıyorsa okuma başlamadan önce `pg_last_wal_replay_lsn() >= L` beklenir; aksi halde kesite dahil olması gereken satırlar henüz replikada olmayabilir.
6. Export'taki bakiyeler bakiye tablosundan değil, bu kesitteki defter satırlarından yeniden hesaplanır. Belge durumları `document_status_history`'den aynı kesite göre türetilir.
7. Değişebilen tablolar (kartlar, ayarlar, lokasyonlar) export anındaki son hâliyle alınır; manifest bunu `mutable_tables_as_of` alanında açıkça belirtir. Kesitteki hareketlerin referans verdiği her kart export'ta bulunur (arşivlenmiş olsa bile).
8. Manifest: `snapshot`, `wal_lsn`, kesim zamanı, dosya başına satır sayısı, checksum ve `deterministic` bayrağı.
9. **Checksum garantisinin kapsamı:** `deterministic: true` dosyalar (kesite bağlı append-only tablolar ve bunlardan türetilen bakiyeler/belge durumları) aynı kesitle yeniden üretildiğinde **aynı checksum'ı** verir; satırlar sabit anahtar sırasıyla ve sabit serileştirme biçimiyle (alan sırası, sayı ve tarih formatı) yazılır. `deterministic: false` dosyalar (değişebilir tablolar, ekler) yalnızca **bütünlük** checksum'ı taşır: indirilen dosyanın bozulmadığını kanıtlar, yeniden üretildiğinde aynı olacağını garanti etmez. Arşivin tamamı için tekrar üretilebilirlik garantisi verilmez; manifest bunu açıkça yazar.

Aynı kural, sequence'i "buraya kadar işlendi" işareti olarak kullanma eğiliminde olan tüm tüketiciler için geçerlidir: artımlı raporlar, ERP senkron cursor'ları, tutarlılık işi. Bunlar da ya `xid8` görünürlüğü ya da durum alanı (`status = PENDING` gibi) ile çalışır.
- Çıktı akış (stream) olarak doğrudan object storage'a multipart yüklenir; satır sayıları ve checksum parça parça hesaplanır.
- İlerleme yüzdesi, tahmini süre ve iptal edilebilirlik kullanıcıya gösterilir; kesilen iş son tamamlanan parçadan devam eder (`export_jobs.cursor`).
- Aynı mekanizma liste ekranlarındaki büyük CSV/Excel indirmeleri için de kullanılır; belirli satır sayısının üzerindeki indirmeler otomatik olarak arka plan işine çevrilir.

## Kapatma ve silme
Kapatma talebi yeniden doğrulama ister. Tenant `CLOSING_GRACE` durumuna geçer; bu 30 günlük geri açılabilir süredir (hukuki saklama süresi değildir). Ayrılışta tek tık churn anketi.

**`CLOSING_GRACE` süresince ne durur, ne açık kalır:**
| Konu | Davranış |
|---|---|
| Mevcut oturumlar | Tüm kullanıcıların oturumları iptal edilir |
| Yeniden giriş | Yalnızca `takeout.talep_et` yetkisi olan kullanıcılar (sahip/yönetici), MFA ile; diğer kullanıcılar giremez |
| Erişilen arayüz | "Hesap kapatma sürecinde" salt okunur portalı: tüm veriyi görüntüleme, CSV/JSON indirme, takeout talebi, hesabı yeniden açma. Başka ekran yok |
| Yazma | Tümü reddedilir (`TENANT_CLOSING`); açık operasyonlar kapatma öncesinde tamamlanır veya iptal edilir (kapatma ekranı listeler) |
| Entegrasyon/API anahtarları, webhook'lar | İptal edilir |
| Worker işleri | Operasyonel işler (import, senkron, bildirim, AI, tahmin) durur. **Açık kalanlar:** takeout/export, kapatma bildirimleri, silme hazırlığı. Worker her iş başında tenant durumunu kontrol eder ve yalnızca izinli iş türlerini çalıştırır |
| Bekleyen offline komutlar | Reddedilir; cihaz tarafı "hesap kapatıldı" gösterir |
| Faturalama | Yeni dönem tahakkuku durur |

**Yeniden açma:** 30 gün içinde yönetici tek adımda yeniden açar; anahtarlar yeniden üretilir, eski oturumlar geçersiz kalır.

**Süre sonu:** Tenant `DELETION_PENDING` → silme işi. Kayıt sınıfına göre silme/saklama/anonimleştirme (DB, medya, cache, arama, geçici export dosyaları). Silme işi idempotent, parçalı ve izlenebilir. Süre sonunda üretilmiş ama indirilmemiş takeout dosyaları da silinir; kullanıcı son 7 gün ve son gün e-postayla uyarılır. Yedekler kendi döngüsünde sona erer; restore sonrası silme işaretleri yeniden uygulanır.

Ödeme gecikmesi nedeniyle `SUSPENDED` durumu kapatmadan farklıdır: tüm kullanıcılar giriş yapar, veri görüntülenir ve indirilir (I-13), yalnızca yazma kısıtlanır.
<!-- END FILE -->

<!-- FILE: docs/spec/13-reporting-notify-print.md -->
# 13 — Raporlar, Uyarılar, Bildirim ve Yazdırma (önceki belgelerde eksikti)

## Temel raporlar (pilot raporları Faz 3A, diğerleri 3B)
Anlık stok durumu (depo/lokasyon/lot/durum), hareket ekstresi (ürün/lokasyon/tarih), SKT yaklaşan ve geçmiş lotlar, min-maks altı ürünler, yavaş dönen/hareketsiz stok, açık siparişler ve rezervasyonlar, transit stok, sayım farkları, personel görev performansı (adet bazlı). Raporlar tenant kapsamlı, sayfalı; büyük çıktılar worker ile Excel/CSV.

## Uyarılar
Min-maks / yeniden sipariş noktası, SKT eşiği, tutarlılık farkı, senkronizasyon çatışması, kuyruk/entegrasyon hatası. Uyarı kuralı tenant ayarlıdır, stok değiştirmez.

## Bildirim
Uygulama içi + işlemsel e-posta (Faz 1); push/SMS sonraki. Kullanıcı tercihleri; işlemsel ve pazarlama ayrı (İYS). Tüm gönderimler outbox üzerinden.

## Yazdırma
A4 belge PDF'leri (irsaliye benzeri sevk belgesi, toplama listesi, sayım formu) ve etiketler (ürün, lokasyon, koli; ZPL/PDF). Şablonlar tenant logosu ve terminolojisiyle; şablon sürümü belgeye kaydedilir.

## Arama
Ürün kodu/adı/barkod ile hızlı arama (PostgreSQL trigram/tam metin); ayrı arama motoru ölçüme göre.
<!-- END FILE -->

<!-- FILE: docs/spec/14-reliability-ops.md -->
# 14 — Dayanıklılık, Gözlem, Dağıtım

- Ortamlar: local (docker compose: postgres, pgbouncer transaction mode, minio, mailpit; redis yalnızca broker seçilirse), dev, staging, prod; veriler ve sırlar ayrık; prod verisi maskesiz teste taşınmaz.
- DB otomatik yedek + PITR; dosyalarda sürümleme; şifreleme anahtarlarının kurtarılması planlı.
- İlk prod öncesi tam restore tatbikatı, sonra en az üç ayda bir; DB + dosya + metadata + silme işaretleri birlikte; ölçülen RPO/RTO raporlanır.
- Kuyruk outbox'tan yeniden kurulabilir; Redis kaybında kesinleşmiş stok kaybolmaz.
- Yapılandırılmış log, request/trace ID (OpenTelemetry), hata izleme. Alarmlar: gecikme, hata oranı, DB bağlantı/kilit, kuyruk yaşı, retry, offline çatışma, stok tutarsızlığı. Yüksek cardinality etiketlerden kaçınılır.
- CI: lint, typecheck, unit, `check:all` bekçileri, entegrasyon (PgBouncer arkasında), `test:ac`, migration ileri/geri, bağımlılık/sır taraması, Playwright duman testi. CI tanımı korunan dosyadır.
- Deploy: connection drain, worker zarif kapanış, job yeniden teslimatı güvenli; eski/yeni sürüm geçişte şemayla uyumlu.
- Olay müdahalesi: sorumlu, alarm kanalı, stok yazmasını güvenle durdurma anahtarı (kill switch), müşteri iletişim şablonu.
<!-- END FILE -->

<!-- FILE: docs/spec/15-engineering.md -->
# 15 — Mühendislik Standartları

## Kod
- TypeScript strict; `any` yalnızca gerekçeli. Domain kodu framework'ten bağımsız (`packages/domain`); giriş katmanı ince.
- UI domain servisini atlayarak stok/yetki tablosu yazamaz; web, worker, import aynı komutları kullanır.
- Commit: Conventional Commits; PR açıklaması T-xxx + AC listesi.

## API sözleşmesi
Hata kodları: `VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `TENANT_SUSPENDED`, `TENANT_CLOSING`, `COUNT_LOCK_ROW_MISSING`, `ENTITLEMENT_REQUIRED`, `NOT_FOUND`, `VERSION_CONFLICT`, `IDEMPOTENCY_MISMATCH`, `INSUFFICIENT_STOCK`, `TRACKING_VIOLATION`, `LOCATION_LOCKED`, `REVERSAL_BLOCKED`, `PERIOD_CLOSED`, `RATE_LIMITED`. Cursor pagination, boyut sınırları, sürümleme politikası dokümante.

## Test stratejisi
| Katman | Araç | Zorunlu olduğu yer |
|---|---|---|
| Unit | Vitest | Domain kuralları |
| Özellik tabanlı | fast-check | Defter = bakiye, dönüşüm, ters kayıt toplamları |
| Entegrasyon | Testcontainers PostgreSQL, `wms_app` rolü | RLS, concurrency, idempotency, migration |
| E2E | Playwright (masaüstü + mobil viewport) | Kritik akışlar |
| Yük | k6 | Faz 4P kapısı (AC-24) |
Lint/unit geçmesi AC testlerinin yerini tutmaz.

## DB sözleşmesi
`(tenant_id, code)` benzersiz; `(tenant_id, id)` benzersiz + bileşik FK; NOT NULL/CHECK; `numeric` miktar; belge `version` sütunu (optimistic concurrency); append-only tablolarda `created_xid xid8` (I-16); kalıcı işlem kimliği; sürümlü metadata; stok boyutu NULL-safe benzersiz. İndeksler tenant önekli ve sorgu şekline göre. Tenant silme kontrolsüz `ON DELETE CASCADE` zincirine bırakılmaz.

Örnek RLS (politika örneği, doğrulanmış migration değil):
```sql
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items FORCE ROW LEVEL SECURITY;
CREATE POLICY items_tenant_scope ON items FOR ALL TO wms_app
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
```
Akış: `BEGIN` → `SELECT set_config('app.current_tenant_id', $1, true)` → aynı bağlantıda sorgular → `COMMIT/ROLLBACK`. `$1` doğrulanmış üyelikten. ORM havuzu üzerinde entegrasyon testiyle kanıtlanır (AC-05).
<!-- END FILE -->

<!-- FILE: docs/spec/16-stock-effects.md -->
# 16 — Operasyonların Sayısal Stok Etkisi (normatif)

Bu dosya **beklenen değerlerin tek kaynağıdır.** Kod bu tablolarla çelişirse kod hatalıdır. Testler (AC-31, AC-07 ve tüm stok birim testleri) beklenen değerleri buradan alır. Tabloyu değiştirmek ADR + kullanıcı onayı ister.

## Temel kurallar
1. Defter satırı = bir boyutta işaretli miktar (`+` giriş, `−` çıkış). Bakiye = o boyuttaki defter satırlarının toplamı.
2. **Sipariş ve rezervasyon defter satırı üretmez**, fiziksel bakiyeyi değiştirmez.
3. **Lokasyon veya durum değişimi** = aynı miktarda bir `−` ve bir `+` satırı; depo toplam fiziksel miktarı değişmez.
4. **Fiziksel miktarı yalnızca** kabul, sevk, iade, sayım farkı, kayıp/fire, üretim giriş/sarf ve ters kayıt değiştirir.
5. **Kullanılabilir** = Σ fiziksel (`AVAILABLE`, lokasyon türü `STORAGE`/`STAGING`, `pick_blocked = false`) − Σ aktif rezervasyon.
6. **İade sipariş açık miktarını yeniden açmaz.** Yeniden gönderim yeni sipariş/satır ister.
7. Rezervasyon iptali fiziksel stoğu hareket ettirmez; mal sevk alanındaysa geri yerleştirme görevi oluşur.
8. Taşıma birimi (koli/palet) hareketi, içindeki her boyut için bir `−`/`+` çiftidir; taşıma biriminin kendisi stok değildir, toplam fiziksel değişmez. Koli açma = ilgili miktar için `handling_unit_id` dolu boyuttan boş boyuta `−`/`+` çifti.
9. **"Ürün bulunamadı"** defteri değiştirmez: toplama bulunan miktarla kesinleşir, eksik kısmın rezervasyonu serbest kalır, lokasyon `pick_blocked` olur ve sayım görevi açılır; fark yalnızca sayım onayıyla defterleşir. Yeniden tahsis `pick_blocked` lokasyonları kullanmaz; uygun stok yoksa sipariş satırı rezervesiz açık kalır.

## Senaryo A — Pilot akışı (AC-31'in beklenen değerleri)
Tek ürün X, depo D1. Lokasyonlar: `KABUL` (RECEIVING), `R-01` (STORAGE), `SEVK` (STAGING). Takip modu `NONE`. Tenant politikası: kabulde kalite kontrol **açık**. Sipariş S1: 4 adet.

Bakiye sütunları `lokasyon·durum` boyutlarıdır (KAR = QUARANTINE, KUL = AVAILABLE).

| # | İşlem | Defter satırları | KABUL·KAR | KABUL·KUL | R-01·KUL | SEVK·KUL | Fiziksel | Rezerve | Kullanılabilir | S1 istenen / sevk / açık |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | Başlangıç | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |
| 1 | Mal kabul 10 | +10 KABUL·KAR | 10 | 0 | 0 | 0 | 10 | 0 | 0 | — |
| 2 | Kalite onayı 10 | −10 KABUL·KAR, +10 KABUL·KUL | 0 | 10 | 0 | 0 | 10 | 0 | 0 ¹ | — |
| 3 | Yerleştirme 10 → R-01 | −10 KABUL·KUL, +10 R-01·KUL | 0 | 0 | 10 | 0 | 10 | 0 | 10 | — |
| 4 | Sipariş S1 oluşur (4) | — | 0 | 0 | 10 | 0 | 10 | 0 | 10 | 4 / 0 / 4 |
| 5 | Rezervasyon 4 (R-01·KUL'a) | — ² | 0 | 0 | 10 | 0 | 10 | 4 | 6 | 4 / 0 / 4 |
| 6 | Toplama 4 → SEVK | −4 R-01·KUL, +4 SEVK·KUL; rezervasyon 4 SEVK·KUL'a taşınır | 0 | 0 | 6 | 4 | 10 | 4 | 6 | 4 / 0 / 4 |
| 7 | Kısmi sevk 3 | −3 SEVK·KUL; rezervasyondan 3 tüketilir | 0 | 0 | 6 | 1 | 7 | 1 | 6 | 4 / 3 / 1 |
| 8 | Müşteri iadesi 1 (S1 sevkine bağlı) | +1 KABUL·KAR | 1 | 0 | 6 | 1 | 8 | 1 | 6 | 4 / 3 / 1 ³ |
| 9 | S1 kalan 1 iptal | — ; rezervasyon 1 serbest; geri yerleştirme görevi oluşur | 1 | 0 | 6 | 1 | 8 | 0 | 7 | 4 / 3 / 0 (iptal 1) |
| 10 | Geri yerleştirme SEVK → R-01 | −1 SEVK·KUL, +1 R-01·KUL | 1 | 0 | 7 | 0 | 8 | 0 | 7 | — |
| 11 | Sayım R-01: sistem 7, sayılan 6, fark onayı | −1 R-01·KUL (neden: SAYIM) | 1 | 0 | 6 | 0 | 7 | 0 | 6 | — |

¹ Kabul alanı sevke uygun değildir (`RECEIVING`). ² Rezervasyon tablosuna satır yazılır, defter değişmez. ³ İade açık miktarı değiştirmez; S1 satırında `iade = 1` ayrıca tutulur.

**Kontrol:** Fiziksel son = 10 (kabul) − 3 (sevk) + 1 (iade) − 1 (sayım) = **7**. Tüm defter satırlarının toplamı = 7. Açık rezervasyon = 0.

**Varyantlar:**
- Kalite kontrol **kapalıysa** adım 1 doğrudan `+10 KABUL·KUL` olur, adım 2 yoktur.
- Kabulde 1 adet hasarlıysa: `+9 KABUL·KAR`, `+1 KABUL·DAMAGED`; hasarlı stok hiçbir zaman kullanılabilir sayılmaz.
- Takip modu `LOT` ise her sütun lot ile ayrışır (`R-01·KUL·L1`); rezervasyon belirli lota yapılır; FEFO önerisi en erken SKT'li uygun lottur.
- Toplama sırasında "ürün bulunamadı": kural 9 uygulanır. Tam sayısal örnek Senaryo D adım 7'dedir.

## Senaryo D — Tam pilot akışı (AC-40'ın beklenen değerleri)
Senaryo A çekirdek doğrulamadır (tek ürün, tek sipariş). Senaryo D, pilot tanımındaki akışın tamamını içerir: kısmi ve hasarlı kabul, iki ürün, üç sipariş, "ürün bulunamadı", kısmi sevk, iade, iki lokasyonda sayım. Takip modu `NONE`, kalite kontrol açık. Lokasyonlar: `KABUL`, `R-01` (X), `R-02` (Y), `SEVK`.

Girdiler: Beklenen teslim G1 = X 20, Y 10. Gelen = X 18 (2 eksik), Y 10 (1 hasarlı). Siparişler: S1 = X 5 · S2 = X 6, Y 3 · S3 = Y 4. Saha gerçeği (sistem bilmiyor): R-02'ye yerleştirilen 9 Y'nin 3'ü yanlış yere konmuş, R-02'de fiilen 6 var.

| # | İşlem | Defter satırları |
|---|---|---|
| 1 | Mal kabul G1 | X: +18 KABUL·KAR · Y: +9 KABUL·KAR, +1 KABUL·DMG |
| 2 | Kalite onayı | X: −18 KABUL·KAR, +18 KABUL·KUL · Y: −9 KABUL·KAR, +9 KABUL·KUL |
| 3 | Yerleştirme | X: −18 KABUL·KUL, +18 R-01 · Y: −9 KABUL·KUL, +9 R-02 |
| 4 | S1, S2, S3 oluşur | — |
| 5 | Rezervasyon: S1 X5, S2 X6+Y3, S3 Y4 | — |
| 6 | Toplama S1+S2: X 11, Y 3 → SEVK | X: −11 R-01, +11 SEVK · Y: −3 R-02, +3 SEVK |
| 7 | Toplama S3: Y 4 istenir, 3 bulunur, 1 "bulunamadı" | Y: −3 R-02, +3 SEVK; S3 rezervasyonunun 1'i serbest; R-02 `pick_blocked` + sayım görevi; yeniden tahsis: uygun Y yok |
| 8 | Sevk: S1 X5 tam · S2 X6 tam + Y 2 kısmi · S3 Y3 | X: −11 SEVK · Y: −5 SEVK |
| 9 | Müşteri iadesi: S1'den X 1 | X: +1 KABUL·KAR |
| 10 | Kilitli sayım R-01 ve R-02; fark onayı | X R-01: sistem 7, sayılan 7 → satır yok · Y R-02: sistem 3, sayılan 0 → −3 R-02 (SAYIM); kilitler ve `pick_blocked` kalkar |

**Ürün X — her adım sonrası**
| # | KABUL·KAR | KABUL·KUL | R-01 | SEVK | Fiziksel | Rezerve | Kullanılabilir |
|---|---|---|---|---|---|---|---|
| 1 | 18 | 0 | 0 | 0 | 18 | 0 | 0 |
| 2 | 0 | 18 | 0 | 0 | 18 | 0 | 0 |
| 3 | 0 | 0 | 18 | 0 | 18 | 0 | 18 |
| 4 | 0 | 0 | 18 | 0 | 18 | 0 | 18 |
| 5 | 0 | 0 | 18 | 0 | 18 | 11 | 7 |
| 6–7 | 0 | 0 | 7 | 11 | 18 | 11 | 7 |
| 8 | 0 | 0 | 7 | 0 | 7 | 0 | 7 |
| 9–10 | 1 | 0 | 7 | 0 | 8 | 0 | 7 |

**Ürün Y — her adım sonrası**
| # | KABUL·KAR | KABUL·KUL | KABUL·DMG | R-02 | SEVK | Fiziksel | Rezerve | Kullanılabilir |
|---|---|---|---|---|---|---|---|---|
| 1 | 9 | 0 | 1 | 0 | 0 | 10 | 0 | 0 |
| 2 | 0 | 9 | 1 | 0 | 0 | 10 | 0 | 0 |
| 3–4 | 0 | 0 | 1 | 9 | 0 | 10 | 0 | 9 |
| 5 | 0 | 0 | 1 | 9 | 0 | 10 | 7 | 2 |
| 6 | 0 | 0 | 1 | 6 | 3 | 10 | 7 | 2 |
| 7 | 0 | 0 | 1 | 3 | 6 | 10 | 6 | 0 ¹ |
| 8–9 | 0 | 0 | 1 | 3 | 1 | 5 | 1 | 0 ¹ |
| 10 | 0 | 0 | 1 | 0 | 1 | 2 | 1 | 0 |

¹ R-02 `pick_blocked` olduğu için kullanılabilire dahil değil.

**Belge ve sipariş son durumu**
| Belge | Satır | İstenen | Kabul/Sevk | Açık | Not |
|---|---|---|---|---|---|
| G1 | X | 20 | 18 | 2 | Tedarikçiden beklenen eksik |
| G1 | Y | 10 | 10 | 0 | 1 hasarlı (KABUL·DMG) |
| S1 | X | 5 | 5 | 0 | 1 iade (açık miktarı değiştirmez) |
| S2 | X | 6 | 6 | 0 | |
| S2 | Y | 3 | 2 | 1 | 1 rezerve, SEVK'te bekliyor |
| S3 | Y | 4 | 3 | 1 | Rezervesiz; stok yok (sayım farkı sonrası) |

**Kontrol:** X fiziksel = 18 − 11 + 1 = **8**. Y fiziksel = 10 − 5 − 3 = **2** (1 hasarlı + 1 SEVK'te rezerve). Her iki ürün için defter satırları toplamı fiziksel ile birebir; açık rezervasyon toplamı 1.

## Senaryo B — Transfer (AC-07'nin beklenen değerleri)
D1/R-01'de 20 adet. Transit lokasyonu `TR-D1-D2` (TRANSIT). Hedef D2.

| # | İşlem | Defter satırları | D1 R-01·KUL | TR-D1-D2·KUL | D2 KABUL·KUL | Tenant toplam fiziksel | D1 kullanılabilir | D2 kullanılabilir |
|---|---|---|---|---|---|---|---|---|
| 0 | Başlangıç | — | 20 | 0 | 0 | 20 | 20 | 0 |
| 1 | Transfer çıkışı 20 | −20 D1 R-01·KUL, +20 TR·KUL | 0 | 20 | 0 | 20 | 0 | 0 |
| 2 | Hedef kabul 15 | −15 TR·KUL, +15 D2 KABUL·KUL | 0 | 5 | 15 | 20 | 0 | 0 ¹ |
| 3 | Kalan 5 için kayıp onayı | −5 TR·KUL (neden: TRANSFER_KAYIP) | 0 | 0 | 15 | 15 | 0 | 0 ¹ |

¹ D2'de yerleştirme yapılana kadar kullanılabilir 0'dır. Adım 3 onaylanmadan transit 5 açık kalır ve raporda görünür; kayıp yalnızca yetkili onayla defterleşir.

## Senaryo C — Ters kayıt (AC-06)
Giriş belgesi G1: +100 R-01·KUL. Ardından 60 adet sevk edildi; R-01·KUL = 40.
| İstek | Sonuç |
|---|---|
| G1'in tamamını ters çevir (−100) | Ret `REVERSAL_BLOCKED`: kalan 40 < 100. Hiçbir satır yazılmaz |
| G1'den 40 ters çevir | −40 R-01·KUL; G1 ters kayıt durumu `PARTIAL` (40/100); R-01·KUL = 0 |
| Aynı 40'lık ters kayıt isteği tekrar (aynı idempotency anahtarı) | İlk sonuç döner; ikinci −40 yazılmaz |
<!-- END FILE -->

<!-- FILE: docs/ACCEPTANCE.md -->
# Kabul Senaryoları (qa-verifier bu ID'lerle test yazar)
| ID | Senaryo | Beklenen | Faz |
|---|---|---|---|
| AC-01 | 10 stoktan eşzamanlı iki 7 çıkış | En fazla biri kesinleşir; negatif yok | 2 |
| AC-02 | Aynı stok isteği / worker olayı tekrar | Tek etki, önceki sonuç | 2 |
| AC-03 | Commit sonrası yanıt kaybı | Yeniden istek çift hareket üretmez | 2 |
| AC-04 | Tenant A, B'nin ID'sini kullanır | API, DB, dosya, cache, export reddeder | 1 |
| AC-05 | Gerçek pooler arkasında, pool 1–2'ye düşürülmüş, 2 tenant × 50 eşzamanlı istek | Her yanıt yalnızca kendi tenant'ı; transaction dışı sorgu veri döndürmez; prepared statement hatası yok | 0 |
| AC-06 | 100 girişin 60'ı sevkliyken tam geri alma | `REVERSAL_BLOCKED` veya kontrollü düzeltme | 2 |
| AC-07 | Transfer: kaynakta 20 çıkış, hedefte 15 kabul, 5 kayıp onayı | `16-stock-effects` Senaryo B'nin her satırı birebir | 3B |
| AC-08 | Karantina, hasarlı veya kabul alanındaki stoku rezerve etme / sevk etme | Ret; kullanılabilir miktara dahil edilmez | 3A |
| AC-09 | Seri takipli ürün iki lokasyona | `TRACKING_VIOLATION` | 2 |
| AC-10 | Aynı siparişin toplama ve sevki | Müşteri çıkışı bir kez | 3A |
| AC-11 | İki offline cihaz aynı son ürün | Bir kesinleşme; diğeri çatışma + düzeltme görevi | 5 |
| AC-12 | Çıkarılmış kullanıcının offline kuyruğu | Güncel yetkiyle ret | 5 |
| AC-13 | Sayımdaki lokasyona hareket | `LOCATION_LOCKED` | 3A |
| AC-39 | Sayım kilidi yaşam döngüsü: yeni lokasyon oluşturulur; süren bir stok işlemi varken sayım başlatılır; kilitliyken (a) normal hareket, (b) başka oturumun fark fişi, (c) onaysız oturumun fark fişi, (d) kilitli + kilitsiz lokasyona birlikte yazan fark fişi, (e) doğru oturumun onaylı fark fişi gönderilir; ayrıca iptal | Yeni lokasyonun kilit satırı vardır; sayım başlangıcı süren işlemin bitmesini bekler; (a)–(d) reddedilir; (e) fark satırlarını işler ve kilitleri aynı transaction'da `IDLE` yapar; iptal fark uygulamadan kilidi açar | 3A |
| AC-14 | Metadata değişti, eski fiş açılır | Eski sürümle doğru görüntü + ters kayıt | 6 |
| AC-15 | Aynı stok import'u tekrar | İkinci açılış yok | 4P |
| AC-16 | Kuyruk işleyicileri (worker) durdurulur veya çöker, bu sırada stok işlemleri sürer; sonra işleyiciler döner | Stok kesinleştirmeleri etkilenmez; bekleyen işlerin her biri tek etkiyle işlenir; kayıp iş yok | 2 |
| AC-17 | Yedekten restore | Defter/bakiye, dosya, silme işaretleri doğru | 4P |
| AC-18 | Çıkarılan kullanıcının eski token'ı ile yazma | Ret | 1 |
| AC-19 | Paket limiti eşzamanlı isteklerle aşılmaya çalışılır | Limit korunur | 4S |
| AC-20 | Min-maks altına düşen ürün | Uyarı üretilir, stok değişmez | 3A |
| AC-21 | Tutarlılık işi defter–bakiye farkı bulur | Alarm; defter değişmez | 2 |
| AC-22 | Aynı iş/olay tüketiciye iki kez teslim edilir (işleyici yan etkiden sonra, onaydan önce çöker) | Etki tek kez; ikinci teslim `processed_events` ile sessizce onaylanır; haricî çağrıda aynı idempotency anahtarı gider | 2 |
| AC-23 | Aynı kuyruğu iki işleyici örneği eşzamanlı tüketir | Hiçbir iş iki örnekte birlikte yürütülmez; toplam işlenen = toplam kuyruğa giren | 2 |
| AC-24 | 1M hareket satırlı tenant için takeout, aynı anda stok işlemleri sürerken | Stok işlemlerinin p95'i hedef içinde; uzun transaction yok; export bakiyeleri kesim noktasındaki defterle birebir | 4P |
| AC-25 | Paket düşürülmüş / ödemesi gecikmiş / askıdaki tenant | Tüm veriyi görüntüler, CSV/JSON indirir ve takeout alır; yeni kayıt limit dahilinde engellenir | 4S |
| AC-26 | Kesilen takeout işi yeniden başlar | Son tamamlanan parçadan devam eder; yinelenen veya eksik satır yok (manifest sayıları tutar) | 4P |
| AC-27 | Aynı 5 ürünü ters sıralı satırlarla içeren 20 sipariş eşzamanlı sevk/rezerve edilir | Deadlock nedeniyle başarısız işlem yok (yeniden deneme sonrası); toplam stok ve defter tutarlı | 2 |
| AC-28 | Tenant modülünde `withTenant` dışında global istemci kullanılır | Lint CI'da hata verir; çalışma anında sorgu satır döndürmez / yazma reddedilir | 0 |
| AC-29 | Seq 100'ü alan işlem bekletilir, 101 commit olur, takeout başlar, ardından 100 commit olur | Export 100'ü içermez, 101'i içerir; export bakiyeleri kesitteki defterle birebir; aynı kesitle yeniden çalıştırma `deterministic: true` dosyalarda aynı checksum'ı verir (değişebilir tablo dosyaları bu garantinin dışındadır) | 4P |
| AC-30 | Kapatılan tenant'ta: normal kullanıcı girişi, yönetici girişi, yazma isteği, import işi, takeout işi, 31. gün | Normal kullanıcı reddedilir; yönetici salt okunur portala girer; yazma `TENANT_CLOSING`; import çalışmaz; takeout tamamlanır; 31. günde silme işi başlar ve takeout dosyaları silinir | 4P |
| AC-31 | Çekirdek akış (`16-stock-effects` Senaryo A, adım 0–11) | Her adımdan sonra tüm sütunlar tablodakiyle birebir; son durumda fiziksel 7, defter toplamı 7, açık rezervasyon 0 | 3A |
| AC-40 | Tam pilot akışı (`16-stock-effects` Senaryo D, adım 1–10): kısmi/hasarlı kabul, 2 ürün, 3 sipariş, "ürün bulunamadı", kısmi sevk, iade, kilitli sayım | Her adımdan sonra X ve Y tablolarındaki tüm sütunlar ve belge/sipariş son durumu birebir; X fiziksel 8, Y fiziksel 2, açık rezervasyon 1 | 3A |
| AC-35 | Pilot cihazında, işletim sistemi klavyesi Türkçe iken HID/DataWedge keystroke ile `i`, `ı`, `-`, `/`, `.` içeren barkodlar ve GS1 (FNC1 ayraçlı) barkod taranır | Okunan değer birebir; GS1 alanları doğru ayrışır; elle klavyeden yazılan değer "tarama" sayılmaz | 3A |
| AC-43 | Onay kaynağı testi: ajan kimliği korunan dosyayı değiştirir ve kartına `protected: true` ekler; ajan kimliği PR'ı onaylamaya çalışır; insan onayından sonra yeni commit eklenir; CODEOWNERS dosyası PR dalında değiştirilir | Hepsinde `check:protected` kırmızı: beyan onay sayılmaz, ajan onayı geçersiz, eski onay düşer, CODEOWNERS `main`'den okunur. Yalnızca son commit'e verilmiş insan onayıyla yeşil | 0 |
| AC-44 | Karantina testi: (a) kayıtsız `@quarantine`, (b) insan onaysız yeni karantina, (c) kapı AC testinin karantinası, (d) bitiş tarihi geçmiş karantina, (e) tüm koşulları sağlayan karantina | (a)–(d) CI kırmızı; (e) yeşil, test yine koşar ve sonucu raporlanır | 0 |
| AC-37 | Bekçi testi: kart dışı dosya değiştirilir; bir test `skip` edilir; bir `@AC` testi silinir; bir assertion `expect(true)` yapılır; lint kuralı gevşetilir | Her biri ayrı ayrı CI'ı kırmızıya çevirir; mesaj nedeni ve dosyayı gösterir | 0 |
| AC-36 | Senkron eşiğin üstünde satırlı belge işlenir; aynı istek iki kez gönderilir; işleme sırasında worker yeniden başlar | Belge worker'da tek transaction'da `POSTED` olur; tek stok etkisi; arayüz "işleniyor" → sonuç gösterir; sert sınırın üstü reddedilir | 2 |

## Koşullu kabul senaryoları
Koşulu ADR veya `docs/PILOT.md` ile karşılanırsa ilgili fazın kapısına eklenir; karşılanmazsa `pnpm test:ac` bunları atlar ve raporda koşulu yazar. Koşul `docs/ACCEPTANCE.conditions.json` dosyasında makine tarafından okunur biçimde tutulur.
| ID | Koşul | Senaryo | Beklenen | Faz |
|---|---|---|---|---|
| AC-32 | ADR-005 ayrı broker seçtiyse (BullMQ/RabbitMQ) | Relay olayı broker'a ekledikten sonra, `PUBLISHED` commit'inden önce çöker | Olay ikinci kez eklenir ama tüketici etkisi tek kez (AC-22 ile); iş kimliği = olay kimliği | 2 |
| AC-33 | ADR-005 ayrı broker seçtiyse | Broker verisi tamamen kaybolur | Stok etkilenmez; `PUBLISHED` ama işlenmemiş olaylar `processed_events` karşılaştırmasıyla yeniden kuyruğa alınır; çift etki yok | 2 |
| AC-38 | Pilot koli cevabı (b) veya (c) | 12 adetlik koli okutularak R-01'den SEVK'e taşınır; koli açılıp 5 adet çıkarılır; palet içindeki koli sorgulanır | Taşıma birimi hareketinde içerik başına −/+ defter çifti, toplam fiziksel değişmez; açılan kolide 7 kalır; hiçbir stok iki taşıma biriminde birden görünmez | 3A (koşul yoksa 3B) |
| AC-34 | Pilotta en az bir ürün grubu `LOT` veya `LOT_AND_SERIAL` | Lot seçerek kabul, rezervasyon, toplama, sevk; lotsuz satır gönderme; başka lotu okutma | Her hareket doğru lot boyutuna yazılır; lotsuz satır ve yanlış lot reddedilir; lot bazında hareket ekstresi doğrudur | 3A (koşul yoksa 3B) |
| AC-41 | Pilotta SKT kullanımı = var (yalnızca lotlu ürünlerde geçerli) | SKT'si geçmiş lotu rezerve etme; minimum kalan raf ömrünün altındaki lotu sevk etme; FEFO önerisi; öneriyi gerekçesiz değiştirme | Ret / ret / en erken SKT'li uygun lot önerilir / gerekçe ve yetki olmadan değiştirilemez | 3A (koşul yoksa 3B) |
| AC-42 | Pilotta en az bir ürün grubu `SERIAL` veya `LOT_AND_SERIAL` | Birim başına seri tarama; aynı seriyi iki kez okutma; `LOT_AND_SERIAL`'da seriyi yanlış lotla okutma | Her birim taranmadan satır kesinleşmez; tekrar ve lot–seri uyuşmazlığı reddedilir (AC-09'daki tekillik kısıtına ek olarak) | 3A (koşul yoksa 3B) |
<!-- END FILE -->

<!-- FILE: docs/PHASES.md -->
# Fazlar ve Üretim Kapıları
Her faz başında `architect` fazı kartlara böler; faz sonunda Supervisor kapı raporu verir ve kullanıcı onayı olmadan sonraki faza geçilmez.

| Faz | Kapsam | Çıkış kapısı |
|---|---|---|
**Kapı kuralı:** Bir fazın kapısı, `docs/ACCEPTANCE.md`'de "Faz" sütunu o faz olan **tüm** AC'lerin geçmesidir; aşağıdaki tablo bu listeyi tekrarlar ama tek doğru kaynak ACCEPTANCE'tır. Testler `@AC-xx` etiketiyle yazılır; `pnpm test:ac --phase N` o fazın tüm AC'lerini koşturur ve etiketli testi olmayan AC'yi **hata** sayar (eksik test = kapı kapalı). Koşullu AC'ler (`ACCEPTANCE.md` §Koşullu) koşulları sağlanıyorsa kapıya otomatik eklenir. Bir AC'yi başka faza taşımak veya koşullu yapmak §Onay kaynağı kuralıyla insan onayı ister. Kabul senaryoları sağlayıcıdan bağımsız sonuç tanımlar; belirli bir altyapıya (Redis, broker, ORM) bağlı senaryolar yalnızca koşullu bölümde yer alır.

| Faz | Kapsam | Çıkış kapısı (AC'ler + ek kanıt) |
|---|---|---|
| 0 — Kararlar & iskelet | Karar listesi → ADR'ler; monorepo, docker compose, `pnpm verify`, `pnpm test:ac`, CI, STACK/MAP; gerçek pooler arkasında RLS spike'ı (T-005); pilot tanımı | **AC-05, AC-28, AC-37, AC-43, AC-44**; ADR-001…004, ADR-011 ve ADR-012 kabul; branch protection + CODEOWNERS + ajan kimliği kurulu; `check:pilot` yeşil (PILOT.md tam; varsayımlar `A-xx` ile); bekçiler CI'da zorunlu; PgBouncer arkasında CI yeşil |
| 1 — Güvenli temel | Auth, üyelik/RBAC, RLS, audit, işlemsel e-posta, temel izleme/yedek, landing + onboarding + pilot sektör şablonu | **AC-04, AC-18**; AC-05 CI'da yeşil kalmaya devam; restore kanıtı |
| 2 — Kartlar & stok çekirdeği | Ürün/birim/barkod, depo/lokasyon, pilotun gerektirdiği lot/seri, defter, bakiye, rezervasyon, idempotency, ters kayıt, kuyruk/outbox, kilit sözleşmesi, tutarlılık işi | **AC-01, 02, 03, 06, 09, 16, 21, 22, 23, 27, 36** + koşullu AC-32, 33 (ADR-005 broker seçtiyse) |
| 3A — Pilot akışı | Yalnızca §Pilot tanımındaki akış: kabul → yerleştirme → rezervasyon → toplama görevlendirmesi → sevk → iade → kilitli sayım; pilotun barkod/etiket ihtiyacı; pilot raporları ve min-maks uyarısı | **AC-08, 10, 13, 20, 31, 35, 39, 40** + koşullu AC-34 (lot), AC-41 (SKT/FEFO), AC-42 (seri), AC-38 (izlenen koli/palet) — koşullar `PILOT.md`'den; PILOT.md'de doğrulanmamış `A-xx` yok; pilot depo verisiyle prova |
| 4P — Pilot hazırlığı | Kart/stok açılış import'u, export/takeout, kapatma süreci, yedek/restore, alarm, güvenlik ve yük testi, hukuki metinler (aydınlatma, DPA, kullanım koşulları) | **AC-15, 17, 24, 26, 29, 30**; pilot kontrol listesi; geri dönüş prosedürü |
| ▶ **Pilot** | Seçilen tek müşteri, tek depo, §Pilot başarı ölçütleri | Ölçütler karşılandı; kullanıcı onayı |
| 3B — Kalan depo akışları | Transfer ve transit, üretim giriş/sarf, çoklu depo, ek raporlar | **AC-07** + yeni kartların AC'leri |
| 4S — Ticari SaaS | Abonelik, ödeme sağlayıcısı, e-Arşiv, paket limitleri, self-servis kayıt açılışı | **AC-19, 25** + faturalama AC'leri |
| 5 — Mobil/offline | Cihaz matrisi, IndexedDB kuyruğu, senkron, çatışma | **AC-11, 12**; ağ kesintisi/ortak cihaz testleri |
| 6 — Genişletme | Metadata/no-code, Logo adapter, e-İrsaliye adapter, public API, gelişmiş etiket | **AC-14**; entegrasyon retry ve yetki testleri |
| 7 — AI & ölçek | BYOK/yönetilen AI, tahmin, kapasite artırımı, B2B | AI onay/veri sınırları; ölçülen kapasite/maliyet |

Pilot ücretsiz ve sözleşmeli yürütülür; bu yüzden abonelik/ödeme (4S) pilotun önünde değildir. Offline vaat edilen pilotta Faz 5 pilot öncesine alınır. Pilot sektör lot/seri/FEFO gerektiriyorsa bunlar Faz 2–3A'dan çıkarılmaz. AI ve kapsamlı no-code güvenli stok çekirdeğinin önüne alınmaz.

## Pilot tanımı (Faz 0'da kullanıcıyla doldurulur; `docs/PILOT.md` olarak kaydedilir)
| Alan | Değer |
|---|---|
| Sektör (tek) | … (ör. hırdavat: lot yok; gıda: lot + SKT + FEFO) |
| Müşteri | … |
| Depo sayısı | 1 |
| Lokasyon sayısı / derinlik | … / … (ör. Bölge→Raf→Göz) |
| Aktif SKU sayısı | … |
| Takip modu | NONE / LOT / SERIAL / LOT_AND_SERIAL — ürün grubu bazında |
| SKT kullanımı ve kuralı | Yok / var: FEFO mu, minimum kalan raf ömrü (gün) kaç — SKT yalnızca lotlu ürünlerde tutulur |
| Koli/palet nasıl kullanılıyor | (a) Yalnızca birim: "1 koli = 12 adet" dönüşümü, koli açılıp adetle çalışılıyor · (b) **İzlenen taşıma birimi**: koli/palet kendi barkoduyla (LPN/SSCC) okutuluyor, içeriği birlikte hareket ediyor · (c) Karışık |
| Kısmi koli açma | Var / yok |
| Stok sahibi | Tek sahip / müşteri adına (3PL, konsinye) |
| Mevcut sistem ve geçiş verisi | … (Excel / Logo / el defteri; açılış stoku nasıl alınacak) |
| Günlük ortalama kabul / sipariş / sevk satırı | … / … / … |
| Kullanıcı sayısı ve rolleri | … (ör. 1 yönetici, 1 depo şefi, 3 toplayıcı) |
| Cihazlar | … (ör. 2 Android + kamera; 1 USB okuyucu) |
| Etiket yazıcısı | … |
| Offline gerekli mi | Evet / Hayır |
| ERP bağlantısı | Pilot kapsamında yok (Excel import/export) |

**Tamlık kuralı:** `docs/PILOT.md` içinde `…`, "TBD" veya seçilmemiş seçenek kalamaz; `pnpm check:pilot` bunu denetler ve Faz 0 kapısının parçasıdır. Pilot müşteri henüz belli değilse tablo **varsayımsal profil** olarak doldurulur; her varsayım `A-xx` ile işaretlenir ve en geç Faz 3A başlamadan gerçek müşteriyle doğrulanır. Doğrulanmamış `A-xx` varken Faz 3A kapısı kapanmaz. `check:pilot` tutarlılığı da denetler: SKT "var" ise en az bir ürün grubu `LOT`/`LOT_AND_SERIAL` olmalı (SKT lotta tutulur); koli cevabı (b)/(c) ise ADR-011 kabul edilmiş olmalı. Koşullu AC'lerin (AC-34, 38, 41, 42) koşulları bu dosyadan okunur.

**Modele etkisi (Faz 2 kart setini belirler):**
| Pilot cevabı | Faz 2 (model) | Faz 3A (saha akışı) |
|---|---|---|
| Takip modu NONE | Lot/seri tabloları ve boyut alanları yine kurulur (takip modu kararı) | Lot/seri ekranı yok |
| LOT + SKT | Aynı model | Lot seçimi, FEFO, SKT uyarısı, raf ömrü kuralı (AC-34) |
| SERIAL | Aynı model | Birim başına tarama (AC-34) |
| Koli (a) birim | Birim dönüşümü + paket barkodu (mevcut model) | Koli barkodu okutunca adet otomatik |
| Koli (b) izlenen taşıma birimi | Taşıma birimi boyutu (`handling_unit_id`) — ADR-011 varsayılanıyla zaten kurulu | Koli/palet taşıma, koli açma, içerik sorgulama (AC-38) |
| Müşteri adına stok | `inventory_owner` boyutu zaten var | Sahip bazlı rapor ve sevk kısıtı |

**Pilot senaryosu (AC-31'in temeli):** Tedarikçi teslimatının kabulü (kısmi + 1 hasarlı satır) → karantinadan çıkış → yerleştirme → 3 müşteri siparişinin rezervasyonu → toplama görevlendirmesi ve toplama (1 "ürün bulunamadı" durumu) → sevk (1 kısmi sevk) → 1 müşteri iadesi (karantinaya) → seçili lokasyonlarda kilitli sayım ve fark onayı → stok durumu ve hareket raporu.

**Pilot başarı ölçütleri (sayı bazlı):**
| Ölçüt | Hedef |
|---|---|
| Kesintisiz pilot süresi | ≥ 20 iş günü |
| Sistemde işlenen hareket satırı | ≥ pilot tanımındaki günlük hacim × 20 |
| Defter–bakiye tutarsızlığı (tutarlılık işi) | 0 |
| Tenant izolasyon ihlali | 0 |
| Kaybolan veya çift işlenen stok işlemi | 0 |
| Pilot sonu sayımında açıklanamayan fark | ≤ … adet (müşteriyle birlikte belirlenir) |
| Personelin destek almadan tamamlayamadığı görev | Haftada ≤ … adet, pilot boyunca azalan |
| Kritik (stok/veri) hata | 0 açık; çözülen her biri için regresyon testi |
| Stok kesinleştirme gecikmesi | p95 ≤ 1 sn |

## Faz 0 karar listesi (Supervisor tek mesajda, önerili seçeneklerle sorar)
**Kritik yol — ilk dördü cevaplanmadan T-002 (iskelet) ve T-005 (pooler spike) başlamaz:**
1. ADR-001 Uygulama mimarisi: Next.js monolit + ayrı worker (öneri) / NestJS API + Next.js ön yüz (önceki v1.3)
2. ADR-002 Kod/DB adlandırma dili: İngilizce kod/DB + Türkçe UI + `GLOSSARY.md` eşlemesi (öneri) / Türkçe-first (önceki tercih; v1.3 kataloğu çevrilmez)
3. ADR-004 PostgreSQL barındırma ve pooler (Neon / Supabase / Azure / kendi kurulum) — T-005 bu sağlayıcı üzerinde koşar
4. ADR-003 ORM: Drizzle (öneri; gerekçe `docs/STACK.md`) / Prisma

**Faz 0 içinde, iskelet sürerken:**
5. ADR-005 Kuyruk: Postgres kuyruğu (Faz 0–4 önerisi) / BullMQ+Redis / RabbitMQ
6. ADR-006 Dosya deposu: S3 uyumlu / Azure Blob
7. ADR-007 Barındırma bölgesi ve KVKK aktarım yaklaşımı
8. ADR-008 Ödeme sağlayıcısı ve e-Arşiv entegratörü
9. **Pilot tanımı** (tek sektör, müşteri, depo profili; yukarıdaki tablo) — Faz 2 kart setini bu belirler; paket birimleri ve miktar hassasiyeti
10. Onay/görev ayrımı; negatif stok istisnası; boşluksuz fiş numarası gerekip gerekmediği; kabulde kalite kontrol varsayılanı; senkron belge satır eşiği ve sert sınır; rezervasyon modeli (sert tahsis varsayılanı — ADR-009); tarama yolu (keystroke / Enterprise Browser / yerel kabuk — ADR-010)
11. İlk yük profili sayıları; offline azami süre ve izinli işlemler
12. ADR-012 Ajan GitHub kimliği ve onay kaynağı (ayrı kimlik önerilir; kullanıcının GitHub ayarı gerekir)
13. ADR-011 Taşıma birimi (koli/palet LPN) — model Faz 2'de, akış pilota göre (öneri)
14. Logo ürün/sürümü; maliyet otoritesi; saklama sınıfları; ilk hedef el terminali ve etiket yazıcısı
Cevaplanmayan maddeler `A-xx` varsayımıyla ilerler; stok veya güvenlik etkili olanlar netleşmeden ilgili özellik üretime açılmaz.
<!-- END FILE -->

---

## Ek — Bu sürümde düzeltilen / eklenen başlıca konular

- **Ajan işletim sistemi:** tek Supervisor, 8 rollü alt ajan, model kademelendirme, görev kartı + rapor şablonu, STATE/JOURNAL/MAP ile oturumlar arası hafıza, ID tabanlı referans, durma/eskalasyon kuralları, master dosyanın betikle bölünmesi.
- **Mimari düzeltme:** Worker ayrı süreç olduğu için domain kodu paylaşımlı pakete alındı (pnpm monorepo); aksi halde stok kuralları iki yerde kopyalanırdı.
- **Önceki belgelerde düşen veya hiç olmayanlar:** min-maks/yeniden sipariş uyarıları, raporlama modülü, bildirimler, yazdırma/etiket, arama, TanStack Virtual, DataWedge, churn anketi, test araç zinciri, yerel geliştirme ortamı, public API, e-İrsaliye ve e-Arşiv entegrasyonu, KVKK yurt dışı aktarım/DPA/VERBİS/İYS, TR ödeme sağlayıcısı, BullMQ için `noeviction` ve kalıcı Redis bağlantısı, deterministik kilit sırası, kill switch.
- **Önceki kararlarla çelişkiler** (NestJS/RabbitMQ/Azure Blob ve Türkçe-first adlandırma) sessizce ezilmedi; Faz 0 ADR maddesi yapıldı.
