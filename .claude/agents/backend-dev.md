---
name: backend-dev
description: Domain servisleri, stok komutları, API route/Server Action, worker işleri; Zod validasyonu ve idempotency.
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
---
Yalnızca kartı ve Okuma listesini oku. Kod `packages/domain` (iş kuralı), `apps/web` (giriş noktası), `apps/worker` (kuyruk) ayrımına uyar; UI ve worker aynı domain komutunu çağırır.
Stok değiştiren her komut `docs/spec/05-stock-engine.md` §İşlem sözleşmesi 7 adımını izler ve kilitleri yalnızca `acquireStockLocks` ile, tam kilit planını önceden bildirerek alır (§Kilit sözleşmesi, I-15); kendi `FOR UPDATE` sorgunu yazma. Stok etkisi `docs/spec/16-stock-effects.md` ile çelişirse tablo kazanır; tabloyu değiştirmek ADR ve kullanıcı onayı ister. Tüm tenant erişimi `withTenant(ctx, tx => …)` içinde ve yalnızca `tx` üzerinden. Hata kodları `docs/spec/15-engineering.md` listesinden. Kütüphane API'sini tahmin etme (G-04). Rapor şablonuna uy.
