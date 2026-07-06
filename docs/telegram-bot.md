# Telegram-бот: авто-получение chat_id для подписок

Пользователь не вводит chat_id вручную: он жмёт «Подключить Telegram», открывается
`t.me/<bot>?start=<sub>`, нажимает **Start** — Telegram присылает боту `/start <sub>`,
и сервер связывает его chat_id с подписчиком (`TelegramLink`). Дальше подписка на
канал «Telegram» берёт chat_id автоматически.

## Настройка (один раз)

1. Создать бота у @BotFather, получить токен → `TELEGRAM_BOT_TOKEN`.
2. Узнать username бота (без @) → `TELEGRAM_BOT_USERNAME` (для deep-link).
3. (Опционально) задать `TELEGRAM_WEBHOOK_SECRET` — тогда вебхук проверяет заголовок
   `X-Telegram-Bot-Api-Secret-Token`.
4. Указать Telegram, куда слать апдейты (вебхук):

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://atm-travel.org/api/telegram/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"     # если задан
```

Проверка: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`.

## Эндпоинты

- `POST /api/telegram/webhook` — приём апдейтов (обрабатывает `/start <sub>`).
- `GET  /api/telegram/status?sub=<sub>` → `{ linked, botUsername, deepLink }`.

## Как это работает с подписками

- На сайте выбираем канал «Telegram» → кнопка «Подключить Telegram».
- После Start фронт видит `linked:true` (поллинг статуса) и разрешает «Подписаться».
- `POST /api/search/save` с `channel:"telegram"` и пустым `address` — сервер сам
  подставляет chat_id из `TelegramLink` по `sub`.

Уведомления шлёт `/api/search/notify` (крон/pg_cron) — на новые **и подешевевшие**
туры (падение цены фиксируется при ingest в `priceDropAt`/`prevPriceUAH`).
