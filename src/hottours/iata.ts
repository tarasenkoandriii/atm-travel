// Minimal IATA(city) -> destination map for popular leisure directions, used to turn Travelpayouts
// Flight Data (v2/prices/latest) rows into readable tour rows. Unknown IATA -> the deal is skipped.
// cityId = Hotellook location id (for the Selections API); when absent it is resolved via lookup.json.
export const IATA: Record<string, { city: string; country: string; cc: string; cityId?: number }> = {
  AYT: { city: 'Анталья', country: 'Турция', cc: 'TR' },
  IST: { city: 'Стамбул', country: 'Турция', cc: 'TR' },
  DLM: { city: 'Даламан', country: 'Турция', cc: 'TR' },
  BJV: { city: 'Бодрум', country: 'Турция', cc: 'TR' },
  HRG: { city: 'Хургада', country: 'Египет', cc: 'EG' },
  SSH: { city: 'Шарм-эль-Шейх', country: 'Египет', cc: 'EG' },
  RMF: { city: 'Марса-Алам', country: 'Египет', cc: 'EG' },
  HER: { city: 'Ираклион', country: 'Греция', cc: 'GR' },
  RHO: { city: 'Родос', country: 'Греция', cc: 'GR' },
  CFU: { city: 'Корфу', country: 'Греция', cc: 'GR' },
  SKG: { city: 'Салоники', country: 'Греция', cc: 'GR' },
  LCA: { city: 'Ларнака', country: 'Кипр', cc: 'CY' },
  PFO: { city: 'Пафос', country: 'Кипр', cc: 'CY' },
  DXB: { city: 'Дубай', country: 'ОАЭ', cc: 'AE' },
  AUH: { city: 'Абу-Даби', country: 'ОАЭ', cc: 'AE' },
  HKT: { city: 'Пхукет', country: 'Таиланд', cc: 'TH' },
  USM: { city: 'Самуи', country: 'Таиланд', cc: 'TH' },
  BKK: { city: 'Бангкок', country: 'Таиланд', cc: 'TH' },
  DPS: { city: 'Бали', country: 'Индонезия', cc: 'ID' },
  MLE: { city: 'Мале', country: 'Мальдивы', cc: 'MV' },
  CMB: { city: 'Коломбо', country: 'Шри-Ланка', cc: 'LK' },
  PUJ: { city: 'Пунта-Кана', country: 'Доминикана', cc: 'DO' },
  CUN: { city: 'Канкун', country: 'Мексика', cc: 'MX' },
  BCN: { city: 'Барселона', country: 'Испания', cc: 'ES' },
  AGP: { city: 'Малага', country: 'Испания', cc: 'ES' },
  PMI: { city: 'Пальма-де-Майорка', country: 'Испания', cc: 'ES' },
  TFS: { city: 'Тенерифе', country: 'Испания', cc: 'ES' },
  NAP: { city: 'Неаполь', country: 'Италия', cc: 'IT' },
  CTA: { city: 'Катания', country: 'Италия', cc: 'IT' },
  FAO: { city: 'Фару', country: 'Португалия', cc: 'PT' },
  TIA: { city: 'Тирана', country: 'Албания', cc: 'AL' },
  TIV: { city: 'Тиват', country: 'Черногория', cc: 'ME' },
  VAR: { city: 'Варна', country: 'Болгария', cc: 'BG' },
  BOJ: { city: 'Бургас', country: 'Болгария', cc: 'BG' },
  TUN: { city: 'Тунис', country: 'Тунис', cc: 'TN' },
  DJE: { city: 'Джерба', country: 'Тунис', cc: 'TN' },
  ZNZ: { city: 'Занзибар', country: 'Танзания', cc: 'TZ' },
  TBS: { city: 'Тбилиси', country: 'Грузия', cc: 'GE' },
  BUS: { city: 'Батуми', country: 'Грузия', cc: 'GE' },
  // departure hubs (city only used for departureCity) — IEV/KBP kept for completeness, but Ukrainian
  // airspace has been closed since Feb 2022 (no commercial flights depart from Ukraine); the
  // practically useful origins for a Ukraine-facing site are the neighboring countries Ukrainians
  // actually travel to by land to fly onward from: Poland, Hungary, Romania.
  IEV: { city: 'Київ', country: 'Україна', cc: 'UA' },
  KBP: { city: 'Київ', country: 'Україна', cc: 'UA' },
  WAW: { city: 'Варшава', country: 'Польша', cc: 'PL' },
  KRK: { city: 'Краків', country: 'Польша', cc: 'PL' },
  RZE: { city: 'Жешув', country: 'Польша', cc: 'PL' },       // closest major airport to the Ukrainian border — heavily used
  BUD: { city: 'Будапешт', country: 'Венгрия', cc: 'HU' },
  DEB: { city: 'Дебрецен', country: 'Венгрия', cc: 'HU' },   // closer to western Ukraine than Budapest
  OTP: { city: 'Бухарест', country: 'Румыния', cc: 'RO' },
  IAS: { city: 'Яссы', country: 'Румыния', cc: 'RO' },       // closer to the Ukrainian border than Bucharest
  KIV: { city: 'Кишинёв', country: 'Молдова', cc: 'MD' },
  RIX: { city: 'Рига', country: 'Латвия', cc: 'LV' },
};
