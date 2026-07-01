import { Controller, Get, Query } from '@nestjs/common';
import { DealsService } from './deals.service';

@Controller('api')
export class DealsController {
  constructor(private readonly deals: DealsService) {}

  // Public: hot discounted tours for the showcase strip.
  @Get('deals')
  async list(@Query('limit') limit?: string) {
    const items = await this.deals.list(limit ? parseInt(limit, 10) : undefined);
    return { enabled: this.deals.enabled, items };
  }
}
