import { Controller, Get, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { TravelService } from './travel.service';
import { I18nService } from '../i18n/i18n.service';

@Controller('api')
export class TravelController {
  constructor(private readonly travel: TravelService, private readonly i18n: I18nService) {}

  @Get('travel/offers')
  offers(
    @Req() req: Request,
    @Query('cameraId') cameraId?: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('currency') currency?: string,
    @Query('originIata') originIata?: string,
  ) {
    return this.travel.offers({
      cameraId,
      lat: lat != null ? Number(lat) : undefined,
      lng: lng != null ? Number(lng) : undefined,
      currency,
      originIata,
      locale: this.i18n.resolveLocale(req),
    });
  }
}
