# Подключение eSIM-провайдера (Airalo) через Travelpayouts

Дополнение к [`travelpayouts-setup.md`](./travelpayouts-setup.md). Travelpayouts, помимо туров/отелей/авиа, поддерживает **eSIM-бренды** — в т.ч. **Airalo** и **Yesim**. Подключаются они как обычные партнёрские программы и обёртываются тем же Partner Links API — **отдельный API-ключ Airalo не нужен**, используются те же `TRAVELPAYOUTS_TOKEN / MARKER / TRS`.

## Два разных способа работать с Airalo — не путать

| | Direct Airalo Partner API (`src/esim/*`) | **Airalo через Travelpayouts (эта инструкция)** |
|---|---|---|
| Модель | реселлер: сами продаёте/провижионите eSIM | **аффилиат**: ведёте юзера на airalo.com, покупка там |
| Нужны креды | API-ключ Airalo (Partners) | только Travelpayouts (token/marker/trs) |
| Деньги | ваша наценка | комиссия за продажу (до ~10%), cookie 30 дней |
| Провижн/заказы | да | нет (покупка на стороне Airalo) |

Ниже — про **аффилиатный** путь через Travelpayouts. Он самый быстрый: ноль интеграции с Airalo, переиспользует уже настроенные ключи.

---

## Шаг 1. Подключить программу Airalo

1. В аккаунте Travelpayouts откройте каталог программ и подключите **Airalo Partner Program** (при желании также **Yesim**) к вашему **Project**.
2. Дождитесь одобрения проекта для бренда (до 24 ч).
3. Убедитесь, что ваш **TRS (Project ID) подписан именно на Airalo**. Если нет — Partner Links API вернёт ошибку `trs is not subscribed for brand` (см. ниже).

Ключи те же, что уже стоят в env (`TRAVELPAYOUTS_TOKEN / MARKER / TRS`) — ничего нового прописывать не надо.

## Шаг 2. Получить партнёрскую eSIM-ссылку

Есть два способа обернуть ссылку на airalo.com в партнёрскую.

### Способ A — Partner Links API (как для остальных брендов)

Тот же эндпоинт, что уже используется в `TravelpayoutsProvider`:

```
POST https://api.travelpayouts.com/links/v1/create
{
  "trs": <PROJECT_ID>,
  "marker": <MARKER>,
  "shorten": true,
  "links": [ { "url": "https://www.airalo.com/georgia-esim", "sub_id": "<cameraId>" } ]
}
→ { "result": { "links": [ { "code": "success", "partner_url": "https://airalo.tp.st/…" } ] } }
```

Deep-link на страну: `https://www.airalo.com/<country>-esim` (например `…/georgia-esim`, `…/turkey-esim`), либо на конкретный план `https://www.airalo.com/<country>-esim/<plan-slug>`.

Если проект не подписан на Airalo, ответ будет:
```json
{ "code": "failed", "message": "trs is not subscribed for brand", "partner_url": "" }
```
→ вернитесь к Шагу 1 и подключите/дождитесь одобрения бренда.

### Способ B — redirect-шаблон (для ссылок из Airalo feed)

Airalo раздаёт через Travelpayouts **data feed** (каталог eSIM по странам). Ссылки в фиде (`g:link`) **не партнёрские** — их оборачивают шаблоном:

```
https://tp.media/r?marker=<MARKER>&trs=<PROJECT_ID>&p=8310&u=<ENCODED_LINK>&campaign_id=541
```
- `u` — URL-энкодед ссылка из поля `g:link` фида;
- `p=8310`, `campaign_id=541` — идентификаторы программы Airalo (из справки TP);
- `marker` / `trs` — ваши.

## Шаг 3. (Опционально) Airalo data feed для каталога

Фид даёт список eSIM-планов по странам (цена, объём, срок) — можно строить каталог/подсказки «eSIM для этой локации». Два фида: **old** (базовый) и **new** (расширенный, рекомендуется). Требование — проект должен быть подключён к Airalo. Ссылки из фида оборачивайте способом A или B.

## Шаг 4. Проверка

1. Оберните любую airalo-ссылку способом A и убедитесь, что вернулся `partner_url` (`*.tp.st/...`).
2. Раскройте короткую ссылку любым unshortener'ом — в конечном URL должен быть `marker=<ваш ID>`.
3. Продажи появляются в кабинете со статусом **PAID** на 8-е число следующего месяца.

---

## Как вплести в приложение (ОРБИТА)

В коде уже есть всё нужное — eSIM через TP делается «малой кровью»:

- **`TravelpayoutsProvider`** (`src/travel/providers/travelpayouts.provider.ts`) уже умеет конвертировать произвольные брендовые URL в партнёрские (метод пакетной конвертации, тот же Links API + кэш). Airalo-URL просто ещё один вход.
- Минимальный вариант: добавить в сборку офферов (`TravelService.offers`) пункт **eSIM** — deep link `https://www.airalo.com/<country>-esim`, где `<country>` берётся из `Destination.cc`/страны камеры, и прогнать его через тот же конвертер. В ответ `/api/travel/offers` добавится поле вроде `esim: { label, url }`.
- Расширенный вариант: подтянуть **Airalo feed**, кэшировать по стране, показывать 1–3 плана с ценой и обёрнутыми ссылками.
- Не смешивать с `src/esim/*` (там прямой Airalo Partner API для реального провижининга) — это независимый путь.

> Скажи, если нужно — добавлю в `TravelpayoutsProvider` вид ссылки `esim` (Airalo по стране) и поле `esim` в `/api/travel/offers`, плюс опционально парсер Airalo-фида. Это ~1 файл + пара строк в сервисе.

## Подводные камни

- **`trs is not subscribed for brand`** — самый частый затык: проект не подключён/не одобрен для Airalo.
- Только **полные** ссылки (не короткие), лимиты Links API: **100 запросов/мин на marker**, **≤10 ссылок/запрос** — поэтому батчами (уже так).
- Cookie атрибуции — **30 дней**; выплаты по продажам — на **8-е число** следующего месяца.
- Ключи — только на сервере (env), в клиент не отдаём.

## Источники (Travelpayouts / Airalo)

- Airalo Partner Program на Travelpayouts: https://www.travelpayouts.com/en/offers/airalo-partner-program/
- Data from Airalo (feed + redirect-шаблон `tp.media/r`): https://support.travelpayouts.com/hc/en-us/articles/17131439719826-Data-from-Airalo
- Partner Links API (пример airalo.com + ошибка «trs is not subscribed»): https://support.travelpayouts.com/hc/en-us/articles/25289759198226-API-for-Travelpayouts-partner-links
