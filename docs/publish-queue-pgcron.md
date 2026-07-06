# Частый прогон очереди публикаций (Instagram/YouTube)

Единственный Vercel-крон ходит раз в сутки — этого мало, чтобы фоновые задачи
IG/YouTube доезжали быстро. Решение: **Supabase Postgres (`pg_cron` + `pg_net`)**
каждые несколько минут пингует защищённый эндпоинт прогона очереди.

## Эндпоинт

`POST` или `GET` `/api/publish/queue/tick`

Защита — тот же `CRON_SECRET`, что и у `/api/cron/refresh`:
заголовок `Authorization: Bearer <CRON_SECRET>` **или** `x-cron-secret: <CRON_SECRET>`.

Ответ: `{ "ok": true, "advanced": <шагов>, "stuck": <снятых по таймауту> }`.
Каждый вызов двигает до 20 задач по 8 шагов и снимает задачи, застрявшие > 60 мин.

Проверка вручную:

```bash
curl -X POST https://atm-travel.org/api/publish/queue/tick \
  -H "x-cron-secret: <CRON_SECRET>"
```

## Расписание через pg_cron + pg_net (Supabase)

Выполнить один раз в SQL Editor проекта Supabase. Подставить свой домен и `CRON_SECRET`.

```sql
-- 1) расширения (в Supabase доступны из коробки)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) задача: каждые 2 минуты дёргать эндпоинт прогона очереди
select cron.schedule(
  'atm-publish-queue',          -- имя задачи
  '*/2 * * * *',                -- каждые 2 минуты
  $$
    select net.http_post(
      url     := 'https://atm-travel.org/api/publish/queue/tick',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', '<CRON_SECRET>'
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 8000
    );
  $$
);
```

Полезное:

```sql
-- список задач
select * from cron.job;

-- журнал последних запусков
select * from cron.job_run_details order by start_time desc limit 20;

-- изменить частоту (пример — каждую минуту)
select cron.alter_job((select jobid from cron.job where jobname='atm-publish-queue'),
                      schedule := '* * * * *');

-- удалить задачу
select cron.unschedule('atm-publish-queue');
```

> `net.http_post` ставит запрос в очередь pg_net и выполняет асинхронно; результат
> смотрите в `net._http_response` (по `id` из `cron.job_run_details`), но для нашего
> кейса ответ не важен — важно, что эндпоинт вызывается.

## Альтернатива без Postgres

Любой внешний планировщик, умеющий слать HTTP по расписанию, на тот же URL с тем же
заголовком: cron-job.org, EasyCron, GitHub Actions (`schedule:` + `curl`), UptimeRobot
(monitor с кастомным заголовком) и т.п. Логика та же — раз в 1–5 минут POST/GET на
`/api/publish/queue/tick` с `x-cron-secret`.

## Как это сочетается с остальным

- **Клиентский поллинг** (`publish.html`) — быстрый прогресс, пока открыта вкладка.
- **pg_cron-пинг** (этот файл) — двигает очередь каждые ~2 минуты без вкладки.
- **Суточный Vercel-крон** (`/api/cron/refresh`) — страховка: в самом конце тоже
  прогоняет очередь и чистит застрявшее.

Все три дёргают одну и ту же идемпотентную логику (`processPending` / `cleanupStuck`),
поэтому их одновременная работа безопасна.

---

# Рассылка по сохранённым поискам (подписки)

Эндпоинт: `POST`/`GET` `/api/search/notify` (под `CRON_SECRET`, как выше). Проверяет
активные подписки и шлёт новые совпадения на email/telegram/whatsapp. Также вызывается
в конце суточного крона; для более частой рассылки — pg_cron:

```sql
select cron.schedule(
  'atm-search-notify',
  '0 * * * *',                 -- раз в час
  $$ select net.http_post(
       url     := 'https://atm-travel.org/api/search/notify',
       headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
       body    := '{}'::jsonb, timeout_milliseconds := 20000
     ); $$
);
```

Каналы (серверные env): Telegram — `TELEGRAM_BOT_TOKEN` (пользователь даёт chat_id и
должен сам написать боту хотя бы раз); Email — `RESEND_API_KEY` + `MAIL_FROM`; WhatsApp —
`WHATSAPP_PHONE_ID` + `WHATSAPP_TOKEN` (Cloud API; для проактивных сообщений нужен
одобренный шаблон/opt-in).

## Дайджест раз в день

Подписки с частотой «раз в день» (`frequency=daily`) шлёт `/api/search/digest`
(CRON_SECRET). Он также вызывается в конце суточного крона; для фиксированного времени —
pg_cron:

```sql
select cron.schedule(
  'atm-search-digest',
  '0 9 * * *',                 -- ежедневно в 09:00 UTC
  $$ select net.http_post(
       url     := 'https://atm-travel.org/api/search/digest',
       headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
       body    := '{}'::jsonb, timeout_milliseconds := 30000
     ); $$
);
```

Мгновенные подписки (`instant`) остаются на часовом `/api/search/notify`.
Письма — HTML с фото туров (Resend). Ссылки на туры идут через `/go/tour/:id?u=<канал>`
(редирект логирует клик в `TourClick` → блок «Клики по ссылкам» в /hot-admin, с разбивкой
по каналам email/telegram/whatsapp/site) и дальше на партнёрскую ссылку с UTM.
Дебаунс: одна связка не чаще `SEARCH_NOTIFY_DEBOUNCE_HOURS` (24 ч).

