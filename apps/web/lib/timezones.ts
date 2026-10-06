// Ayarlar saat dilimi seçenekleri (T-122): sabit liste. Serbest metin YOK: Intl'in kabul edip PostgreSQL'in tanımadığı bir ad
// kaydedilirse ana ekran o tenant için INTERNAL verir (gün sınırı `AT TIME ZONE` ile hesaplanır). Yalnızca kanonik IANA adları
// (hem Intl hem PostgreSQL tzdata'da bulunan, takma ad olmayan); sunucu eylemi yalnızca bu listeden kabul eder.
export const TIME_ZONES = [
  "Europe/Istanbul",
  "UTC",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Brussels",
  "Europe/Rome",
  "Europe/Vienna",
  "Europe/Zurich",
  "Europe/Warsaw",
  "Europe/Prague",
  "Europe/Athens",
  "Europe/Helsinki",
  "Europe/Bucharest",
  "Europe/Sofia",
  "Europe/Moscow",
  "Asia/Nicosia",
  "Asia/Dubai",
  "Asia/Baghdad",
  "Asia/Tehran",
  "Asia/Riyadh",
  "Asia/Baku",
  "Asia/Tbilisi",
  "Asia/Tashkent",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Pacific/Auckland",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Lagos",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Mexico_City",
  "America/Sao_Paulo",
] as const;

export type TimeZoneName = (typeof TIME_ZONES)[number];

export function isListedTimeZone(value: string): value is TimeZoneName {
  return (TIME_ZONES as readonly string[]).includes(value);
}
