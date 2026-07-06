// Blog rotation: 4 themes requested (guides / tips / reviews / destination stories) + a topic pool.
export interface BlogTheme { id: string; label: string; brief: string; }

export const THEMES: BlogTheme[] = [
  {
    id: 'guide', label: 'Тревел-гайд',
    brief:
      'Практический гид по направлению. H2-блоки: Когда ехать (сезоны/погода), Как добраться и передвигаться, Где остановиться (районы), Что посмотреть (в т.ч. нетуристическое), Локальная кухня, Бюджет ориентировочно, Безопасность (обобщённо). Конкретика важнее эпитетов. Тон: экспертный, по делу.',
  },
  {
    id: 'tips', label: 'Советы',
    brief:
      'Список из 10–14 конкретных практических советов для направления/типа поездки, каждый пункт — заголовок + 1–3 предложения пояснения: деньги и оплата, транспорт, связь/eSIM, что взять, локальный этикет, ошибки новичков, лайфхаки экономии. Тон: утилитарный, без воды.',
  },
  {
    id: 'review', label: 'Обзор',
    brief:
      'Честный обзор направления/сезона/типа отдыха: для кого подходит и для кого нет, плюсы и минусы списками, сравнение вариантов (например город vs побережье), итоговый вердикт с оговорками. Тон: аналитический, сбалансированный, без рекламы.',
  },
  {
    id: 'story', label: 'История о направлении',
    brief:
      'Сторителлинг о месте: атмосфера, детали, маленькие открытия и наблюдения, с вплетёнными полезными фактами (когда лучше приехать, что попробовать). Тон: тёплый, живой, человеческий. Запрещены клише («райский уголок», «незабываемые впечатления», «лазурное море»).',
  },
];

// Broad destination/subject pool. The generator prefers the least-covered topic to spread coverage.
export const TOPICS: string[] = [
  'Стамбул, Турция', 'Каппадокия, Турция', 'Анталья, Турция', 'Батуми, Грузия', 'Тбилиси, Грузия',
  'Ереван, Армения', 'Баку, Азербайджан', 'Дубай, ОАЭ', 'Абу-Даби, ОАЭ', 'Шарм-эль-Шейх, Египет',
  'Хургада, Египет', 'Каир, Египет', 'Пхукет, Таиланд', 'Бангкок, Таиланд', 'Бали, Индонезия',
  'Коломбо и Шри-Ланка', 'Гоа, Индия', 'Занзибар, Танзания', 'Марракеш, Марокко', 'Тунис',
  'Кипр (Ларнака и Пафос)', 'Крит, Греция', 'Родос, Греция', 'Афины, Греция', 'Барселона, Испания',
  'Мадрид, Испания', 'Тенерифе, Канары', 'Пальма-де-Майорка', 'Лиссабон, Португалия', 'Порту, Португалия',
  'Рим, Италия', 'Милан, Италия', 'Венеция, Италия', 'Неаполь и Амальфи', 'Париж, Франция',
  'Ницца и Лазурный берег', 'Вена, Австрия', 'Прага, Чехия', 'Будапешт, Венгрия', 'Краков, Польша',
  'Варшава, Польша', 'Амстердам, Нидерланды', 'Берлин, Германия', 'Мюнхен, Германия', 'Рейкьявик, Исландия',
  'Черногория (Будва и Котор)', 'Хорватия (Дубровник и Сплит)', 'Мальдивы', 'Сейшелы', 'Маврикий',
];

export const SYSTEM_PROMPT =
  'Ты — украинский travel-редактор, пишешь ОРИГИНАЛЬНЫЕ статьи для блога о путешествиях (locale ru/uk). ' +
  'ЖЁСТКИЕ ПРАВИЛА: (1) статья должна быть полезной и конкретной, без SEO-воды и клише; ' +
  '(2) визы, документы, правила въезда, цены и курсы, медицина — это YMYL: НЕ утверждай точную конкретику, пиши обобщённо и клади всё неуверенное в uncertain_facts; ' +
  '(3) не выдумывай факты, которых не знаешь наверняка; ' +
  '(4) тон и структуру бери СТРОГО из блока THEME; ' +
  '(5) объём тела 600–1000 слов; ' +
  '(6) без прямой рекламы и «бронируйте у нас» — CTA добавляется системой; ' +
  '(7) заголовок конкретный и не кликбейтный. ' +
  'Верни СТРОГО валидный JSON без markdown по схеме: ' +
  '{"h1":string,"meta_description":string(<=155),"sections":[{"heading":string,"body":string}],"categories":[string],"tags":[string],"sources":[{"title":string,"url":string}],"image_queries":[string],"image_alt_texts":[string],"uncertain_facts":[string]}. ' +
  'categories — 2–4 коротких тега НА ЯЗЫКЕ СТАТЬИ (направление/страна/тип отдыха/тема), предпочитай общие устоявшиеся категории. ' +
  'tags — 4–6 более конкретных тегов НА ЯЗЫКЕ СТАТЬИ (например: пляжи, виза, бюджет, октябрь, кухня). ' +
  'sources — 2–3 авторитетных источника с РЕАЛЬНЫМИ URL (Wikivoyage, Wikipedia на языке статьи, официальные туристические порталы, ЮНЕСКО), title — на языке статьи; не выдумывай ссылки. ' +
  'image_queries — на английском, живописные (scenery/landmark/street), 2–3 штуки.';

