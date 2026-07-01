import { Module } from '@nestjs/common';
import { EsimService } from './esim.service';
import { EsimController } from './esim.controller';
import { ESIM_PROVIDERS } from './esim.constants';
import { AiraloProvider } from './providers/airalo.provider';
import { WayforpayService } from './checkout/wayforpay.service';
import { CheckoutService } from './checkout/checkout.service';
import { CheckoutController } from './checkout/checkout.controller';
// import { UbigiProvider } from './providers/ubigi.provider'; // ← add later

@Module({
  controllers: [EsimController, CheckoutController],
  providers: [
    AiraloProvider,
    // UbigiProvider,
    // Register each concrete provider under the multi-token. Adding Ubigi = one line here;
    // EsimService and all callers stay untouched.
    { provide: ESIM_PROVIDERS, useExisting: AiraloProvider, multi: true },
    // { provide: ESIM_PROVIDERS, useExisting: UbigiProvider, multi: true },
    EsimService,
    WayforpayService,
    CheckoutService,
  ],
  exports: [EsimService, CheckoutService],
})
export class EsimModule {}
