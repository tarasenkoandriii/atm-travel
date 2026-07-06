import { Module } from '@nestjs/common';
import { HotToursController } from './hottours.controller';
import { HotToursService } from './hottours.service';
import { TOUR_PROVIDERS } from './hottours.types';
import { MistoTravelProvider } from './providers/misto.provider';
import { TravelpayoutsToursProvider } from './providers/travelpayouts-tours.provider';
import { TravelModule } from '../travel/travel.module';

/**
 * Hot-tours blog generator. Feed adapters are @Injectable and each only runs when its own env keys
 * are present (see .enabled); the factory collects them under TOUR_PROVIDERS. HotToursService runs
 * at the end of the single daily cron: ingest → expire → generate (default 7) → sitemaps.
 */
@Module({
  imports: [TravelModule],
  controllers: [HotToursController],
  providers: [
    MistoTravelProvider,
    TravelpayoutsToursProvider,
    {
      provide: TOUR_PROVIDERS,
      useFactory: (misto: MistoTravelProvider, tp: TravelpayoutsToursProvider) => [misto, tp],
      inject: [MistoTravelProvider, TravelpayoutsToursProvider],
    },
    HotToursService,
  ],
  exports: [HotToursService],
})
export class HotToursModule {}
