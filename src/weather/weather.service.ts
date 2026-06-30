import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

export interface NormalizedWeather {
  gridKey: string;
  units: string;
  current: {
    tempC: number; condition: string; code: number; icon: string;
    windKph: number; windDir: string; humidity: number; feelsLikeC: number; uv: number;
  } | null;
  forecast: { date: string; maxC: number; minC: number; condition: string; code: number; rainChance: number }[];
  fetchedAt: string;
}

// WeatherAPI.com forecast proxy (ТЗ §7). Free tier: 3-day forecast, key stays server-side.
@Injectable()
export class WeatherService {
  private readonly logger = new Logger(WeatherService.name);

  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService) {}

  private gridKey(lat: number, lng: number): string {
    return `${lat.toFixed(2)},${lng.toFixed(2)}`;
  }

  async getForecast(lat: number, lng: number, locale: string): Promise<NormalizedWeather> {
    const gridKey = this.gridKey(lat, lng);
    const ttl = this.config.get<number>('WEATHER_TTL_SEC')! * 1000;
    const days = this.config.get<number>('WEATHER_FORECAST_DAYS')!;

    // 1) cache hit?
    const cached = await this.prisma.weatherCache.findUnique({ where: { gridKey } });
    if (cached && Date.now() - cached.fetchedAt.getTime() < ttl) {
      return cached.payload as any as NormalizedWeather;
    }

    // 2) upstream
    const key = this.config.get<string>('WEATHERAPI_KEY');
    if (!key) {
      this.logger.warn('WEATHERAPI_KEY not set — weather disabled');
      return { gridKey, units: this.units(), current: null, forecast: [], fetchedAt: new Date().toISOString() };
    }
    const url =
      `https://api.weatherapi.com/v1/forecast.json?key=${key}` +
      `&q=${gridKey}&days=${days}&aqi=no&alerts=no&lang=${this.lang(locale)}`;

    let normalized: NormalizedWeather;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`WeatherAPI HTTP ${r.status}`);
      const j: any = await r.json();
      normalized = this.normalize(gridKey, j);
    } catch (e) {
      this.logger.warn(`WeatherAPI error: ${String(e)}`);
      // serve stale cache if available
      if (cached) return cached.payload as any as NormalizedWeather;
      return { gridKey, units: this.units(), current: null, forecast: [], fetchedAt: new Date().toISOString() };
    }

    // 3) store cache (ephemeral)
    await this.prisma.weatherCache.upsert({
      where: { gridKey },
      create: { gridKey, payload: normalized as any, days, fetchedAt: new Date() },
      update: { payload: normalized as any, days, fetchedAt: new Date() },
    });
    return normalized;
  }

  private normalize(gridKey: string, j: any): NormalizedWeather {
    const c = j.current || {};
    const metric = this.units() === 'metric';
    const days = (j.forecast?.forecastday || []).map((d: any) => ({
      date: d.date,
      maxC: metric ? d.day?.maxtemp_c : d.day?.maxtemp_f,
      minC: metric ? d.day?.mintemp_c : d.day?.mintemp_f,
      condition: d.day?.condition?.text ?? '',
      code: d.day?.condition?.code ?? 0,
      rainChance: Number(d.day?.daily_chance_of_rain ?? 0),
    }));
    return {
      gridKey,
      units: this.units(),
      current: {
        tempC: metric ? c.temp_c : c.temp_f,
        condition: c.condition?.text ?? '',
        code: c.condition?.code ?? 0,
        icon: c.condition?.icon ? `https:${c.condition.icon}` : '',
        windKph: metric ? c.wind_kph : c.wind_mph,
        windDir: c.wind_dir ?? '',
        humidity: c.humidity ?? 0,
        feelsLikeC: metric ? c.feelslike_c : c.feelslike_f,
        uv: c.uv ?? 0,
      },
      forecast: days,
      fetchedAt: new Date().toISOString(),
    };
  }

  private units() { return this.config.get<string>('WEATHER_UNITS')!; }
  // WeatherAPI lang codes (subset for our locales)
  private lang(locale: string) {
    const map: Record<string, string> = { en: 'en', ru: 'ru', uk: 'uk', pl: 'pl', fr: 'fr', ja: 'ja', de: 'de' };
    return map[locale] ?? 'en';
  }
}