## Лучшее за неделю

Подписки `frequency=weekly` шлёт `/api/search/weekly` (CRON_SECRET) — не «новые», а
топ текущих совпадений (по скидке, затем цене). Планировать раз в неделю:

```sql
select cron.schedule(
  'atm-search-weekly',
  '0 9 * * 1',                 -- понедельник 09:00 UTC
  $$ select net.http_post(
       url     := 'https://atm-travel.org/api/search/weekly',
       headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
       body    := '{}'::jsonb, timeout_milliseconds := 30000
     ); $$
);
```

UTM: подписочные клики помечаются `utm_campaign = <частота>` (instant/daily/weekly),
клики с сайта — `site-search`. Сводка «По кампаниям (UTM)» — в /hot-admin → Статистика.
Логотип письма — env `MAIL_LOGO_URL` (иначе текстовый бренд ATM·travel).

## Открытия писем и когортная воронка

- Открытия email — трекинг-пиксель `GET /px/o?c=<кампания>` (пишет `EmailEvent kind=open`),
  отправки — `EmailEvent kind=send`. Open-rate и A/B по открытиям — в /hot-admin.
- Показы статей — клиентский пинг `GET /px/v?slug=&s=<sub>` (sub-tagged, для когорт).
- Клики `/go/hot-tour/:slug?s=<sub>` и `/go/tour/:id?...&s=<sub>` несут sub → когортная
  воронка «показ → клик → переход» по одному пользователю (в /hot-admin).

## Недельный авто-дайджест эффективности (себе)

`POST`/`GET` `/api/hot-tours/admin-digest` (CRON_SECRET) шлёт сводку в Telegram
(`ADMIN_TELEGRAM_CHAT_ID`) и/или на почту (`ADMIN_EMAIL`). Планировать раз в неделю:

```sql
select cron.schedule(
  'atm-admin-digest', '0 8 * * 1',   -- понедельник 08:00 UTC
  $$ select net.http_post(
       url     := 'https://atm-travel.org/api/hot-tours/admin-digest',
       headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
       body    := '{}'::jsonb, timeout_milliseconds := 20000
     ); $$
);
```

## Понедельные снимки состояния подписчиков

Чтобы треугольник удержания учитывал не только отписки, но и паузы во времени, раз в неделю
снимается состояние каждого подписчика (`active`/`paused`/`canceled`) в таблицу
`SubscriberWeek` (идемпотентно по неделе). Снимок делается и в суточном кроне; для чёткого
времени — pg_cron:

```sql
select cron.schedule(
  'atm-subscriber-snapshot', '5 0 * * 1',   -- понедельник 00:05 UTC
  $$ select net.http_post(
       url     := 'https://atm-travel.org/api/hot-tours/snapshot-subscribers',
       headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
       body    := '{}'::jsonb, timeout_milliseconds := 20000
     ); $$
);
```

Ретеншн-треугольник (/hot-admin → Ретеншн) берёт состояние из снимков там, где они есть
(пауза = «не удержан» на ту неделю), иначе откатывается к истории `canceledAt`.

## ОРБИТА-Гид: pgvector-RAG, эмбеддинги, напоминания

ПЕРЕД запуском один раз выполнить `docs/orbita-pgvector.sql` в Supabase (extension vector,
таблица `tour_embeddings`, функция `search_tours`). `EMBEDDINGS_DIM` в env = `vector(N)` в SQL.

Ежечасный пересчёт эмбеддингов (только семантически изменившихся туров, потолок за прогон):

```sql
select cron.schedule(
  'atm-embed', '0 * * * *',    -- каждый час
  $$ select net.http_post(
       url     := 'https://atm-travel.org/api/embed/run',
       headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
       body    := '{}'::jsonb, timeout_milliseconds := 60000
     ); $$
);
```

Диспетчер напоминаний (каждые 5 минут):

```sql
select cron.schedule(
  'atm-reminders', '*/5 * * * *',
  $$ select net.http_post(
       url     := 'https://atm-travel.org/api/chat/reminders/dispatch',
       headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
       body    := '{}'::jsonb, timeout_milliseconds := 20000
     ); $$
);
```

Оба вызываются и в суточном кроне как fallback. Без `EMBEDDINGS_API_KEY` эмбеддинги
детерминированно мокаются (пайплайн и поиск работают, но семантика поиска нерелевантна —
для боевого качества задать ключ провайдера, напр. BGE-M3 1024 или OpenAI 1536→DIM=1536).
Чат: `/api/chat` (tool-calling + goal_state + история), `/api/chat/history?sub=`,
`/api/chat/lead`. Защита: Origin-allowlist (`ALLOWED_ORIGINS`+`PUBLIC_BASE_URL`),
rate-limit (≤20 сообщений/мин на visitor), honeypot на форме лида.

-- Блог: генерировать 1 оригинальную тревел-статью в сутки (черновик → модерация в /hot-admin).
-- (также запускается раз в сутки из основного refresh-крона; pg_cron даёт более гибкое расписание.)
select cron.schedule(
  'orbita-blog-generate', '17 6 * * *',
  $$ select net.http_post(
       url     := 'https://atm-travel.org/api/blog/generate',
       headers := jsonb_build_object('x-cron-secret', current_setting('app.cron_secret'))
     ) $$
);
