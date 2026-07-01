import { Module } from '@nestjs/common';
import { ReelController } from './reel.controller';

@Module({ controllers: [ReelController] })
export class ReelModule {}
