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
