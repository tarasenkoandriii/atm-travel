import { Module } from '@nestjs/common';
import { TravelController } from './travel.controller';
import { TravelService } from './travel.service';
import { DestinationResolver } from './destination.resolver';
import { TravelpayoutsProvider } from './providers/travelpayouts.provider';
import { TravelGoController } from './travel-go.controller';
import { CamerasModule } from '../cameras/cameras.module';

@Module({
  imports: [CamerasModule],
  controllers: [TravelController, TravelGoController],
  providers: [TravelService, DestinationResolver, TravelpayoutsProvider],
  exports: [TravelService, TravelpayoutsProvider],
})
export class TravelModule {}
