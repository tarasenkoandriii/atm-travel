import { z } from 'zod';

// Runtime env validation (ТЗ §13). Fail fast on missing critical vars.
export const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),
  REFRESH_CRON: z.string().default('0 15 * * *'),
  REFRESH_TZ: z.string().default('Europe/Kyiv'),
  CRON_SECRET: z.string().min(1).default('change-me'),
  SNAPSHOT_STORE: z.enum(['postgres', 'blob']).default('postgres'),

  LIVENESS_CONCURRENCY: z.coerce.number().int().positive().default(8),
  LIVENESS_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  DEAD_THRESHOLD: z.coerce.number().int().positive().default(5),

  WINDY_API_KEY: z.string().optional().default(''),
  WINDY_TARGET: z.coerce.number().int().positive().max(1000).default(1000),
  YOUTUBE_API_KEY: z.string().optional().default(''),

  WEATHERAPI_KEY: z.string().optional().default(''),
  WEATHER_FORECAST_DAYS: z.coerce.number().int().min(1).max(3).default(3), // free tier hard cap = 3
  WEATHER_TTL_SEC: z.coerce.number().int().positive().default(7200),
  WEATHER_UNITS: z.enum(['metric', 'imperial']).default('metric'),

  TRAVELPAYOUTS_TOKEN: z.string().optional().default(''),   // X-Access-Token (Profile → API token)
  TRAVELPAYOUTS_MARKER: z.string().optional().default(''),  // affiliate marker
  TRAVELPAYOUTS_TRS: z.string().optional().default(''),     // project ID subscribed to brand programs
  TRAVEL_PRIMARY_BRANDS: z.string().default('viator,getyourguide'),
  TRAVEL_DEFAULT_CURRENCY: z.string().default('USD'),
  TRAVEL_LINK_TTL_SEC: z.coerce.number().int().positive().default(2592000), // cache affiliate links ~30d
  VIATOR_DEALS_FEED_URL: z.string().optional().default(''), // gzipped JSON feed of discounted tours (from TP support)
  TRAVEL_ESIM_BRANDS: z.string().default('airalo,yesim'),   // eSIM affiliate brands shown in /api/travel/offers
  HOT_TOURS_MISTO_FEED_URL: z.string().optional().default(''),   // misto.travel package-tour feed (runs only if set)
  HOT_TOURS_MISTO_KEY: z.string().optional().default(''),
  HOT_TOURS_TP_FEED_URL: z.string().optional().default(''),      // Travelpayouts tour feed (runs only with TP token+marker)
  HOT_TOURS_TP_DISCOUNTS: z.string().optional().default(''),     // '1' = Hotellook Selections (real -discount%), preferred TP mode
  HOT_TOURS_TP_SELECTION: z.string().optional().default(''),     // selection type (default 'popularity'); e.g. 'tophotels','4-stars'
  HOT_TOURS_TP_HOTELS: z.string().optional().default(''),        // '1' = use Hotellook hotels-by-location as the source (preferred)
  HOT_TOURS_TP_LOCATIONS: z.string().optional().default(''),     // comma IATA/city list to pull hotel deals for
  HOT_TOURS_TP_DEPARTURE: z.string().optional().default(''),     // departure city label for hotel-based tours
  HOT_TOURS_TP_FLIGHTS: z.string().optional().default(''),       // '1' = use real TP Flight Data API (v2/prices/latest) as a source
  HOT_TOURS_TP_ORIGIN: z.string().optional().default(''),        // optional departure IATA for TP flight deals
  HOT_TOURS_MAX_ARTICLES: z.coerce.number().int().positive().default(7),
  HOT_TOURS_CRON_BATCH: z.coerce.number().int().nonnegative().default(4),   // articles per daily cron
  HOT_TOURS_TICK_BATCH: z.coerce.number().int().nonnegative().default(1),   // articles per 30-min pg_cron tick
  HOT_TOURS_MIN_DISCOUNT: z.coerce.number().int().default(15),
  HOT_TOURS_MIN_STARS: z.coerce.number().int().default(4),
  BLOG_AUTHOR: z.string().optional().default(''),          // blog byline (falls back to HOT_TOURS_AUTHOR)
  VOICE_API_KEY: z.string().optional().default(''),        // ElevenLabs API key (xi-api-key) for blog narration
  VOICE_ID: z.string().optional().default('EXAVITQu4vr4xnSDxMaL'),
  VOICE_MODEL: z.string().optional().default('eleven_flash_v2_5'),
  BLOG_LOCALES: z.string().optional().default('uk,ru,en,de'), // blog generation locales (rotated)
  BLOG_TOPICS: z.string().optional().default(''),          // optional '|'-separated topic override
  HOT_TOURS_AUTHOR: z.string().default('Олена Гринчук'),
  HOT_TOURS_ADMIN_TOKEN: z.string().optional().default(''),   // token for the /hot-admin moderation UI
  HOT_TOURS_USD_RATE: z.coerce.number().positive().default(41.5),   // UAH per 1 USD for the price note
  HOT_TOURS_EUR_RATE: z.coerce.number().positive().default(45.0),   // UAH per 1 EUR fallback for the price note
  DEALS_MIN_DISCOUNT: z.coerce.number().int().min(0).default(10),
  DEALS_LIMIT: z.coerce.number().int().positive().default(12),
  // eSIM (provider-agnostic; Airalo first)
  ESIM_PROVIDER: z.string().default('airalo'),
  ESIM_MARKUP_PCT: z.coerce.number().min(0).default(20),
  AIRALO_CLIENT_ID: z.string().optional().default(''),
  AIRALO_CLIENT_SECRET: z.string().optional().default(''),
  AIRALO_BASE_URL: z.string().default('https://partners-api.airalo.com'),
  AIRALO_API_VERSION: z.string().default('v2'),
  ESIM_CHECKOUT_URL: z.string().optional().default(''),
  // eSIM checkout (WayForPay + optional Google auth)
  WFP_MERCHANT_ACCOUNT: z.string().optional().default(''),
  WFP_MERCHANT_DOMAIN: z.string().optional().default(''),
  WFP_SECRET_KEY: z.string().optional().default(''),
  WFP_CURRENCY: z.string().default('USD'),
  ESIM_FX_RATE: z.coerce.number().positive().default(1),
  PUBLIC_BASE_URL: z.string().optional().default(''),
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  BLOB_READ_WRITE_TOKEN: z.string().optional().default(''),
  PEXELS_API_KEY: z.string().optional().default(''),
  PIXABAY_API_KEY: z.string().optional().default(''),
  XAI_API_KEY: z.string().optional().default(''),   // Grok (xAI) — reel analysis
  JAMENDO_CLIENT_ID: z.string().optional().default(''),        // audio: Jamendo catalog
  JAMENDO_HAS_COMMERCIAL: z.string().optional().default(''),   // 'true' once a paid Jamendo license is held
  FREESOUND_TOKEN: z.string().optional().default(''),          // audio: Freesound search/previews
  FREESOUND_OAUTH_BEARER: z.string().optional().default(''),   // audio: Freesound HQ download (OAuth)
  MUBERT_API_KEY: z.string().optional().default(''),           // audio: Mubert generator (pat)
  MUBERT_CUSTOMER_ID: z.string().optional().default(''),
  MUBERT_BASE: z.string().optional().default(''),              // override if Mubert rotates its base path
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),       // publish: Telegram Bot API
  TELEGRAM_BOT_USERNAME: z.string().optional().default(''),   // for the t.me/<bot>?start deep link
  TELEGRAM_WEBHOOK_SECRET: z.string().optional().default(''),  // optional X-Telegram-Bot-Api-Secret-Token check
  TELEGRAM_GROUP_CHAT_ID: z.string().optional().default(''),  // publish: own Telegram group/channel chat_id (send default)
  SEARCH_NOTIFY_DEBOUNCE_HOURS: z.coerce.number().int().nonnegative().default(24),  // don't re-send same tour within N hours
  RESEND_API_KEY: z.string().optional().default(''),          // search subscriptions: email via Resend
  MAIL_FROM: z.string().optional().default(''),               // e.g. 'ATM-travel <noreply@atm-travel.org>'
  MAIL_LOGO_URL: z.string().optional().default(''),          // optional logo image for branded emails
  ADMIN_EMAIL: z.string().optional().default(''),             // weekly effectiveness digest recipient
  ADMIN_TELEGRAM_CHAT_ID: z.string().optional().default(''),  // weekly effectiveness digest (Telegram)
  EMBEDDINGS_API_URL: z.string().optional().default(''),      // chat RAG: OpenAI-compatible embeddings endpoint
  EMBEDDINGS_API_KEY: z.string().optional().default(''),      // if empty → deterministic mock embeddings
  EMBEDDINGS_MODEL: z.string().optional().default('text-embedding-3-small'),
  EMBEDDINGS_DIM: z.coerce.number().int().positive().default(1024),   // MUST match vector(N) in orbita-pgvector.sql
  EMBED_BATCH_SIZE: z.coerce.number().int().positive().default(96),
  MAX_EMBEDS_PER_RUN: z.coerce.number().int().positive().default(300),
  WHATSAPP_PHONE_ID: z.string().optional().default(''),       // search subscriptions: WhatsApp Cloud API
  WHATSAPP_TOKEN: z.string().optional().default(''),
  FB_PAGE_ID: z.string().optional().default(''),              // publish: Facebook Page id
  FB_PAGE_TOKEN: z.string().optional().default(''),           // publish: FB Page access token (also used for IG)
  IG_USER_ID: z.string().optional().default(''),              // publish: Instagram business user id
  IG_ACCESS_TOKEN: z.string().optional().default(''),         // publish: IG token (falls back to FB_PAGE_TOKEN)
  YOUTUBE_CLIENT_ID: z.string().optional().default(''),       // publish: YouTube OAuth client
  YOUTUBE_CLIENT_SECRET: z.string().optional().default(''),
  YOUTUBE_REFRESH_TOKEN: z.string().optional().default(''),
  // publish: VKontakte (community token with video+wall scopes)
  VK_ACCESS_TOKEN: z.string().optional().default(''),         // VK community/user access token (video, wall)
  VK_GROUP_ID: z.string().optional().default(''),             // VK group id (numeric, positive)
  VK_API_VERSION: z.string().optional().default('5.199'),
  // publish: Odnoklassniki (OK.ru) — REST API with MD5 sig
  OK_ACCESS_TOKEN: z.string().optional().default(''),         // OK access token (VIDEO_CONTENT, GROUP_CONTENT)
  OK_APP_KEY: z.string().optional().default(''),              // OK application public key
  OK_APP_SECRET: z.string().optional().default(''),           // OK application secret key
  OK_GROUP_ID: z.string().optional().default(''),             // OK group id to post into
  DEFAULT_LOCALE: z.string().default('en'),
  SUPPORTED_LOCALES: z.string().default('en,uk,ru,pl,fr,de,ja,it,pt,es'),

  ADMIN_API_KEY: z.string().min(1).default('change-me'),
  LEAD_MIN_CONTACTS: z.coerce.number().int().positive().default(1),   // chat lead: required contacts (contact 1 mandatory, contact 2 optional)
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error('Invalid environment variables:\n' + parsed.error.toString());
  }
  return parsed.data;
}
