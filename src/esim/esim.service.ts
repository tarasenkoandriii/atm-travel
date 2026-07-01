import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ESIM_PROVIDERS } from './esim.constants';
import {
  Esim,
  EsimOrder,
  EsimPackage,
  EsimProvider,
  EsimUsage,
  ListPackagesQuery,
  OrderPackageInput,
  TopUpInput,
} from './esim.types';

/**
 * Provider-agnostic eSIM domain service.
 *
 * All concrete providers are injected via the ESIM_PROVIDERS multi-token. Selecting/adding a
 * provider is pure configuration: register UbigiProvider under the same token in EsimModule and
 * it becomes available here with zero changes to this class or any caller.
 */
@Injectable()
export class EsimService {
  private readonly logger = new Logger(EsimService.name);

  constructor(
    @Inject(ESIM_PROVIDERS) private readonly providers: EsimProvider[],
    private readonly config: ConfigService,
  ) {}

  /** Providers that are actually configured (have credentials). */
  get available(): EsimProvider[] {
    return this.providers.filter((p) => p.enabled);
  }

  get enabled(): boolean {
    return this.available.length > 0;
  }

  /** Pick a provider by name, or fall back to the configured default among the enabled ones. */
  provider(name?: string): EsimProvider {
    const enabled = this.available;
    const want = (name || this.config.get<string>('ESIM_PROVIDER') || 'airalo').toLowerCase();
    const chosen = enabled.find((p) => p.name === want) || enabled[0];
    if (!chosen) throw new NotFoundException('No eSIM provider is configured');
    return chosen;
  }

  listPackages(q?: ListPackagesQuery, provider?: string): Promise<EsimPackage[]> {
    if (!this.enabled) return Promise.resolve([]);
    return this.provider(provider).listPackages(q);
  }

  orderPackage(input: OrderPackageInput, provider?: string): Promise<EsimOrder> {
    return this.provider(provider).orderPackage(input);
  }

  getEsim(iccid: string, provider?: string): Promise<Esim | null> {
    return this.provider(provider).getEsim(iccid);
  }

  getUsage(iccid: string, provider?: string): Promise<EsimUsage | null> {
    return this.provider(provider).getUsage(iccid);
  }

  topUp(input: TopUpInput, provider?: string): Promise<EsimOrder> {
    return this.provider(provider).topUp(input);
  }

  /**
   * Cheapest package covering a country — handy for a contextual "eSIM for {country}" UI chip.
   * Prefers a local plan; falls back to regional/global if no local package exists.
   */
  async cheapestForCountry(country: string, provider?: string): Promise<EsimPackage | null> {
    if (!this.enabled || !country) return null;
    const cc = country.toUpperCase();
    let pkgs = await this.listPackages({ country: cc, scope: 'local' }, provider).catch(() => []);
    if (!pkgs.length) pkgs = await this.listPackages({ country: cc }, provider).catch(() => []);
    const covering = pkgs.filter((p) => !p.countries.length || p.countries.includes(cc));
    const pool = covering.length ? covering : pkgs;
    if (!pool.length) return null;
    return pool.reduce((a, b) => (b.priceMinor < a.priceMinor ? b : a));
  }
}
