import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { getLegal, LEGAL_ENTITY, LEGAL_UPDATED } from './legal.content';

const SUPPORTED = ['en', 'ru', 'uk', 'pl', 'fr', 'ja', 'de', 'it', 'pt', 'es'];

@Controller('api/legal')
export class LegalController {
  @Get(':doc')
  get(@Param('doc') doc: string, @Query('lang') lang: string, @Req() req: Request) {
    const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)locale=([a-z-]+)/i)?.[1];
    const locale = (lang || cookie || 'uk').toLowerCase();
    const content = getLegal(doc, SUPPORTED.includes(locale) ? locale : 'en');
    if (!content) return { error: 'not_found' };
    return { ...content, entity: LEGAL_ENTITY, updatedAt: LEGAL_UPDATED };
  }
}
