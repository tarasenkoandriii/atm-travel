import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RefreshController } from './refresh.controller';
import { RefreshService } from './refresh.service';
import { RefreshScheduler } from './refresh.scheduler';
import { LivenessService } from './liveness.service';
import { SourcesModule } from '../sources/sources.module';
import { CamerasModule } from '../cameras/cameras.module';
import { DealsModule } from '../deals/deals.module';
import { EsimModule } from '../esim/esim.module';
import { HotToursModule } from '../hottours/hottours.module';
import { PublishModule } from '../publish/publish.module';
import { SearchModule } from '../search/search.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { ChatModule } from '../chat/chat.module';
import { BlogModule } from '../blog/blog.module';

@Module({
  imports: [ScheduleModule.forRoot(), SourcesModule, CamerasModule, DealsModule, EsimModule, HotToursModule, PublishModule, SearchModule, EmbeddingsModule, ChatModule, BlogModule],
  controllers: [RefreshController],
  providers: [RefreshService, RefreshScheduler, LivenessService],
  exports: [RefreshService],
})
export class RefreshModule {}
