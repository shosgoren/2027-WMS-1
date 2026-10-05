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
