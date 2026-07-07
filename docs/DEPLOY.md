# Деплой ATM-travel.org — Postgres, Prisma и pg_cron

Кратко: приложение (NestJS) деплоится на Vercel, база — Supabase Postgres.
Порядок при любом обновлении: **1) `prisma db push`** → **2) один раз SQL для pgvector** →
**3) один раз настроить pg_cron** → **4) выставить env** → **5) redeploy**.

---

## 0. Предпосылки

- `DATABASE_URL` — строка подключения к Supabase Postgres (пулер, порт 6543, `?pgbouncer=true`).
- `DIRECT_URL` — прямое подключение (порт 5432) — нужно Prisma для `db push`/миграций.
  В `schema.prisma` datasource должен использовать оба:
  ```prisma
  datasource db {
    provider  = "postgresql"
    url       = env("DATABASE_URL")
    directUrl = env("DIRECT_URL")
  }
  ```
- Все прочие ключи — из `.env.example` (Grok/xAI, Travelpayouts, ElevenLabs `VOICE_API_KEY`,
  `BLOB_READ_WRITE_TOKEN`, соцсети VK/OK/FB/YouTube, `CRON_SECRET`, `HOT_TOURS_ADMIN_TOKEN`, `PUBLIC_BASE_URL` и т.д.).

---

## 1. Prisma: `db push`, обновление таблиц и моделей

Проект использует **`prisma db push`** (без файлов миграций) — схема `prisma/schema.prisma`
является источником истины, а `db push` приводит таблицы БД в соответствие ей. Это удобно с Supabase.

### Первый деплой / после любого изменения моделей
```bash
# 1) установить зависимости (postinstall сам зовёт prisma generate)
npm install

# 2) синхронизировать таблицы БД со schema.prisma и сгенерировать клиент
npx prisma db push
```
- `db push` **создаёт/меняет таблицы и колонки** под текущую `schema.prisma` и сразу
  запускает `prisma generate` (обновляет типизированный клиент в `node_modules/@prisma/client`).
- Ничего не удаляет молча: при потенциально разрушающем изменении (drop колонки/таблицы)
  Prisma **спросит подтверждение**. В неинтерактивном CI используйте осознанно
  `npx prisma db push --accept-data-loss` (только если понимаете, что теряете).

### Что делать при добавлении/изменении модели
1. Отредактировать `prisma/schema.prisma` (добавить модель/поле/индекс).
2. `npx prisma db push` — таблицы обновятся, клиент перегенерируется.
3. Redeploy приложения.

Примеры полей/таблиц, добавленных в этом проекте и требующих `db push`:
`BlogArticle` (+ `audioUrl`, `audioVoiceId`, `videoUrl`, `imagesJson`), `OfferStat`,
`Reminder.lang`, `ChatLead/ChatSession/ChatMessage/BookingIntent`, `SyncRun`, `SavedSearch.lang`, `Reel/PublishJob` и др.

### Проверка
```bash
npx prisma db pull --print   # показать, что реально в БД
npx prisma studio            # визуально посмотреть таблицы (локально)
```

> Замечание про Vercel: сам билд на Vercel `db push` **не** выполняет. Прогоняйте `npx prisma db push`
> вручную (локально/CI) при каждом изменении моделей, затем деплойте. `prisma generate`
> при этом происходит автоматически (postinstall).

---

## 2. Один раз: pgvector (RAG для ОРБИТА-Гид)

Выполнить **один раз** в Supabase → SQL Editor содержимое `docs/orbita-pgvector.sql`
(создаёт `extension vector`, таблицу `tour_embeddings`, ivfflat-индекс, функцию `search_tours()`,
FTS-индекс). Важно: размер вектора в SQL (`vector(1024)`) должен совпадать с `EMBEDDINGS_DIM` в env.

```sql
-- вставить весь файл docs/orbita-pgvector.sql и выполнить
```

---

## 3. Один раз: pg_cron + pg_net (инициализация кронов)

Один суточный Vercel-крон (`/api/cron/refresh`) — это страховка. Регулярные задачи
запускает **Supabase Postgres** через `pg_cron` (расписание) + `pg_net` (HTTP-вызов защищённых
эндпоинтов). Все cron-эндпоинты проверяют `CRON_SECRET` в заголовке
`x-cron-secret: <CRON_SECRET>` **или** `Authorization: Bearer <CRON_SECRET>`.

### 3.1 Включить расширения
```sql
-- расширения (в Supabase доступны из коробки)
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

> ВАЖНО (Supabase): **не используйте `ALTER DATABASE ... SET app.*`** — роль в SQL Editor не суперюзер,
> вы получите `ERROR: 42501: permission denied to set parameter`. Секрет и домен кладём прямо в
> функцию-хелпер (вариант A) или в Supabase Vault (вариант B).

### 3.2 Хелпер `app_ping`, чтобы не копировать http_post 11 раз

**Вариант A — просто (секрет зашит в функцию).** Подставьте свой `CRON_SECRET` и домен.
Определения функций видны только владельцу БД, для приватного проекта это нормально.
```sql
create or replace function app_ping(path text) returns void language plpgsql as $$
begin
  perform net.http_post(
    url     := 'https://atm-travel.org' || path,
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-cron-secret', '<CRON_SECRET>'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 8000
  );
