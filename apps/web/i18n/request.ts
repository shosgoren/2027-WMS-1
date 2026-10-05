import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import en from "../messages/en.json";
import tr from "../messages/tr.json";

// Yönlendirmesiz kurulum (T-109): dil URL'de değil. Sıra: `locale` çerezi, `Accept-Language`, varsayılan `tr`.
// `en` yedek dildir. Saat dilimi tenant ayarı T-121'de bağlanana kadar Europe/Istanbul.
export const SUPPORTED_LOCALES = ["tr", "en"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];
const MESSAGES: Record<AppLocale, Record<string, unknown>> = { tr, en };
export const DEFAULT_LOCALE: AppLocale = "tr";
export const DEFAULT_TIME_ZONE = "Europe/Istanbul";

function isLocale(value: string | undefined): value is AppLocale {
  return SUPPORTED_LOCALES.some((l) => l === value);
}

function fromAcceptLanguage(header: string | null): AppLocale | undefined {
  if (header === null) return undefined;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q === undefined ? 1 : Number(q.slice(2));
      return { base: tag.trim().toLowerCase().split("-")[0], weight: Number.isNaN(weight) ? 0 : weight };
    })
    .sort((a, b) => b.weight - a.weight);
  return ranked.map((r) => r.base).find(isLocale);
}

export default getRequestConfig(async () => {
  const cookieLocale = (await cookies()).get("locale")?.value;
  const locale: AppLocale = isLocale(cookieLocale)
    ? cookieLocale
    : (fromAcceptLanguage((await headers()).get("accept-language")) ?? DEFAULT_LOCALE);
  return { locale, messages: MESSAGES[locale], timeZone: DEFAULT_TIME_ZONE };
});
