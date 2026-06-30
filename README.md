# ATM-travel.org — backend (NestJS) + интегрированный фронт

Реализация по ТЗ v1.6: живые камеры планеты (3D-глобус) + прогноз погоды + продажа впечатлений/путешествий (Viator/GetYourGuide через Travelpayouts) + мультиязычность + деплой на Vercel Hobby (временно).

## Что внутри

```
api/index.ts              — serverless-entry для Vercel (кеширует Nest-app)
src/main.ts               — entry для постоянного процесса (Railway/Render/VPS)
src/config/               — валидация env (zod)
src/prisma/               — PrismaService + advisory-lock (overlap-guard)
src/i18n/                 — 7 локалей, резолв по IP/cookie/Accept-Language (§9)
src/cameras/              — каталог, snapshot, /api/cameras, /categories (§4,§9,§10)
src/sources/              — адаптеры YouTube (Data API) + Windy Webcams v3 (§5,§6)
src/weather/              — WeatherAPI.com forecast (free 3 дня) + кеш (§7)
src/travel/               — Travelpayouts: Viator/GetYourGuide deep-links, отели/перелёты,
                            «горящие» цены (Data API), резолв направления по камере (§8)
src/refresh/              — оркестрация прогона, liveness, scheduler, /api/cron/refresh (§6)
src/bootstrap/            — /bootstrap (конфиг + локаль + словарь) (§11)
src/health/               — /health
public/index.html         — пре-MVP «ОРБИТА», ребренд → ATM-travel.org, подключён к API
prisma/schema.prisma      — модель данных (§4)
vercel.json               — crons (UTC) + rewrites + maxDuration
```

## Соответствие ключевым решениям ТЗ
- **Cron 15:00 Kyiv**: на Vercel — `vercel.json` crons `0 12 * * *` (UTC, ≈15:00 летом), эндпойнт `POST /api/cron/refresh` под `CRON_SECRET`. Overlap — `pg_advisory_lock`. На постоянном процессе — нативный `@nestjs/schedule` (точная TZ `Europe/Kyiv`).
- **Погода**: WeatherAPI.com free, `WEATHER_FORECAST_DAYS=3` (захардкожен максимум 3), ключ серверно, кеш по координатам, атрибуция «Powered by WeatherAPI.com».
- **Путешествия**: старт Viator + GetYourGuide (`TRAVEL_PRIMARY_BRANDS`), ссылки по направлению камеры. **Без хардкода program-ID**: brand-URL конвертируется в партнёрскую ссылку на лету через Partner Links API (`POST /links/v1/create`, `X-Access-Token`), бренд определяется по URL. Нужны только `TRAVELPAYOUTS_TOKEN`+`MARKER`+`TRS` и подключённые программы. Кеш ссылок: L1 in-memory + БД `TravelOfferCache` (TTL `TRAVEL_LINK_TTL_SEC`). `sub_id=cameraId`, отели/перелёты дополнением, «горящие» цены через Data API. Все токены серверно.
- **i18n**: en (default) + pl/fr/ja/de/uk/ru — все 7 локалей переведены полностью, автоопределение по `x-vercel-ip-country`, ручной переключатель (cookie), словарь отдаётся через `/bootstrap`.
- **Все ключи — серверно** (Windy/WeatherAPI/YouTube/Travelpayouts); клиентский Windy-fetch отключён.
- **Режим ревью / работа без ключей**: сайт полностью функционален без единого ключа. Камеры: YouTube используется только при заданном `YOUTUBE_API_KEY` (иначе источник отключён — сид пропускается, существующие YT-камеры скрываются), Windy — при `WINDY_API_KEY`; погода деградирует мягко; **travel-виджет показывает РАБОЧИЕ обычные ссылки брендов** (Viator/GetYourGuide/Booking/Aviasales) — `travel.enabled=true` всегда. Как только заданы token+marker+trs и программы подключены — те же ссылки на лету становятся партнёрскими (`travel.affiliate=true`). Это снимает проблему «курицы и яйца» при ревью программ Viator/GetYourGuide.

## Запуск локально
```bash
cp .env.example .env          # заполнить ключи (можно частично — модули деградируют мягко)
npm install
npm run prisma:generate
npm run prisma:migrate        # создать таблицы
npm run seed                  # засеять 7 YouTube-камер
npm run start:dev             # http://localhost:3000  (API),  public/index.html — фронт
```
Без ключей: камеры из сида показываются (liveness не валидируется), погода/Windy/travel мягко отключаются.

## Деплой на Vercel Hobby (временно)
1. Подключить Postgres (Supabase) → `DATABASE_URL`, `DIRECT_URL`.
2. Env в проекте Vercel (см. `.env.example`) + обязательно `CRON_SECRET`.
3. `vercel.json` уже содержит крон `0 12 * * *` (UTC) и `maxDuration:300`.
4. Прогнать миграции и seed (локально на прод-БД или через отдельный шаг).
5. Фронт `public/index.html` отдаётся как статика; `/api/*`, `/bootstrap`, `/health` → serverless-функция.

> ⚠️ **Hobby запрещает коммерческое использование.** Перед партнёрскими продажами — Vercel Pro или постоянный процесс (Railway/Render) с нативным `@nestjs/schedule`. «Несколько раз в сутки» на Hobby недостижимо (cron = 1/сутки) — внешний планировщик на тот же `POST /api/cron/refresh`.

## Эндпойнты
- `GET /api/cameras` · `GET /api/cameras/snapshot` · `GET /api/cameras/:id` · `GET /api/categories`
- `GET /api/weather?lat=&lng=`
- `GET /api/travel/offers?cameraId=|lat=&lng=`
- `GET /bootstrap` · `GET /health`
- `POST /api/cron/refresh` (CRON_SECRET) · `POST /api/admin/refresh` (X-Admin-Key) · `GET /api/admin/refresh/runs[/:id]`

## Что осталось доделать под прод (вне объёма скаффолда)
- Снапшот в Vercel Blob (если `SNAPSHOT_STORE=blob`) — реализован вариант `postgres`.
- Мобильные табы/bottom-sheet из §15 (базовый адаптив пре-MVP сохранён; виджеты погоды/travel ложатся в стек).
