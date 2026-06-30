import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { countryFromRequest, localeFromCountry, parseAcceptLanguage } from '../common/util/geo';

import en from './locales/en.json';
import ru from './locales/ru.json';
import uk from './locales/uk.json';
import pl from './locales/pl.json';
import fr from './locales/fr.json';
import ja from './locales/ja.json';
import de from './locales/de.json';

type Dict = Record<string, any>;

// Lightweight i18n (ТЗ §9). Can be swapped for nestjs-i18n; resolution order:
// manual cookie -> GeoIP country -> Accept-Language -> default.
@Injectable()
export class I18nService {
  private readonly logger = new Logger(I18nService.name);
  private readonly dicts: Record<string, Dict> = { en, ru, uk, pl, fr, ja, de };

  constructor(private readonly config: ConfigService) {}

  get supported(): string[] {
    return this.config.get<string>('SUPPORTED_LOCALES')!.split(',').map((s) => s.trim());
  }
  get defaultLocale(): string {
    return this.config.get<string>('DEFAULT_LOCALE')!;
  }

  /** Deep-merge a locale dict over the English base so missing keys fall back to en. */
  dictionary(locale: string): Dict {
    const base = this.dicts.en || {};
    const loc = this.dicts[locale] || {};
    return this.merge(base, loc);
  }

  resolveLocale(req: Request): string {
    const supported = this.supported;
    // 1) explicit user choice via cookie
    const cookieLoc = (req as any).cookies?.['locale'];
    if (cookieLoc && supported.includes(cookieLoc)) return cookieLoc;
    // 2) ?lang= override
    const q = (req.query?.lang as string | undefined)?.toLowerCase();
    if (q && supported.includes(q)) return q;
    // 3) GeoIP country
    const byCountry = localeFromCountry(countryFromRequest(req), supported, '');
    if (byCountry) return byCountry;
    // 4) Accept-Language
    const byAccept = parseAcceptLanguage(req.headers['accept-language'], supported);
    if (byAccept) return byAccept;
    // 5) default
    return this.defaultLocale;
  }

  private merge(a: Dict, b: Dict): Dict {
    const out: Dict = Array.isArray(a) ? [...a] : { ...a };
    for (const k of Object.keys(b)) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && typeof a[k] === 'object') {
        out[k] = this.merge(a[k], b[k]);
      } else {
        out[k] = b[k];
      }
    }
    return out;
  }
}
