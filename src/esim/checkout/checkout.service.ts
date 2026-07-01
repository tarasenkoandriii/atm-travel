import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { EsimService } from '../esim.service';
import { WayforpayService, WfpCallback } from './wayforpay.service';

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly esim: EsimService,
    private readonly wfp: WayforpayService,
  ) {}

  get enabled() { return this.esim.enabled && this.wfp.enabled; }
  private get baseUrl() { return (this.config.get<string>('PUBLIC_BASE_URL') || '').replace(/\/$/, ''); }
  private get fx() { return this.config.get<number>('ESIM_FX_RATE') ?? 1; } // package currency -> WFP currency

  /** Resolve a package server-side (never trust client price) and start a WayForPay purchase. */
  async create(input: { packageId: string; country: string; email?: string }) {
    if (!this.enabled) throw new BadRequestException('checkout not configured');
    if (!input.packageId || !input.country) throw new BadRequestException('packageId and country required');

    const pkgs = await this.esim.listPackages({ country: input.country });
    const pkg = pkgs.find((p) => p.id === input.packageId);
    if (!pkg) throw new NotFoundException('package not found');

    const orderReference = `ESIM-${input.country.toUpperCase()}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const amountMajor = Math.round((pkg.priceMinor / 100) * this.fx * 100) / 100;
    const wfpAmountMinor = Math.round(amountMajor * 100);

    await this.prisma.esimSale.create({
      data: {
        orderReference,
        provider: pkg.provider,
        packageId: pkg.id,
        country: input.country.toUpperCase(),
        email: input.email || null,
        amountMinor: wfpAmountMinor,
        currency: this.wfp.currency,
        status: 'pending',
      },
    });

    const pay = this.wfp.buildPurchase({
      orderReference,
      amount: amountMajor,
      productName: `eSIM ${pkg.title} (${input.country.toUpperCase()})`,
      email: input.email,
      returnUrl: `${this.baseUrl}/esim?ref=${encodeURIComponent(orderReference)}`,
      serviceUrl: `${this.baseUrl}/api/esim/checkout/callback`,
    });

    return { orderReference, pay };
  }

  /** WayForPay serviceUrl callback: verify, mark paid, provision the eSIM, persist, acknowledge. */
  async handleCallback(cb: WfpCallback) {
    if (!cb?.orderReference) throw new BadRequestException('bad callback');
    const sale = await this.prisma.esimSale.findUnique({ where: { orderReference: cb.orderReference } });
    if (!sale) { this.logger.warn(`callback for unknown order ${cb.orderReference}`); return this.wfp.buildAck(cb.orderReference); }

    if (!this.wfp.verifyCallback(cb)) {
      this.logger.warn(`bad signature on ${cb.orderReference}`);
      return this.wfp.buildAck(cb.orderReference); // still ack to stop retries; do not provision
    }

    const approved = String(cb.transactionStatus).toLowerCase() === 'approved';
    if (!approved) {
      if (sale.status === 'pending') await this.prisma.esimSale.update({ where: { id: sale.id }, data: { status: 'failed' } });
      return this.wfp.buildAck(cb.orderReference);
    }

    // Idempotent: only provision a paid order once.
    if (sale.status === 'provisioned') return this.wfp.buildAck(cb.orderReference);
    await this.prisma.esimSale.update({ where: { id: sale.id }, data: { status: 'paid', paidAt: new Date() } });

    try {
      const order = await this.esim.orderPackage(
        { packageId: sale.packageId, reference: sale.orderReference, email: sale.email || undefined },
        sale.provider,
      );
      const sim = order.esims[0];
      await this.prisma.esimSale.update({
        where: { id: sale.id },
        data: {
          status: 'provisioned',
          provisionedAt: new Date(),
          iccid: sim?.iccid || null,
          qrCode: sim?.activation?.qrCode || null,
          qrCodeUrl: sim?.activation?.qrCodeUrl || null,
          appleInstallUrl: sim?.activation?.directAppleInstallUrl || null,
          instructionsHtml: sim?.activation?.instructionsHtml || null,
        },
      });
    } catch (e) {
      // Payment succeeded but provisioning failed — keep 'paid' for retry, still acknowledge.
      this.logger.error(`provision failed for ${cb.orderReference}: ${String(e)}`);
    }
    return this.wfp.buildAck(cb.orderReference);
  }

  /** Retry orders that were paid but failed to provision (Airalo hiccup). Called by the daily cron. */
  async retryPending(limit = 50): Promise<number> {
    if (!this.enabled) return 0;
    const stuck = await this.prisma.esimSale
      .findMany({ where: { status: 'paid' }, orderBy: { paidAt: 'asc' }, take: limit })
      .catch(() => [] as any[]);
    let fixed = 0;
    for (const sale of stuck) {
      try {
        const order = await this.esim.orderPackage(
          { packageId: sale.packageId, reference: sale.orderReference, email: sale.email || undefined },
          sale.provider,
        );
        const sim = order.esims[0];
        if (!sim?.iccid) { this.logger.warn(`retry ${sale.orderReference}: no iccid returned`); continue; }
        await this.prisma.esimSale.update({
          where: { id: sale.id },
          data: {
            status: 'provisioned',
            provisionedAt: new Date(),
            iccid: sim.iccid,
            qrCode: sim.activation?.qrCode || null,
            qrCodeUrl: sim.activation?.qrCodeUrl || null,
            appleInstallUrl: sim.activation?.directAppleInstallUrl || null,
            instructionsHtml: sim.activation?.instructionsHtml || null,
          },
        });
        fixed++;
      } catch (e) {
        this.logger.warn(`retry provision failed ${sale.orderReference}: ${String(e)}`);
      }
    }
    if (fixed) this.logger.log(`Provisioning retry: recovered ${fixed}/${stuck.length} paid orders`);
    return fixed;
  }

  async status(ref: string) {
    const sale = await this.prisma.esimSale.findUnique({ where: { orderReference: ref } });
    if (!sale) throw new NotFoundException('order not found');
    return {
      orderReference: sale.orderReference,
      status: sale.status,
      country: sale.country,
      iccid: sale.iccid,
      qrCode: sale.qrCode,
      qrCodeUrl: sale.qrCodeUrl,
      appleInstallUrl: sale.appleInstallUrl,
      instructionsHtml: sale.instructionsHtml,
      email: sale.email,
    };
  }

  /** Optional Google sign-in: verify the ID token and return the (verified) email. */
  async verifyGoogle(idToken: string): Promise<{ email: string }> {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID') || '';
    if (!clientId) throw new BadRequestException('google auth not configured');
    if (!idToken) throw new BadRequestException('idToken required');
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!r.ok) throw new BadRequestException('invalid google token');
    const j: any = await r.json();
    if (j.aud !== clientId) throw new BadRequestException('token audience mismatch');
    if (j.email_verified !== 'true' && j.email_verified !== true) throw new BadRequestException('email not verified');
    return { email: j.email };
  }
}
