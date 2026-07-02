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
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), { bodyParser: false, logger: ['error', 'warn', 'log'] });
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // YouTube embeds need a referrer to validate embedding — 'no-referrer' (helmet default) breaks the player (error 153).
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use(cookieParser());
  // Raw binary body for the server-side Blob upload (must run before the JSON parser). Capped at Vercel's ~4.5MB body limit.
  app.use('/api/cine/put', express.raw({ type: () => true, limit: '5mb' }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.enableCors({
    origin: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
}

// Caches the Nest app across warm invocations (ТЗ §16).
export default async function handler(req: any, res: any) {
  try {
    if (!ready) ready = bootstrap();
    await ready;
    server(req, res);
  } catch (e: any) {
    ready = null; // allow a fresh bootstrap attempt on the next request
    console.error('Nest bootstrap/handler error:', e);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'server_init_failed', message: String(e?.message || e) }));
  }
}
