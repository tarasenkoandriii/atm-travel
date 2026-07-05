import { Module } from '@nestjs/common';
import { PublishController } from './publish.controller';

@Module({ controllers: [PublishController] })
export class PublishModule {}
