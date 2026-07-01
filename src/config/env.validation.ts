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
  DEFAULT_LOCALE: z.string().default('en'),
  SUPPORTED_LOCALES: z.string().default('en,uk,ru,pl,fr,de,ja,it,pt,es'),

  ADMIN_API_KEY: z.string().min(1).default('change-me'),
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
