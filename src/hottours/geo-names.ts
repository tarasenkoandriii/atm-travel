// Map common tour-destination country names (ru/uk/en) to ISO alpha-2 for flags.
const NAME_CC: Record<string, string> = {
  'туреччина': 'TR', 'турция': 'TR', 'turkey': 'TR', 'türkiye': 'TR',
  'єгипет': 'EG', 'египет': 'EG', 'egypt': 'EG',
  'греція': 'GR', 'греция': 'GR', 'greece': 'GR',
  'кіпр': 'CY', 'кипр': 'CY', 'cyprus': 'CY',
  'іспанія': 'ES', 'испания': 'ES', 'spain': 'ES',
  'італія': 'IT', 'италия': 'IT', 'italy': 'IT',
  'португалія': 'PT', 'португалия': 'PT', 'portugal': 'PT',
  'таїланд': 'TH', 'таиланд': 'TH', 'thailand': 'TH',
  'оае': 'AE', 'эмираты': 'AE', 'емірати': 'AE', 'uae': 'AE', 'united arab emirates': 'AE',
  'мальдіви': 'MV', 'мальдивы': 'MV', 'maldives': 'MV',
  'домінікана': 'DO', 'доминикана': 'DO', 'dominican republic': 'DO',
  'мексика': 'MX', 'mexico': 'MX',
  'чорногорія': 'ME', 'черногория': 'ME', 'montenegro': 'ME',
  'хорватія': 'HR', 'хорватия': 'HR', 'croatia': 'HR',
  'болгарія': 'BG', 'болгария': 'BG', 'bulgaria': 'BG',
  'туніс': 'TN', 'тунис': 'TN', 'tunisia': 'TN',
  'марокко': 'MA', 'morocco': 'MA',
  'шрі-ланка': 'LK', 'шри-ланка': 'LK', 'sri lanka': 'LK',
  'індонезія': 'ID', 'индонезия': 'ID', 'бали': 'ID', 'балі': 'ID', 'indonesia': 'ID', 'bali': 'ID',
  'в’єтнам': 'VN', 'вьетнам': 'VN', 'vietnam': 'VN',
  'грузія': 'GE', 'грузия': 'GE', 'georgia': 'GE',
  'йорданія': 'JO', 'иордания': 'JO', 'jordan': 'JO',
  'ізраїль': 'IL', 'израиль': 'IL', 'israel': 'IL',
  'куба': 'CU', 'cuba': 'CU',
  'занзібар': 'TZ', 'занзибар': 'TZ', 'танзанія': 'TZ', 'танзания': 'TZ', 'tanzania': 'TZ', 'zanzibar': 'TZ',
};

export function countryCodeOf(name: string): string | null {
  if (!name) return null;
  return NAME_CC[name.trim().toLowerCase()] || null;
}
