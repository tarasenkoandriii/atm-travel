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
    // Collect concrete providers into the ESIM_PROVIDERS array. Adding Ubigi = add it to the class
    // providers above, inject it here, and push it into the returned array; callers stay untouched.
    {
      provide: ESIM_PROVIDERS,
      useFactory: (airalo: AiraloProvider) => [airalo],
      inject: [AiraloProvider],
    },
    EsimService,
    WayforpayService,
    CheckoutService,
  ],
  exports: [EsimService, CheckoutService],
})
export class EsimModule {}
