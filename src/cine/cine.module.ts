import { Module } from '@nestjs/common';
import { CineController } from './cine.controller';

@Module({ controllers: [CineController] })
export class CineModule {}
