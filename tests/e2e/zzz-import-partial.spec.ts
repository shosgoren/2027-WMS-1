// T-289: "yarım kaldı" senaryosu — YALNIZ YEREL yığın. Test-yalnız DB tetikleyicisi `psql` ile yerel veritabanına kurulur (üretim koduna kanca yok), bu yüzden
// uzak hedefte (E2E_BASE_URL, staging) çalışmaz: `playwright.config.ts` bu dosyayı uzak koşudan dışlar (atlama değil; bu koşuda yerel veritabanı kavramı yoktur).
// Demo tenant'a kendi benzersiz önekli ürünlerini ve stokunu yazar; iş bitince tetikleyici/tablo kaldırılır.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { localClient } from "./support/empty-tenant.ts";
import { DESKTOP_SIZES, OUT, PHONE_SIZES, PRODUCT_HEADER, STOCK_HEADER, captureState, csv, loginAdmin, type Metrics } from "./support/import-screen.ts";

/** Yerel veritabanında SQL çalıştırır (`psql`; bağlantı dizgisi argv'de değil ortam değişkeninden okunur). Lint: `pg` sürücüsü e2e'de yasak. */
function runSql(script: string): void {
  if (!process.env.DATABASE_URL_DIRECT) throw new Error("e2e: DATABASE_URL_DIRECT yok (kısmi başarısızlık senaryosu yerel yığın ister)");
  execFileSync("sh", ["-c", 'psql "$DATABASE_URL_DIRECT" -X -q -v ON_ERROR_STOP=1'], { input: script, env: process.env, stdio: ["pipe", "ignore", "pipe"] });
}

/** TEST-YALNIZ hata enjeksiyonu (üretim kodunda kanca yok): yerel veritabanında demo tenant için belge ONAYI ya da belirli kodlu ürün EKLEMESİ başarısız olur; iş bitince tetikleyici ve tablo kaldırılır. */
async function withInjection<T>(what: string, fn: () => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9:_-]+$/.test(what)) throw new Error("e2e: enjeksiyon anahtarı geçersiz");
  const cleanup = `DROP TRIGGER IF EXISTS t289_inject_docs ON public.documents; DROP TRIGGER IF EXISTS t289_inject_items ON public.items;
    DROP FUNCTION IF EXISTS public.t289_inject_fn(); DROP TABLE IF EXISTS public.t289_inject;`;
  runSql(`${cleanup}
    CREATE TABLE public.t289_inject (tenant_id uuid NOT NULL, what text NOT NULL, PRIMARY KEY (tenant_id, what));
    CREATE FUNCTION public.t289_inject_fn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF TG_TABLE_NAME = 'documents' THEN
          IF OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' AND NEW.reason = 'import.opening_stock'
             AND EXISTS (SELECT 1 FROM public.t289_inject WHERE tenant_id = NEW.tenant_id AND what = 'approve') THEN
            RAISE EXCEPTION 't289 injected approve failure' USING ERRCODE = 'XX000';
          END IF;
        ELSIF TG_TABLE_NAME = 'items' THEN
          IF EXISTS (SELECT 1 FROM public.t289_inject WHERE tenant_id = NEW.tenant_id AND what = 'item:' || NEW.code) THEN
            RAISE EXCEPTION 't289 injected item failure' USING ERRCODE = 'XX000';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
    CREATE TRIGGER t289_inject_docs BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.t289_inject_fn();
    CREATE TRIGGER t289_inject_items BEFORE INSERT ON public.items FOR EACH ROW EXECUTE FUNCTION public.t289_inject_fn();
    INSERT INTO public.t289_inject (tenant_id, what) SELECT id, '${what}' FROM public.tenants WHERE slug = 'demo';`);
  try {
    return await fn();
  } finally {
    runSql(cleanup);
  }
}

// Demo girişi IP başına 10/10 dk sınırlıdır (auth signIn kuralı): bu dosya tüm paketin kovasını tüketmesin diye kendi istemci adresini kullanır (yalnız yerel vekil okur).
test.use({ ...localClient("198.51.100.41") });

