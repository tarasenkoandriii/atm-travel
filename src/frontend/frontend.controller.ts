import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Serves the single-file frontend at "/" and the eSIM checkout page at "/esim".
 * On Vercel these are bundled via functions.includeFiles ("public/**") in vercel.json;
 * resolved from a few candidate paths to work on serverless and a persistent process.
 */
@Controller()
export class FrontendController {
  private readonly index: string = FrontendController.load('index.html');
  private readonly esim: string = FrontendController.load('esim.html');
  private readonly legal: string = FrontendController.load('legal.html');
  private readonly cine: string = FrontendController.load('cine.html');
  private readonly reel: string = FrontendController.load('reel.html');

  private static load(file: string): string {
    const candidates = [
      join(process.cwd(), 'public', file),
      join(__dirname, '..', '..', 'public', file),
      join(__dirname, '..', '..', '..', 'public', file),
    ];
    for (const p of candidates) {
      try { if (existsSync(p)) return readFileSync(p, 'utf8'); } catch { /* try next */ }
    }
    return '';
  }

  @Get()
  root(@Res() res: Response) {
    return this.serve(res, this.index);
  }

  @Get('esim')
  esimPage(@Res() res: Response) {
    return this.serve(res, this.esim);
  }

  @Get('legal/:doc')
  legalPage(@Res() res: Response) {
    return this.serve(res, this.legal);
  }

  @Get('cine')
  cinePage(@Res() res: Response) {
    return this.serve(res, this.cine);
  }

  @Get('reels')
  reelPage(@Res() res: Response) {
    return this.serve(res, this.reel);
  }

  private serve(res: Response, html: string) {
    if (html) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.type('html').send(html);
    }
    return res.status(500).type('html').send('<h1>ATM-travel.org</h1><p>frontend asset not found in bundle</p>');
  }
}