// Localized theme labels for the on-page category chip.
export const THEME_LABELS: Record<string, Record<string, string>> = {
  guide: { ru: 'Тревел-гайд', uk: 'Тревел-гайд', en: 'Travel guide', de: 'Reiseführer' },
  tips: { ru: 'Советы', uk: 'Поради', en: 'Tips', de: 'Tipps' },
  review: { ru: 'Обзор', uk: 'Огляд', en: 'Review', de: 'Überblick' },
  story: { ru: 'История', uk: 'Історія', en: 'Story', de: 'Reisegeschichte' },
};
export function themeLabel(id: string, locale = 'ru'): string {
  const m = THEME_LABELS[id] || {}; return m[(locale || 'ru').toLowerCase()] || m.ru || id;
}

// Rotate theme: pick the first theme different from lastId (with a random offset so it varies).
export function nextTheme(lastId: string | null | undefined): BlogTheme {
  if (!lastId) return THEMES[Math.floor(Math.random() * THEMES.length)];
  const idx = THEMES.findIndex((t) => t.id === lastId);
  return THEMES[(idx + 1 + Math.floor(Math.random() * (THEMES.length - 1))) % THEMES.length];
}

// Country centroids for the globe fly-to intro (blog geo attribution). Covers the TOPICS pool.
export const COUNTRY_GEO: Record<string, { lat: number; lng: number }> = {
  'турция': { lat: 39.0, lng: 35.2 }, 'грузия': { lat: 42.0, lng: 43.5 }, 'армения': { lat: 40.1, lng: 45.0 },
  'азербайджан': { lat: 40.4, lng: 47.6 }, 'оаэ': { lat: 24.3, lng: 54.3 }, 'египет': { lat: 26.8, lng: 30.8 },
  'таиланд': { lat: 13.7, lng: 100.5 }, 'индонезия': { lat: -8.4, lng: 115.2 }, 'шри-ланка': { lat: 7.9, lng: 80.7 },
  'индия': { lat: 15.3, lng: 74.1 }, 'танзания': { lat: -6.2, lng: 39.2 }, 'марокко': { lat: 31.6, lng: -8.0 },
  'тунис': { lat: 34.0, lng: 9.6 }, 'кипр': { lat: 34.9, lng: 33.3 }, 'греция': { lat: 39.0, lng: 22.0 },
  'испания': { lat: 40.4, lng: -3.7 }, 'канары': { lat: 28.3, lng: -16.6 }, 'португалия': { lat: 39.5, lng: -8.0 },
  'италия': { lat: 41.9, lng: 12.5 }, 'франция': { lat: 46.6, lng: 2.4 }, 'австрия': { lat: 47.5, lng: 14.6 },
  'чехия': { lat: 50.1, lng: 14.4 }, 'венгрия': { lat: 47.5, lng: 19.0 }, 'польша': { lat: 52.2, lng: 21.0 },
  'нидерланды': { lat: 52.4, lng: 4.9 }, 'германия': { lat: 51.1, lng: 10.4 }, 'исландия': { lat: 64.1, lng: -21.9 },
  'черногория': { lat: 42.4, lng: 18.9 }, 'хорватия': { lat: 43.5, lng: 16.4 }, 'мальдивы': { lat: 3.2, lng: 73.2 },
  'сейшелы': { lat: -4.6, lng: 55.5 }, 'маврикий': { lat: -20.3, lng: 57.6 },
};
// Resolve a topic like "Стамбул, Турция" or "Кипр (Ларнака и Пафос)" to coordinates (country centroid).
export function geoForTopic(topic: string): { lat: number; lng: number } | null {
  if (!topic) return null;
  const cleaned = topic.replace(/\(.*?\)/g, '').trim();
  const parts = cleaned.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) { if (COUNTRY_GEO[parts[i]]) return COUNTRY_GEO[parts[i]]; }
  // whole-string match (e.g. "Тунис", "Мальдивы")
  const whole = cleaned.toLowerCase();
  return COUNTRY_GEO[whole] || null;
}
