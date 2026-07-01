import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';

export interface WfpPurchaseParams {
  merchantAccount: string;
  merchantDomainName: string;
  merchantSignature: string;
  orderReference: string;
  orderDate: number;
  amount: string;
  currency: string;
  productName: string[];
  productPrice: string[];
  productCount: string[];
  clientEmail?: string;
  language: string;
  returnUrl: string;
  serviceUrl: string;
}

export interface WfpCallback {
  merchantAccount: string;
  orderReference: string;
  merchantSignature: string;
  amount: string | number;
  currency: string;
  authCode: string;
  cardPan: string;
  transactionStatus: string;
  reasonCode: string | number;
  email?: string;
}

/**
 * WayForPay Purchase flow (https://wiki.wayforpay.com). All signatures are HMAC-MD5 over a
 * ";"-joined string of specific fields, keyed by the merchant secret. The exact strings that are
 * signed must equal the strings that are submitted — so amounts/prices are formatted once here.
 */
@Injectable()
export class WayforpayService {
  static readonly PAY_URL = 'https://secure.wayforpay.com/pay';

  constructor(private readonly config: ConfigService) {}

  get merchantAccount() { return this.config.get<string>('WFP_MERCHANT_ACCOUNT') || ''; }
  get merchantDomain() { return this.config.get<string>('WFP_MERCHANT_DOMAIN') || ''; }
  get secret() { return this.config.get<string>('WFP_SECRET_KEY') || ''; }
  get currency() { return this.config.get<string>('WFP_CURRENCY') || 'USD'; }
  get enabled() { return !!(this.merchantAccount && this.merchantDomain && this.secret); }

  private hmac(parts: (string | number)[]): string {
    return createHmac('md5', this.secret).update(parts.join(';'), 'utf8').digest('hex');
  }

  money(n: number): string { return n.toFixed(2); }

  /** Build the self-submitting purchase form params (with signature) for the client. */
  buildPurchase(input: {
    orderReference: string;
    amount: number;         // major units in `currency`
    productName: string;
    email?: string;
    returnUrl: string;
    serviceUrl: string;
    language?: string;
  }): { url: string; params: WfpPurchaseParams } {
    const orderDate = Math.floor(Date.now() / 1000);
    const amount = this.money(input.amount);
    const productName = [input.productName];
    const productPrice = [amount];
    const productCount = ['1'];
    const signature = this.hmac([
      this.merchantAccount,
      this.merchantDomain,
      input.orderReference,
      orderDate,
      amount,
      this.currency,
      ...productName,
      ...productCount,
      ...productPrice,
    ]);
    return {
      url: WayforpayService.PAY_URL,
      params: {
        merchantAccount: this.merchantAccount,
        merchantDomainName: this.merchantDomain,
        merchantSignature: signature,
        orderReference: input.orderReference,
        orderDate,
        amount,
        currency: this.currency,
        productName,
        productPrice,
        productCount,
        clientEmail: input.email,
        language: (input.language || 'AUTO').toUpperCase(),
        returnUrl: input.returnUrl,
        serviceUrl: input.serviceUrl,
      },
    };
  }

  /** Verify the serviceUrl callback signature sent by WayForPay. */
  verifyCallback(cb: WfpCallback): boolean {
    if (!cb || !cb.merchantSignature) return false;
    const expected = this.hmac([
      cb.merchantAccount,
      cb.orderReference,
      cb.amount,
      cb.currency,
      cb.authCode ?? '',
      cb.cardPan ?? '',
      cb.transactionStatus,
      cb.reasonCode ?? '',
    ]);
    return expected === cb.merchantSignature;
  }

  /** Build the mandatory "accept" acknowledgement WayForPay expects back. */
  buildAck(orderReference: string): { orderReference: string; status: string; time: number; signature: string } {
    const time = Math.floor(Date.now() / 1000);
    const signature = this.hmac([orderReference, 'accept', time]);
    return { orderReference, status: 'accept', time, signature };
  }
}
