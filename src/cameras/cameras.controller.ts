import { Controller, Get, NotFoundException, Param, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CamerasService } from './cameras.service';
import { QueryCamerasDto } from './dto/query-cameras.dto';
import { I18nService } from '../i18n/i18n.service';

@Controller('api')
export class CamerasController {
  constructor(private readonly cameras: CamerasService, private readonly i18n: I18nService) {}

  @Get('cameras')
  list(@Query() q: QueryCamerasDto) {
    return this.cameras.list(q);
  }

  @Get('cameras/snapshot')
  snapshot() {
    return this.cameras.getSnapshot();
  }

  @Get('cameras/:id')
  async get(@Param('id') id: string) {
    const cam = await this.cameras.get(id);
    if (!cam) throw new NotFoundException('Camera not found');
    return cam;
  }

  @Get('categories')
  categories(@Req() req: Request) {
    return this.cameras.categories(this.i18n.resolveLocale(req));
  }
}
