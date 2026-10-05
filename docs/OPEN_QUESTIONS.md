# Açık Sorular ve Varsayımlar
Format: `Q-xx | soru | etkilenen T/I | durum` · `A-xx | varsayım | geçerlilik koşulu | doğrulayan Q`

## Sorular
Q-01 | Neon'da hangi bölge kullanılacak; güncel bölge listesinde TR bölgesi gerçekten yok mu? (Bölge ADR-007 KVKK yurt dışı aktarım kararına bağlı) | ADR-004, ADR-007, T-005, T-001b | açık
Q-02 | Neon pooler'ının türü ve sürümü nedir (PgBouncer ise hangi sürüm); sağlayıcı tarafı güncellemeler nasıl izlenecek (yeniden spike tetikleyicisi); CI'daki docker PgBouncer bununla davranış olarak eşdeğer mi? | ADR-004, T-005, I-02 | açık
Q-03 | Hangi PostgreSQL sürücüsü kullanılacak (postgres.js / node-postgres / Neon serverless) ve Drizzle ile hangi sürümler? | ADR-003, ADR-004, T-004, T-005 | açık
Q-04 | Neon pooler'ı protokol düzeyi prepared statement destekliyor mu; sürücüde prepared statement açık mı kapalı mı olacak? (Karar T-005 test sonucuna göre) | ADR-003, ADR-004, T-005 | açık
Q-05 | Neon'da hangi PostgreSQL ana sürümü kullanılacak? | ADR-004, T-004, T-005 | açık
Q-06 | Neon'da migration ve session'a bağlı worker işleri için doğrudan (pooler'sız) bağlantı nasıl sağlanacak; uygulama rolü ile migration rolü ayrımı nasıl kurulacak? | ADR-004, T-005, I-02 | açık

## Varsayımlar
A-01 | Neon pooler'ı transaction-mode PgBouncer'dır (kullanıcı kararı kaydı, 2026-10-05; doğrulanmadı) | T-005 Neon üzerinde pooler türü/sürümü belirlenene kadar | Q-02