test.describe("açılış verisi içe aktarma — yarım kalan (T-289, yerel)", () => {
  test("yarım kalan içe aktarma: hatalı/denenmedi sayıları, 20'den sonra 've N satır daha', yeniden yükleyince tamamlanır", async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    mkdirSync(OUT, { recursive: true });
    const project = testInfo.project.name;
    const sizes = project === "desktop" ? DESKTOP_SIZES : PHONE_SIZES;
    const p = `T289-${Date.now()}${project === "desktop" ? "D" : "M"}P`;
    const metrics: Record<string, Metrics> = {};
    const capture = (state: string, scrollTo?: string): Promise<void> => captureState(page, project, sizes, metrics, state, scrollTo);
    await loginAdmin(page);
    await page.goto("/t/demo/import");
    const upload = async (rows: string[]): Promise<void> => {
      await page.locator("#import-file").setInputFiles(csv(rows));
      await expect(page.getByTestId("import-summary")).toBeVisible();
    };

    // 1) Ürün: ikinci satırda ürün kaydı başarısız (test-yalnız tetikleyici) → 1 eklendi, 1 hatalı, 1 denenmedi.
    const products = [PRODUCT_HEADER, `${p}-1;Bir;;;;`, `${p}-2;İki;;;;`, `${p}-3;Üç;;;;`];
    await withInjection(`item:${p}-2`, async () => {
      await upload(products);
      await page.getByRole("button", { name: "İçe aktar" }).click();
      const result = page.getByTestId("import-result");
      await expect(result).toContainText("İşlem yarım kaldı. 1 satır eklendi.");
      await expect(page.getByTestId("import-step4-status")).toHaveText("Yarım kaldı");
      await expect(page.getByTestId("import-counts")).toContainText("1 satır hatalı");
      await expect(page.getByTestId("import-counts")).toContainText("1 satır denenmedi");
      await expect(page.getByTestId("import-failed-rows")).toContainText(`Satır 3 (${p}-2)`);
      await expect(page.getByTestId("import-result")).not.toContainText("INTERNAL");
      await capture("g-yarim-urun", "import-result");
    });
    // Sorun giderildi: aynı dosya yeniden yüklenir, kalanlar tamamlanır; tamamlanan satır "zaten vardı".
    await page.getByTestId("import-result").getByRole("button", { name: "Dosyayı yeniden seç" }).click();
    await upload(products);
    await page.getByRole("button", { name: "İçe aktar" }).click();
    await expect(page.getByTestId("import-result")).toContainText("Tamam. 2 ürün eklendi.");
    await expect(page.getByTestId("import-counts")).toContainText("1 satır zaten vardı");
    await capture("h-devam-urun", "import-result");

    // 2) Stok: 25 satırlık belge onayda başarısız → 25 hatalı satır, 20'si listelenir ve "ve 5 satır daha hatalı" yazar.
    await page.getByTestId("import-result").getByRole("button", { name: "Başka dosya yükle" }).click();
    const many = Array.from({ length: 25 }, (_, i) => `${p}-m${i}`);
    await upload([PRODUCT_HEADER, ...many.map((c) => `${c};Ürün;;;;`)]);
    await page.getByRole("button", { name: "İçe aktar" }).click();
    await expect(page.getByTestId("import-result")).toContainText("Tamam. 25 ürün eklendi.");
    await page.getByTestId("import-result").getByRole("button", { name: "Başka dosya yükle" }).click();
    const stockRows = [STOCK_HEADER, ...many.map((c) => `${c};A3-G04;5`)];
    await withInjection("approve", async () => {
      await upload(stockRows);
      await page.getByRole("button", { name: "İçe aktar" }).click();
      const result = page.getByTestId("import-result");
      await expect(result).toContainText("İşlem yarım kaldı.");
      await expect(page.getByTestId("import-counts")).toContainText("25 satır hatalı");
      await expect(page.getByTestId("import-failed-rows").locator("li")).toHaveCount(21); // 20 satır + "ve 5 satır daha hatalı."
      await expect(page.getByTestId("import-failed-more")).toHaveText("ve 5 satır daha hatalı.");
      await capture("i-yarim-stok", "import-result");
    });
    // Aynı dosya: yarım kalan belge sürdürülür, 25 satır eklenir.
    await page.getByTestId("import-result").getByRole("button", { name: "Dosyayı yeniden seç" }).click();
    await upload(stockRows);
    await page.getByRole("button", { name: "İçe aktar" }).click();
    await expect(page.getByTestId("import-result")).toContainText("Tamam. 25 stok satırı eklendi.");
    writeFileSync(path.join(OUT, `metrics-${project}-yarim.json`), JSON.stringify({ project, sizes, metrics }, null, 2));
  });

});
