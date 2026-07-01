import { Request } from 'express';

// Resolve visitor country from edge headers (Vercel/Cloudflare). ТЗ §9.2 / §16.
export function countryFromRequest(req: Request): string | null {
  const h = (name: string) => (req.headers[name] as string | undefined)?.trim();
  return (
    h('x-vercel-ip-country') ||
    h('cf-ipcountry') ||
    h('x-country-code') ||
    null
  );
}

// Country (ISO-3166-1 alpha-2) -> locale mapping (ТЗ §9.2).
const COUNTRY_LOCALE: Record<string, string> = {
  PL: 'pl',
  FR: 'fr', BE: 'fr',
  JP: 'ja',
  DE: 'de', AT: 'de', CH: 'de',
  UA: 'uk',
  RU: 'ru', BY: 'ru',
  IT: 'it',
  PT: 'pt', BR: 'pt',
  ES: 'es', MX: 'es', AR: 'es', CO: 'es', CL: 'es', PE: 'es',
};

export function localeFromCountry(cc: string | null, supported: string[], fallback: string): string {
  if (!cc) return fallback;
  const loc = COUNTRY_LOCALE[cc.toUpperCase()];
  return loc && supported.includes(loc) ? loc : fallback;
}

export function parseAcceptLanguage(header: string | undefined, supported: string[]): string | null {
  if (!header) return null;
  const langs = header
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=');
      return { tag: tag.split('-')[0].toLowerCase(), q: q ? parseFloat(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);
  for (const { tag } of langs) if (supported.includes(tag)) return tag;
  return null;
}
