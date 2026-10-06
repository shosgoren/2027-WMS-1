import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityList, Banner, Button, ConfirmDialog, EmptyState, TaskCard, TextField } from "./index.ts";
import { handleDialogCancel, handleDialogClose } from "./controls.tsx";

const icon = <span>i</span>;

describe("TaskCard", () => {
  it("kilitli kart bağlantı değildir, aria-disabled taşır ve gerekçeyi okutur", () => {
    const html = renderToStaticMarkup(
      <TaskCard icon={icon} title="Depodan mal çıkacak" href="/cikis" locked={{ reason: "Bu iş için yetkin yok." }} />,
    );
    expect(html).not.toContain("<a");
    expect(html).not.toContain("href=");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('data-state="locked"');
    expect(html).toContain("Bu iş için yetkin yok.");
  });

  it("'yakında' kartı kilitliden farklı durum ve metin taşır, bağlantı değildir", () => {
    const locked = renderToStaticMarkup(
      <TaskCard icon={icon} title="X" href="/x" locked={{ reason: "Yetki yok" }} />,
    );
    const soon = renderToStaticMarkup(
      <TaskCard icon={icon} title="X" href="/x" soon={{ label: "Yakında" }} description="Açıklama" />,
    );
    expect(soon).toContain('data-state="soon"');
    expect(soon).not.toContain('data-state="locked"');
    expect(soon).toContain("Yakında");
    expect(soon).not.toContain("Yetki yok");
    expect(soon).not.toContain("<a");
    expect(locked).not.toContain("Yakında");
    expect(soon).not.toBe(locked);
  });

  it("etkin kart href ile bağlantıdır; ≥48 px (min-h-12) sınıfı vardır", () => {
    const html = renderToStaticMarkup(<TaskCard icon={icon} title="Mal geldi" href="/giris" />);
    expect(html).toContain('<a href="/giris"');
    expect(html).toContain("min-h-12");
    expect(html).toContain('data-state="active"');
  });
});

describe("ConfirmDialog", () => {
  const noop = () => {};
  it("kapalıyken onay düğmesini render etmez", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog open={false} title="T" description="D" confirmLabel="Sil" cancelLabel="Vazgeç" onConfirm={noop} onCancel={noop} />,
    );
    expect(html).toBe("");
    expect(html).not.toContain("Sil");
  });

  it("açıkken başlık, etki açıklaması ve düğmeleri ARIA ile verir", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog open title="Silinsin mi?" description="Etki metni" confirmLabel="Sil" cancelLabel="Vazgeç" onConfirm={noop} onCancel={noop} />,
    );
    expect(html).toContain("<dialog");
    expect(html).toContain("aria-labelledby");
    expect(html).toContain("aria-describedby");
    expect(html).toContain("Sil");
    expect(html).toContain("Vazgeç");
  });
});

describe("TextField / Button", () => {
  it("hata mesajı neden + sonraki eylem verir ve aria-describedby ile bağlanır", () => {
    const html = renderToStaticMarkup(
      <TextField label="Miktar" error={{ reason: "Miktar sıfır olamaz.", action: "1 veya daha büyük gir." }} />,
    );
    expect(html).toContain("Miktar sıfır olamaz. 1 veya daha büyük gir.");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toMatch(/aria-describedby="([^"]+)"/);
    const id = /aria-describedby="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(html).toContain(`id="${id}"`);
  });

  it("yükleniyor düğmesi devre dışı ve aria-busy", () => {
    const html = renderToStaticMarkup(<Button loading>Kaydet</Button>);
    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("min-h-12");
  });
});

describe("Banner / EmptyState / ActivityList", () => {
  it("hata bandı alert, bilgi bandı status rolü alır", () => {
    expect(renderToStaticMarkup(<Banner kind="error">Hata</Banner>)).toContain('role="alert"');
    expect(renderToStaticMarkup(<Banner kind="info">Demo ortamı</Banner>)).toContain('role="status"');
  });

  it("boş durum başlık ve eylemi gösterir; etkinlik listesi saat + metin satırı üretir", () => {
    expect(renderToStaticMarkup(<EmptyState title="Kayıt yok" action={<Button>Ekle</Button>} />)).toContain("Ekle");
    const html = renderToStaticMarkup(
      <ActivityList title="Bugün yaptıkların" emptyText="Yok" items={[{ id: "1", time: "09:42", text: "4 koli girdi." }]} />,
    );
    expect(html).toContain("09:42");
    expect(html).toContain("4 koli girdi.");
    expect(renderToStaticMarkup(<ActivityList title="B" emptyText="Henüz yok" items={[]} />)).toContain("Henüz yok");
  });
});

