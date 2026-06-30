import { Controller, Get, Query, Req, BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { WeatherService } from './weather.service';
import { I18nService } from '../i18n/i18n.service';

@Controller('api')
export class WeatherController {
  constructor(private readonly weather: WeatherService, private readonly i18n: I18nService) {}

  @Get('weather')
  forecast(@Query('lat') lat: string, @Query('lng') lng: string, @Req() req: Request) {
    const la = Number(lat), ln = Number(lng);
    if (!isFinite(la) || !isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) {
      throw new BadRequestException('Invalid lat/lng');
    }
    return this.weather.getForecast(la, ln, this.i18n.resolveLocale(req));
  }
}
