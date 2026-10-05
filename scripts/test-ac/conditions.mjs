// `docs/ACCEPTANCE.conditions.json` doğrulayıcısı ve koşul değerlendirici (T-007).
// Dosya korunan dosyadır (PROTOCOL §Onay kaynağı). Şema katıdır: bilinmeyen alan, eksik
// alan, ACCEPTANCE.md ile uyuşmayan faz = hata. Kaynak (PILOT/FACT) eksikse koşul UNKNOWN.
import { readFileSync } from "node:fs";
import path from "node:path";
import { isPhase } from "./acceptance.mjs";
import { PILOT_PATH, pilotEnumFor, pilotRowsFor } from "../lib/pilot.mjs";

export const CONDITIONS_PATH = "docs/ACCEPTANCE.conditions.json";

/**
 * @typedef {import("./acceptance.mjs").AcceptanceCriterion} AcceptanceCriterion
 * @typedef {import("../lib/pilot.mjs").PilotRow} PilotRow
 * @typedef {string | number | boolean} Scalar
 * @typedef {{ source: "PILOT" | "FACT", key: string, anyOf: Scalar[], phase: string, fallbackPhase?: string }} Condition
 * @typedef {{
 *   currentGatePhase: string,
 *   passedGates: string[],
 *   facts: Record<string, Scalar>,
 *   factSources: Record<string, string>,
 *   conditions: Record<string, Condition>,
 * }} ConditionsFile
 * @typedef {{ status: "MET" | "UNMET" | "UNKNOWN", detail: string }} ConditionResult
 */

export class ConditionsError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(`${CONDITIONS_PATH}: ${message}`);
    this.name = "ConditionsError";
  }
}

const TOP_KEYS = ["$comment", "currentGatePhase", "passedGates", "facts", "factSources", "conditions"];
const COND_KEYS = ["source", "key", "anyOf", "phase", "fallbackPhase"];

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * @param {unknown} v
 * @returns {v is Scalar}
 */
function isScalar(v) {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * JSON metnini doğrular ve ACCEPTANCE.md ile çapraz denetler; `ConditionsError` atar.
 * @param {string} text
 * @param {AcceptanceCriterion[]} acs
 * @returns {ConditionsFile}
 */
export function parseConditions(text, acs) {
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new ConditionsError(`geçersiz JSON (${/** @type {Error} */ (e).message})`);
  }
  if (!isObject(data)) throw new ConditionsError("kök bir nesne olmalı");
  for (const k of Object.keys(data)) {
    if (!TOP_KEYS.includes(k)) throw new ConditionsError(`bilinmeyen alan "${k}"`);
  }
  const { currentGatePhase, passedGates, facts, factSources, conditions } = data;
  if (typeof currentGatePhase !== "string" || !isPhase(currentGatePhase)) {
    throw new ConditionsError(`currentGatePhase geçerli bir faz dizesi olmalı (bulunan: ${JSON.stringify(currentGatePhase)})`);
  }
  if (!Array.isArray(passedGates) || !passedGates.every((p) => typeof p === "string" && isPhase(p))) {
    throw new ConditionsError("passedGates geçerli faz dizelerinden oluşan bir dizi olmalı");
  }
  if (new Set(passedGates).size !== passedGates.length) throw new ConditionsError("passedGates yinelenen faz içeriyor");
  if (!isObject(facts) || !Object.values(facts).every(isScalar)) {
    throw new ConditionsError("facts, değerleri dize/sayı/mantıksal olan bir nesne olmalı");
  }
  if (!isObject(factSources)) throw new ConditionsError("factSources bir nesne olmalı");
  for (const k of Object.keys(facts)) {
    const src = factSources[k];
    if (typeof src !== "string" || src.trim() === "") throw new ConditionsError(`facts.${k} için factSources.${k} (kaynak) zorunlu`);
  }
  for (const k of Object.keys(factSources)) {
    if (!Object.hasOwn(facts, k)) throw new ConditionsError(`factSources.${k} için facts.${k} yok`);
  }
  if (!isObject(conditions)) throw new ConditionsError("conditions bir nesne olmalı");

  const byId = new Map(acs.map((a) => [a.id, a]));
  /** @type {Record<string, Condition>} */
  const parsed = {};
  for (const [id, raw] of Object.entries(conditions)) {
    const ac = byId.get(id);
    if (!ac) throw new ConditionsError(`conditions.${id}: ACCEPTANCE.md'de yok`);
    if (!ac.conditional) throw new ConditionsError(`conditions.${id}: ACCEPTANCE.md'de koşullu tabloda değil`);
    if (!isObject(raw)) throw new ConditionsError(`conditions.${id} bir nesne olmalı`);
    for (const k of Object.keys(raw)) {
      if (!COND_KEYS.includes(k)) throw new ConditionsError(`conditions.${id}: bilinmeyen alan "${k}"`);
    }
    const { source, key, anyOf, phase, fallbackPhase } = raw;
    if (source !== "PILOT" && source !== "FACT") throw new ConditionsError(`conditions.${id}.source "PILOT" veya "FACT" olmalı`);
    if (typeof key !== "string" || key === "") throw new ConditionsError(`conditions.${id}.key boş olamaz`);
    if (!Array.isArray(anyOf) || anyOf.length === 0 || !anyOf.every(isScalar)) {
      throw new ConditionsError(`conditions.${id}.anyOf boş olmayan bir değer dizisi olmalı`);
    }
    if (source === "PILOT") {
      const allowed = pilotEnumFor(key);
      if (!allowed) throw new ConditionsError(`conditions.${id}: PILOT anahtarı "${key}" için T-006 enum listesi yok`);
      for (const v of anyOf) {
        if (typeof v !== "string" || !allowed.includes(v)) {
          throw new ConditionsError(`conditions.${id}.anyOf: ${JSON.stringify(v)} "${key}" için geçerli değil (${allowed.join("|")})`);
        }
      }
    }
    if (phase !== ac.phase) throw new ConditionsError(`conditions.${id}.phase ${JSON.stringify(phase)} ≠ ACCEPTANCE.md "${ac.phase}"`);
    if (fallbackPhase !== ac.fallbackPhase) {
      throw new ConditionsError(`conditions.${id}.fallbackPhase ${JSON.stringify(fallbackPhase)} ≠ ACCEPTANCE.md ${JSON.stringify(ac.fallbackPhase)}`);
    }
    /** @type {Condition} */
    const cond = { source, key, anyOf, phase };
    if (typeof fallbackPhase === "string") cond.fallbackPhase = fallbackPhase;
    parsed[id] = cond;
  }
  for (const ac of acs) {
    if (ac.conditional && !Object.hasOwn(parsed, ac.id)) {
      throw new ConditionsError(`${ac.id} ACCEPTANCE.md'de koşullu ama conditions.${ac.id} tanımı yok`);
    }
  }
  return {
    currentGatePhase,
    passedGates: /** @type {string[]} */ (passedGates),
    facts: /** @type {Record<string, Scalar>} */ (facts),
    factSources: /** @type {Record<string, string>} */ (factSources),
    conditions: parsed,
  };
}

