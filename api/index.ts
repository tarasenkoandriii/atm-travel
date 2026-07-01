// @ts-nocheck — thin Vercel serverless bootstrap. Imports the tsc-compiled Nest app from /dist
// (built by `nest build`), so NestJS DI metadata (emitDecoratorMetadata) is preserved even though
// Vercel bundles this entry with esbuild. This file itself uses no injectable decorators.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from '../dist/app.module';

const server = express();
let ready: Promise<void> | null = null;

async function bootstrap() {
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), { logger: ['error', 'warn', 'log'] });
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.enableCors({
    origin: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
}

// Caches the Nest app across warm invocations (ТЗ §16).
export default async function handler(req: any, res: any) {
  if (!ready) ready = bootstrap();
  await ready;
  server(req, res);
}
