import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Serves the single-file frontend (public/index.html) at "/".
 * On Vercel the file is bundled via functions.includeFiles ("public/**") in vercel.json;
 * we resolve it from a few candidate paths to work both on serverless and a persistent process.
 */
@Controller()
export class FrontendController {
  private readonly html: string = FrontendController.load();

  private static load(): string {
    const candidates = [
      join(process.cwd(), 'public', 'index.html'),
      join(__dirname, '..', '..', 'public', 'index.html'),
      join(__dirname, '..', '..', '..', 'public', 'index.html'),
    ];
    for (const p of candidates) {
      try {
        if (existsSync(p)) return readFileSync(p, 'utf8');
      } catch {
        /* try next */
      }
    }
    return '';
  }

  @Get()
  root(@Res() res: Response) {
    if (this.html) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.type('html').send(this.html);
    }
    return res
      .status(500)
      .type('html')
      .send('<h1>ATM-travel.org</h1><p>frontend asset not found in bundle</p>');
  }
}