/**
 * @param {string} root
 * @param {AcceptanceCriterion[]} acs
 * @returns {ConditionsFile}
 */
export function loadConditions(root, acs) {
  let text;
  try {
    text = readFileSync(path.join(root, CONDITIONS_PATH), "utf8");
  } catch (e) {
    throw new ConditionsError(`okunamadı (${/** @type {NodeJS.ErrnoException} */ (e).code ?? "hata"})`);
  }
  return parseConditions(text, acs);
}

/**
 * Bir koşulu değerlendirir. Kaynak dosya/anahtar yoksa veya değer alan dışındaysa UNKNOWN.
 * @param {Condition} cond
 * @param {{ pilot: Map<string, PilotRow> | null, pilotError?: string | null, facts: Record<string, Scalar> }} sources
 *   `pilotError`: PILOT.md var ama ayrıştırılamadı (koşul UNKNOWN, ayrıntı bu mesaj).
 * @returns {ConditionResult}
 */
export function evaluateCondition(cond, { pilot, pilotError = null, facts }) {
  const want = cond.anyOf.map(String).join("|");
  if (cond.source === "FACT") {
    if (!Object.hasOwn(facts, cond.key)) return { status: "UNKNOWN", detail: `FACT "${cond.key}" ${CONDITIONS_PATH} facts içinde yok` };
    const value = facts[cond.key];
    const met = cond.anyOf.some((v) => v === value);
    return { status: met ? "MET" : "UNMET", detail: `FACT ${cond.key}=${String(value)} (gereken: ${want})` };
  }
  if (pilotError) return { status: "UNKNOWN", detail: `${PILOT_PATH} ayrıştırılamadı: ${pilotError}` };
  if (!pilot) return { status: "UNKNOWN", detail: `${PILOT_PATH} yok` };
  const rows = pilotRowsFor(pilot, cond.key);
  if (rows.length === 0) return { status: "UNKNOWN", detail: `${PILOT_PATH}'de "${cond.key}" anahtarı yok` };
  const allowed = pilotEnumFor(cond.key) ?? [];
  const invalid = rows.find((r) => !allowed.includes(r.value));
  if (invalid) {
    return { status: "UNKNOWN", detail: `${PILOT_PATH}:${invalid.line} ${invalid.key}="${invalid.value}" geçerli değil (${allowed.join("|")})` };
  }
  const seen = rows.map((r) => `${r.key}=${r.value}`).join(", ");
  const met = rows.some((r) => cond.anyOf.includes(r.value));
  return { status: met ? "MET" : "UNMET", detail: `PILOT ${seen} (gereken: ${cond.key} ∈ ${want})` };
}
