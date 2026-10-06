// Sürümlü sektör şablonları (T-121, A-47). Şablon kod içinde sürümlü tanımdır; tanım değişirse `version` artar ve
// eski sürüm tanımı silinmez/değiştirilmez (uygulanan sürüm `tenant_settings.sector_template_version`'dadır).
// v1 yalnızca terminoloji, dil/saat dilimi ve adım listesini uygular. `unitsPreview` ve `locationTemplatePreview` ÖNİZLEMEDİR;
// v2 (T-223) `setup` alanıyla `units.applied` / `locations.applied` adımlarını tanımlar (uygulama: `stock-setup.ts`).
// Şablon izlenebilirlik kurallarını gevşetmez (08): takip modu yalnızca varsayılan öneridir.

/** Faz 1'de uygulanan adım anahtarları (A-47). */
export const PHASE1_STEP_KEYS = ["settings.applied", "terminology.applied"] as const;
/** Faz 2 adımları (T-223, A-78): birim ve lokasyon şablonu; T-208/T-205 komutlarıyla uygulanır (`stock-setup.ts`). */
export const PHASE2_STEP_KEYS = ["units.applied", "locations.applied"] as const;
export type OnboardingStepKey = (typeof PHASE1_STEP_KEYS)[number] | (typeof PHASE2_STEP_KEYS)[number];

export type LocationKindKey = "RECEIVING" | "STORAGE" | "STAGING" | "TRANSIT";

/** Faz 2 adım içeriği (A-78); yalnızca v2 ve sonrası şablonlarda bulunur. */
export interface TemplateSetup {
  /** Birim kayıtları; ilki temel birimdir. Katsayı yoktur (A-32: katsayı ürün bazında). */
  readonly units: readonly { readonly code: string; readonly name: string }[];
  readonly warehouse: { readonly code: string; readonly name: string };
  /** Depo kökündeki lokasyonlar (A-78: KABUL/SEVK). */
  readonly locations: readonly { readonly code: string; readonly name: string; readonly kind: LocationKindKey }[];
}

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
  /** Faz 2 adımlarının içeriği (v2+). */
  readonly setup?: TemplateSetup;
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

const PHASE2_STEP_LIST: readonly OnboardingStepKey[] = [...PHASE1_STEP_KEYS, ...PHASE2_STEP_KEYS];

// A-78: Ana Depo (D1) + KABUL (RECEIVING) + SEVK (STAGING). Bölge>Raf>Göz ağacı kullanıcıya bırakılır (import 4P).
const SETUP_WAREHOUSE = { code: "D1", name: "Ana Depo" } as const;
const SETUP_LOCATIONS = [
  { code: "KABUL", name: "Kabul", kind: "RECEIVING" },
  { code: "SEVK", name: "Sevk", kind: "STAGING" },
] as const;

const PACKAGING_SUPPLIES_V2: SectorTemplate = {
  ...PACKAGING_SUPPLIES_V1,
  version: 2,
  steps: PHASE2_STEP_LIST,
  setup: {
    units: [
      { code: "ADET", name: "Adet" },
      { code: "KOLI", name: "Koli" },
      { code: "PAKET", name: "Paket" },
      { code: "RULO", name: "Rulo" },
    ],
    warehouse: SETUP_WAREHOUSE,
    locations: SETUP_LOCATIONS,
  },
};

// A-223-1: GENERIC v2 yalnızca temel birimi (ADET) ve aynı depo/kabul/sevk iskeletini uygular (dönüşüm birimleri sektöre özgüdür).
const GENERIC_V2: SectorTemplate = {
  ...GENERIC_V1,
  version: 2,
  steps: PHASE2_STEP_LIST,
  setup: { units: [{ code: "ADET", name: "Adet" }], warehouse: SETUP_WAREHOUSE, locations: SETUP_LOCATIONS },
};

/** Tüm sürümler (değişmez). Yeni sürüm eklenir, eskisi korunur. */
export const SECTOR_TEMPLATES: readonly SectorTemplate[] = deepFreeze([
  PACKAGING_SUPPLIES_V1,
  GENERIC_V1,
  PACKAGING_SUPPLIES_V2,
  GENERIC_V2,
]);

export const TEMPLATE_KEYS: readonly string[] = Object.freeze(SECTOR_TEMPLATES.map((t) => t.key));

/** Anahtarın en yüksek sürümü; bilinmeyen anahtar → `undefined`. */
export function getTemplate(key: string, version?: number): SectorTemplate | undefined {
  const matches = SECTOR_TEMPLATES.filter((t) => t.key === key && (version === undefined || t.version === version));
  return matches.reduce<SectorTemplate | undefined>((best, t) => (best === undefined || t.version > best.version ? t : best), undefined);
}
