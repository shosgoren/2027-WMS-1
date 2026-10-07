// T-279: boş tenant (depo/ürün/lokasyon yok) üzerinde Ürünler ekranı boş durumu: S-01 kurulum satırı + B-03 öğreten adımlar + geometri.
// Demo tenant T-223'ten beri dolu açıldığı için bu ölçütler yalnızca global-setup'ın kurduğu fikstür tenant'ta üretilebilir (bkz. support/empty-tenant.ts).
// Ölçümler mobile-shell.spec.ts ile AYNI işlevdir (support/items-screen.ts, `empty: true`). Uzak koşuda dışlanır (playwright.config.ts testIgnore).
import { test } from "@playwright/test";
import { itemsScreenChecks } from "./support/items-screen.ts";
import { loginEmptyTenant, localClient } from "./support/empty-tenant.ts";

// Parola/TOTP kodu hiçbir Playwright çağrısına parametre olmaz (support/empty-tenant.ts: exposeFunction; G-09) → adım başlıkları/rapor temiz.
// Trace KAPALI: trace DOM anlık görüntüsü input değerini (`__playwright_value_`, parola alanı dahil) ve ağ kaydı giriş isteği gövdesini
// saklar; başarısız testte parola trace.zip'e (CI artifact) düşerdi (T-279 SR @70003ef). Hata kanıtı: ekran görüntüsü + hata bağlamı.
test.use({ ...localClient("198.51.100.11"), trace: "off" });

test("boş kiracı: ürünler ekranı boş durumu (S-01, B-03, B-02, I-01..I-05, B-04, B-05)", async ({ page }) => {
  const t = await loginEmptyTenant(page);
  await itemsScreenChecks(page, { slug: t.slug, empty: true });
});
