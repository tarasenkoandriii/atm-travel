# Генерация статей блога по расписанию

Суточный крон (`/api/cron/refresh`) обновляет фид (ingest/expiry) и генерит **4**
черновика (`HOT_TOURS_CRON_BATCH`, дефолт 4). Чтобы поток был равномернее, в Supabase
заводим `pg_cron`-задачу, которая **раз в час** генерит ещё по **1** статье
(`HOT_TOURS_TICK_BATCH`, дефолт 1) и — по флагу — заодно обновляет фид.

## Эндпоинт

`POST`/`GET` `/api/hot-tours/generate[?ingest=1]`

Защита — тот же `CRON_SECRET`, что и у основного крона:
`Authorization: Bearer <CRON_SECRET>` **или** `x-cron-secret: <CRON_SECRET>`.

- **без флага** — только генерация `HOT_TOURS_TICK_BATCH` черновиков из уже загруженных
  активных туров (не бьёт по API фидов).
- **`?ingest=1`** — сначала «лёгкий» ingest (обновить цены/наличие) + expiry (снять
  протухшие туры, заархивировать их статьи, пересобрать sitemap), затем генерация.

Ответ: `{ "ok": true, "generated": N }` или с ingest — `{ ok, generated, ingested, expired }`.
Статьи создаются со статусом `draft`/`needs_manual` и ждут публикации в `/hot-admin`.

Проверка вручную:

```bash
# только генерация
curl -X POST "https://atm-travel.org/api/hot-tours/generate" -H "x-cron-secret: <CRON_SECRET>"
# генерация + обновление фида
curl -X POST "https://atm-travel.org/api/hot-tours/generate?ingest=1" -H "x-cron-secret: <CRON_SECRET>"
```

## Расписание через pg_cron + pg_net (Supabase)

Выполнить один раз в SQL Editor. Подставить домен и `CRON_SECRET`.

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- раз в час: обновить фид и сгенерировать 1 статью
select cron.schedule(
  'atm-hot-tours-generate',
  '0 * * * *',
  $$
    select net.http_post(
      url     := 'https://atm-travel.org/api/hot-tours/generate?ingest=1',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', '<CRON_SECRET>'
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $$
);
```

Если ingest на каждый час не нужен (беречь лимиты API) — уберите `?ingest=1` из `url`.

Управление:

```sql
select * from cron.job;
select * from cron.job_run_details order by start_time desc limit 20;

-- сменить частоту (пример — раз в 2 часа)
select cron.alter_job((select jobid from cron.job where jobname='atm-hot-tours-generate'),
                      schedule := '0 */2 * * *');

select cron.unschedule('atm-hot-tours-generate');
```

## Настройка объёмов

| Переменная | Дефолт | Что задаёт |
|---|---|---|
| `HOT_TOURS_CRON_BATCH` | 4 | статей за суточный крон |
| `HOT_TOURS_TICK_BATCH` | 1 | статей за один часовой тик |
| `HOT_TOURS_MIN_DISCOUNT` / `HOT_TOURS_MIN_STARS` | 15 / 4 | порог «интересности» тура |

> Таймаут `net.http_post` — 30 c: с `ingest=1` тик тянет фид, зовёт Grok и (при ключах
> Pixabay/Pexels) качает фото в Blob. Если не хватает — увеличьте.

Тик и суточный крон дёргают одну идемпотентную логику (similarity-guard не даёт дублей
по стране; ingest — upsert по dedupeHash), поэтому их параллельная работа безопасна.
