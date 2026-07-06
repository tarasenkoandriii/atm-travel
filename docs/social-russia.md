# Постинг рекламных видео в российские соцсети

Реализовано в `PublishController` (`POST /api/publish`, `network: vk|ok`), рядом с Telegram/Facebook/Instagram/YouTube.
Готовность отдаётся в `GET /api/publish/config` (`vk`, `ok`) и показывается в `public/publish.html`.

## ВКонтакте (реализовано, inline по URL)
Флоу (как у Facebook `file_url` — без скачивания файла):
1. `video.save?link=<videoUrl>&group_id=<gid>&name&description` → `{ upload_url, owner_id, video_id }`.
2. Один GET на `upload_url` (VK импортирует внешнюю ссылку).
3. `wall.post?owner_id=-<gid>&from_group=1&message=<caption>&attachments=video<owner>_<video_id>`.

**Env:** `VK_ACCESS_TOKEN` (community/user токен со scope `video,wall`), `VK_GROUP_ID` (число, без минуса), `VK_API_VERSION` (по умолчанию `5.199`).
**Токен сообщества:** Управление сообществом → Работа с API → создать ключ (права: Видео, Стена). Постинг от имени сообщества — `from_group=1`.
**Оговорка:** параметр `link` в `video.save` рассчитан на встраиваемые ссылки (YouTube и т.п.). Прямой MP4 с Vercel Blob VK обычно импортирует, но если конкретный CDN не принимается — альтернатива: скачать файл и загрузить байтами (multipart на `upload_url`), лучше через фоновую очередь `PublishJobsService`.
**Лимиты:** до ~50 постов/сутки на стену, возможна капча при частом постинге.

## Одноклассники / OK.ru (реализовано, скачать+загрузить+пост)
REST API `https://api.ok.ru/fb.do` с MD5-подписью:
- `sig = md5( sort(params "k=v") + md5(access_token + OK_APP_SECRET) )`, `access_token` в подпись НЕ входит.
Флоу:
1. `video.getUploadUrl` (`gid`, `name`) → `{ upload_url, video_id }`.
2. Скачать наш MP4 → загрузить multipart (`file`) на `upload_url` (до 2 ГБ).
3. `mediatopic.post` (`type=GROUP_THEME`, `gid`, `attachment={"media":[{"type":"text","text":...},{"type":"movie","movieId":<video_id>}]}`).

**Env:** `OK_ACCESS_TOKEN` (право `VIDEO_CONTENT` + `GROUP_CONTENT`), `OK_APP_KEY` (public), `OK_APP_SECRET`, `OK_GROUP_ID`.
**Оговорка:** OK требует загрузки байтов (нет постинга по URL). Для коротких вертикальных роликов укладывается в таймаут; для крупных — вынести в фоновую очередь. Приложение OK должно быть одобрено (api-support@ok.ru), пользователь — модератор группы.

## «Яндексовские» и прочие RU-платформы (исследование)
- **Дзен (ex-Яндекс.Дзен)** — в 2022 продан VK; **прямого REST-API постинга видео нет**. Публикация: RSS-ингест канала (Дзен периодически забирает фид) или ручной Dzen Studio. Для нас — при желании добавить RSS-фид роликов, который Дзен подхватит. В `publish` возвращается `todo` с пояснением.
- **Яндекс** отдельного API для постинга в соцвидео сейчас не предоставляет (соц-направление ушло в VK).
- **Rutube** — есть Upload API для издателей (нужен OAuth-доступ издателя/паблишерский аккаунт). В дорожной карте; возвращается `todo`.
- **Yappy** (VK, TikTok-аналог) — API ограничен/по договорённости; кандидат на будущее.

Итог: для рекламных роликов в РФ основные каналы — **VK (видео/клипы)** и **OK (видео)** — реализованы; Дзен — через RSS; Rutube/Yappy — по мере получения доступа.
