import { Module } from '@nestjs/common';
import { PublishController } from './publish.controller';
import { PublishJobsService } from './publish-jobs.service';

@Module({
  controllers: [PublishController],
  providers: [PublishJobsService],
  exports: [PublishJobsService],
})
export class PublishModule {}
