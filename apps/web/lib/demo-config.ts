// Demo girişi yapılandırması (T-122): landing ve `demo-actions.ts` AYNI kararı kullanır. "use server" DEĞİL: yalnızca
// sunucu bileşenleri/eylemleri içe aktarır, dışa açık uç nokta değildir. Parola yalnızca `ready` durumunda ve yalnızca eylemin içinde okunur.
import { DEMO_EMAIL_DOMAIN, loadDemoSeedConfig } from "@wms/domain/demo/seed";

export type DemoLoginConfig =
  | { readonly state: "disabled" | "misconfigured" }
  | { readonly state: "ready"; readonly password: string };

/**
 * TEK yapılandırma kararı (landing ve eylem aynısını kullanır): `disabled` = bayraklar kapalı (landing hiçbir şey çizmez);
 * `misconfigured` = bayraklar açık ama `DEMO_EMAIL_DOMAIN` ≠ T-123a sabiti (`example.invalid`) ya da `DEMO_PASSWORD` yok/geçersiz
 * (landing düğmeleri açıklamalı devre dışı gösterir, eylem FORBIDDEN döner); `ready` yalnızca hepsi doğruyken.
 */
export function loadDemoLoginConfig(env: NodeJS.ProcessEnv): DemoLoginConfig {
  if (env.WMS_ENV?.trim() !== "staging" || env.DEMO_MODE?.trim() !== "1") return { state: "disabled" };
  if (env.DEMO_EMAIL_DOMAIN?.trim().toLowerCase() !== DEMO_EMAIL_DOMAIN) return { state: "misconfigured" };
  const config = loadDemoSeedConfig(env);
  return config.enabled ? { state: "ready", password: config.password } : { state: "misconfigured" };
}

/** Landing için yalnızca durum döner (parola asla). */
export function demoLoginStatus(env: NodeJS.ProcessEnv = process.env): "disabled" | "misconfigured" | "ready" {
  return loadDemoLoginConfig(env).state;
}

