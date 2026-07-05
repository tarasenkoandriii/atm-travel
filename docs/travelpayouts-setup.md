# Подключение провайдера путешествий — Travelpayouts

Инструкция для проекта **ATM-travel.org (ОРБИТА)**. Travelpayouts — партнёрская сеть: приложение отдаёт по локации ссылки на туры/отели/авиабилеты (Viator, GetYourGuide, Booking, Aviasales) и «горящие» цены. Со ключами ссылки автоматически становятся партнёрскими; без ключей работают обычные брендовые ссылки (режим ревью).

Задействованные модули: `src/travel/*` (провайдер `TravelpayoutsProvider`, сервис, эндпоинт `GET /api/travel/offers`) и `src/deals/*` (лента скидок Viator).

---

## Шаг 1. Регистрация и подключение брендов

1. Зарегистрируйтесь на **travelpayouts.com** и создайте **Project** (проект = ваш сайт/приложение `atm-travel.org`).
2. В каталоге программ подключите бренды, которые будете отдавать: как минимум **Viator** и **GetYourGuide** (можно также **Booking** и **Aviasales** для отелей/авиа).
3. Дождитесь одобрения проекта по каждому бренду. Модерация — **до 24 часов**; статусы: *Waiting for approval* / *Declined* / подключён. Ссылку на бренд можно генерировать только после одобрения.

## Шаг 2. Получить три значения

Коду нужны ровно три параметра:

| Параметр | Что это | Где взять |
|---|---|---|
| **TOKEN** | API-токен (`X-Access-Token`) | Личный кабинет → **Profile → вкладка API token**. Кнопка *Update token* перевыпускает токен и **немедленно ломает старый**. |
| **MARKER** | партнёрский ID (affiliate marker) | Внизу слева в аккаунте Travelpayouts. |
| **TRS** | Project ID, подписанный на программы бренда | В списке проектов (Project list). Это число вида `197987`. |

## Шаг 3. Прописать переменные окружения

Добавьте в окружение (локально — `.env`, на Vercel — Project → Settings → Environment Variables):

```bash
TRAVELPAYOUTS_TOKEN=<ваш API token>
TRAVELPAYOUTS_MARKER=<ваш marker>
TRAVELPAYOUTS_TRS=<ваш project id>

# опционально (у всех есть дефолты):
TRAVEL_PRIMARY_BRANDS=viator,getyourguide   # какие бренды показывать первым слоем
TRAVEL_DEFAULT_CURRENCY=USD
TRAVEL_LINK_TTL_SEC=2592000                 # кэш партнёрских ссылок, ~30 дней
VIATOR_DEALS_FEED_URL=<gzip JSON фид скидок Viator>   # выдаёт саппорт TP, для /api/deals
```

Все ключи уже в `env.validation.ts` и `.env.example` — отдельно ничего добавлять не нужно, только заполнить значения и **передеплоить**.

> Важно: `validate` в `ConfigModule` отбрасывает незнакомые переменные, поэтому значения читаются только если ключ есть в схеме (он есть).

## Шаг 4. Проверить

```bash
# по координатам камеры
curl "https://atm-travel.org/api/travel/offers?lat=45.4408&lng=12.3155&currency=EUR"
# или по камере
curl "https://atm-travel.org/api/travel/offers?cameraId=<id>&originIata=KBP"
```

Признаки успеха в ответе:
- `"affiliate": true` — ключи подхватились, ссылки обёрнуты как партнёрские (`*.tp.st/...`). Если `false` — ключей нет/не прочитались, отдаются обычные брендовые ссылки (всё равно рабочие).
- `experiences[]` — Viator / GetYourGuide, `hotels`, `flights` с `hotPrices` (горящие цены за 48 ч).

Быстрая проверка, что ссылка партнёрская: раскрыть короткую ссылку любым «unshortener» и убедиться, что есть `marker=<ваш ID>`.

---

## Как это работает под капотом

**Партнёрские ссылки — Partner Links API.** Провайдер строит обычную длинную брендовую ссылку по локации и конвертирует её в партнёрскую пачкой:

```
POST https://api.travelpayouts.com/links/v1/create
{
  "trs": 197987,
  "marker": 339296,
  "shorten": true,
  "links": [ { "url": "https://www.viator.com/…?...", "sub_id": "<cameraId>" } ]
}
→ { "result": { "links": [ { "code": "success", "partner_url": "https://viator.tp.st/…" } ] } }
```

- `sub_id` = id камеры/локации — для аналитики в кабинете.
- Кэш: L1 в памяти + БД (`TravelOfferCache`), TTL = `TRAVEL_LINK_TTL_SEC`.

**Горящие цены — Data API:**

```
GET https://api.travelpayouts.com/v2/prices/latest?currency=EUR&limit=…
Header: X-Access-Token: <TOKEN>
```

Без указания origin/destination возвращает ~30 самых дешёвых билетов за последние 48 ч (данные из кэша — годятся для статических блоков).

## Лимиты и подводные камни

- **100 запросов/мин на marker**, **≤10 ссылок за запрос** — поэтому конвертация батчами.
- Используйте **полные (длинные) ссылки**, короткие брендовые — нельзя. Часть брендов исключена из Links API (см. справку TP).
- Бренд должен быть **одобрен** для проекта, иначе ссылка не сгенерируется (`Link not generated yet`).
- Data API отдаёт данные из кэша (2–7 дней) — не для реального времени; кэшируйте на своей стороне (уже делаем).
- Ключи — только на сервере (в env), в клиент не попадают.

## Режим ревью (без ключей)

Пока `TOKEN/MARKER/TRS` не заданы, сайт полностью функционален: отдаются обычные брендовые ссылки (Viator/GetYourGuide/Booking/Aviasales). Как только ключи появятся — те же ссылки станут партнёрскими автоматически, без изменений кода.

---

## Источники (Travelpayouts Help Center)

- API-токен: https://support.travelpayouts.com/hc/en-us/articles/13024069738386-Where-to-find-API-token
- Partner Links API (trs/marker/links, лимиты): https://support.travelpayouts.com/hc/en-us/articles/25289759198226-API-for-Travelpayouts-partner-links
- Data API (X-Access-Token, prices/latest): https://travelpayouts.github.io/slate/
- Партнёрские ссылки и одобрение брендов: https://support.travelpayouts.com/hc/en-us/articles/360027912851-Getting-started-with-affiliate-links
