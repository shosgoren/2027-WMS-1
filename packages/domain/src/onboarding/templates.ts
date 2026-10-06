// Sürümlü sektör şablonları (T-121, A-47). Şablon kod içinde sürümlü tanımdır; tanım değişirse `version` artar ve
// eski sürüm tanımı silinmez/değiştirilmez (uygulanan sürüm `tenant_settings.sector_template_version`'dadır).
// Faz 1 yalnızca terminoloji, dil/saat dilimi ve adım listesini uygular. `unitsPreview` ve
// `locationTemplatePreview` ÖNİZLEMEDİR: Faz 2 `units.applied` / `locations.applied` adımları uygular (burada yok).
// Şablon izlenebilirlik kurallarını gevşetmez (08): takip modu yalnızca varsayılan öneridir.

/** Faz 1'de uygulanan adım anahtarları (A-47). Faz 2 `units.applied`, `locations.applied` ekler. */
export const PHASE1_STEP_KEYS = ["settings.applied", "terminology.applied"] as const;
export type OnboardingStepKey = (typeof PHASE1_STEP_KEYS)[number];

export interface UnitConversionPreview {
  readonly unit: string;
  /** Temel birime (ADET) çarpan; `null` = ürüne göre girilir (ör. paket içi adet değişir). */
  readonly toBaseFactor: number | null;
}

export interface SectorTemplate {
  readonly key: string;
  readonly version: number;
  /** Teknik anahtar → kullanıcıya gösterilen etiket (tenant terminolojisi; teknik kimliği değiştirmez). */
  readonly terminology: Readonly<Record<string, string>>;
  readonly locale: string;
  readonly timeZone: string;
  readonly steps: readonly OnboardingStepKey[];
  /** Faz 2'de uygulanır; Faz 1'de yalnızca gösterim. */
  readonly unitsPreview: { readonly baseUnit: string; readonly conversions: readonly UnitConversionPreview[] };
  /** Faz 2'de uygulanır; Faz 1'de yalnızca gösterim. */
  readonly locationTemplatePreview: { readonly levels: readonly string[]; readonly trackingMode: "NONE" };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const PACKAGING_SUPPLIES_V1: SectorTemplate = {
  key: "PACKAGING_SUPPLIES",
  version: 1,
  terminology: {
    "unit.carton": "Koli",
    "location.zone": "Bölge",
    "location.rack": "Raf",
    "location.bin": "Göz Kodu",
  },
  locale: "tr",
  timeZone: "Europe/Istanbul",
  steps: PHASE1_STEP_KEYS,
  unitsPreview: {
    baseUnit: "ADET",
    conversions: [
      { unit: "KOLI", toBaseFactor: null },
      { unit: "PAKET", toBaseFactor: null },
      { unit: "RULO", toBaseFactor: null },
    ],
  },
  locationTemplatePreview: { levels: ["ZONE", "RACK", "BIN"], trackingMode: "NONE" },
};

const GENERIC_V1: SectorTemplate = {
  key: "GENERIC",
  version: 1,
  terminology: {
    "unit.carton": "Koli",
    "location.zone": "Bölge",
    "location.rack": "Raf",
    "location.bin": "Lokasyon",
  },
  locale: "tr",
  timeZone: "Europe/Istanbul",
  steps: PHASE1_STEP_KEYS,
  unitsPreview: { baseUnit: "ADET", conversions: [] },
  locationTemplatePreview: { levels: ["ZONE", "RACK", "BIN"], trackingMode: "NONE" },
};

/** Tüm sürümler (değişmez). Yeni sürüm eklenir, eskisi korunur. */
export const SECTOR_TEMPLATES: readonly SectorTemplate[] = deepFreeze([PACKAGING_SUPPLIES_V1, GENERIC_V1]);

export const TEMPLATE_KEYS: readonly string[] = Object.freeze(SECTOR_TEMPLATES.map((t) => t.key));

/** Anahtarın en yüksek sürümü; bilinmeyen anahtar → `undefined`. */
export function getTemplate(key: string, version?: number): SectorTemplate | undefined {
  const matches = SECTOR_TEMPLATES.filter((t) => t.key === key && (version === undefined || t.version === version));
  return matches.reduce<SectorTemplate | undefined>((best, t) => (best === undefined || t.version > best.version ? t : best), undefined);
}