end $$;
```

**Вариант B — через Supabase Vault (секрет не хранится в теле функции).**
```sql
-- положить секрет один раз
select vault.create_secret('<CRON_SECRET>', 'atm_cron_secret');

-- функция достаёт секрет из Vault на каждый вызов
create or replace function app_ping(path text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare sec text;
begin
  select decrypted_secret into sec from vault.decrypted_secrets where name = 'atm_cron_secret';
  perform net.http_post(
    url     := 'https://atm-travel.org' || path,
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', sec),
    body    := '{}'::jsonb,
    timeout_milliseconds := 8000
  );
end $$;
```
> Домен `https://atm-travel.org` подставьте свой в тексте функции.

### 3.3 Расписания (выполнить один раз)
```sql
select cron.schedule('atm-hot-tours-generate',     '0 * * * *',   $$ select app_ping('/api/hot-tours/generate?ingest=1') $$);        -- ежечасно: инжест+статьи
select cron.schedule('atm-publish-queue',          '*/2 * * * *', $$ select app_ping('/api/publish/queue/tick') $$);        -- очередь IG/YouTube
select cron.schedule('atm-embed-run',              '0 * * * *',   $$ select app_ping('/api/embed/run') $$);                 -- pgvector-эмбеддинги
select cron.schedule('atm-chat-reminders',         '*/5 * * * *', $$ select app_ping('/api/chat/reminders/dispatch') $$);   -- напоминания чата
select cron.schedule('atm-search-notify',          '0 * * * *',   $$ select app_ping('/api/search/notify') $$);            -- инстант-уведомления поиска
select cron.schedule('atm-search-digest',          '0 9 * * *',   $$ select app_ping('/api/search/digest') $$);            -- дневной дайджест
select cron.schedule('atm-search-weekly',          '0 9 * * 1',   $$ select app_ping('/api/search/weekly') $$);            -- недельный дайджест (пн)
select cron.schedule('atm-admin-digest',           '0 8 * * 1',   $$ select app_ping('/api/hot-tours/admin-digest') $$);   -- админ-сводка (пн)
select cron.schedule('atm-snapshot-subscribers',   '5 0 * * 1',   $$ select app_ping('/api/hot-tours/snapshot-subscribers') $$); -- срез подписчиков (пн)
select cron.schedule('atm-blog-generate',          '17 6 * * *',  $$ select app_ping('/api/blog/generate') $$);            -- 1 статья блога/сутки
-- страховка: продублировать суточный refresh (Vercel-крон и так его зовёт)
select cron.schedule('atm-refresh-daily',          '0 3 * * *',   $$ select app_ping('/api/cron/refresh') $$);

-- (опционально) отдельные RSS-каналы Дзена не нужны — RSS отдаётся по запросу.
```

### 3.4 Управление задачами
```sql
select jobid, jobname, schedule, active from cron.job order by jobname;      -- список
select * from cron.job_run_details order by start_time desc limit 20;        -- последние прогоны/ошибки
select cron.unschedule('atm-blog-generate');                                 -- снять задачу
```

### 3.5 Проверка эндпоинта вручную
```bash
curl -X POST https://atm-travel.org/api/publish/queue/tick -H "x-cron-secret: <CRON_SECRET>"
curl -X POST https://atm-travel.org/api/blog/generate       -H "x-cron-secret: <CRON_SECRET>"
```

---

## 4. Env (Vercel → Project → Settings → Environment Variables)

Минимум для работы: `DATABASE_URL`, `DIRECT_URL`, `CRON_SECRET`, `HOT_TOURS_ADMIN_TOKEN`,
`PUBLIC_BASE_URL`, `XAI_API_KEY`, `BLOB_READ_WRITE_TOKEN`, стоки `PIXABAY_API_KEY`/`PEXELS_API_KEY`,
озвучка `VOICE_API_KEY` (+ опц. `VOICE_ID`, `VOICE_MODEL`), эмбеддинги `EMBEDDINGS_*` (`EMBEDDINGS_DIM`
= размерности в pgvector.sql), Travelpayouts `TRAVELPAYOUTS_TOKEN/MARKER/TRS`, соцсети `VK_*`/`OK_*`/`FB_*`/`YOUTUBE_*`.
Полный список — в `.env.example`.

---

## 5. Порядок при обычном обновлении кода

1. Изменили модели? → `npx prisma db push` (обновит таблицы + клиент).
2. Изменили размерность эмбеддингов? → поправить `vector(N)` в `orbita-pgvector.sql` и `EMBEDDINGS_DIM`.
3. Добавили новый cron-эндпоинт? → добавить `cron.schedule(...)` (п. 3.3).
4. Redeploy на Vercel (push в ветку / `vercel --prod`).

Чек-лист «всё живо»:
```sql
select count(*) from cron.job;                       -- задачи на месте
select * from cron.job_run_details order by start_time desc limit 10;  -- без ошибок HTTP
```