describe("TaskCard güvenli bağlantı (T-110b)", () => {
  const unsafe = [
    "https://evil.example", "//evil", "javascript:alert(1)", "data:text/html,x", "/\\evil", "/a\nb", "",
    "/\t/evil", "/..//evil", "/.//evil", "/%2e%2e//evil", "/a/../b",
    "/%2F%2Fevil", "/%2f/evil", "/a%5Cevil", "/a%5cevil", "/%252F%252Fevil", "/a%25",
  ];
  it.each(unsafe)("güvensiz href %j bağlantı üretmez", (href) => {
    // Çalışma anı savunması: tip kısıtını aşan değer kartı bağlantısız bırakır.
    const html = renderToStaticMarkup(<TaskCard icon={icon} title="K" href={href as `/${string}`} />);
    expect(html).not.toContain("<a");
    expect(html).not.toContain("href=");
    expect(html).toContain('data-state="invalid-link"');
    expect(html).not.toContain('data-state="active"');
    expect(html).not.toContain("focus-visible");
  });

  it("href verilmeyen kart etkin kalır", () => {
    expect(renderToStaticMarkup(<TaskCard icon={icon} title="K" />)).toContain('data-state="active"');
  });

  it.each(["/files/a..b", "/x?next=../y", "/x?next=%2Fa", "/a%20b"])("aynı origin'de kalan yol %j bağlantı olur", (href) => {
    expect(renderToStaticMarkup(<TaskCard icon={icon} title="K" href={href as `/${string}`} />)).toContain("<a href=");
  });

  it("uygulama içi yol bağlantı olur", () => {
    expect(renderToStaticMarkup(<TaskCard icon={icon} title="K" href="/tasks/count" />)).toContain(
      '<a href="/tasks/count"',
    );
  });
});

describe("ConfirmDialog close olayı (T-110c)", () => {
  it("yükleniyorken kapanırsa onCancel çağrılmaz, dialog yeniden açılır", () => {
    const el = { open: false, showModal: vi.fn() };
    const onCancel = vi.fn();
    handleDialogClose(el, true, onCancel);
    expect(el.showModal).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("yüklenmiyorken kapanırsa onCancel bir kez çağrılır, yeniden açılmaz", () => {
    const el = { open: false, showModal: vi.fn() };
    const onCancel = vi.fn();
    handleDialogClose(el, false, onCancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(el.showModal).not.toHaveBeenCalled();
  });

  it("hâlâ açık ya da DOM'dan ayrılmış dialog için bir şey yapılmaz", () => {
    const onCancel = vi.fn();
    const open = { open: true, showModal: vi.fn() };
    const gone = { open: false, isConnected: false, showModal: vi.fn() };
    handleDialogClose(open, true, onCancel);
    handleDialogClose(gone, true, onCancel);
    expect(open.showModal).not.toHaveBeenCalled();
    expect(gone.showModal).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("ConfirmDialog Esc (T-110b)", () => {
  it("yükleniyorken cancel engellenir ve onCancel çağrılmaz", () => {
    const ev = { preventDefault: vi.fn() };
    const onCancel = vi.fn();
    handleDialogCancel(ev, true, onCancel);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("yüklenmiyorken cancel engellenir ve onCancel bir kez çağrılır", () => {
    const ev = { preventDefault: vi.fn() };
    const onCancel = vi.fn();
    handleDialogCancel(ev, false, onCancel);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("yükleniyorken iptal düğmesi devre dışıdır", () => {
    const noop = () => undefined;
    const html = renderToStaticMarkup(
      <ConfirmDialog open loading title="T" description="D" confirmLabel="Sil" cancelLabel="Vazgeç" onConfirm={noop} onCancel={noop} />,
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Vazgeç/s);
  });
});
