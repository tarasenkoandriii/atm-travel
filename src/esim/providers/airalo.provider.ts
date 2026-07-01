import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Esim,
  EsimOrder,
  EsimPackage,
  EsimProvider,
  EsimUsage,
  ListPackagesQuery,
  OrderPackageInput,
  TopUpInput,
} from '../esim.types';

/**
 * Airalo Partner API adapter (https://partners-api.airalo.com, v2).
 * Maps Airalo's native payloads onto the normalized EsimProvider contract so the domain
 * (EsimService, controllers, UI) never depends on Airalo specifics. A second provider
 * (Ubigi) implements the same interface and is registered alongside this one — no domain changes.
 *
 * Endpoints used:
 *   POST /v2/token                       (OAuth client-credentials)
 *   GET  /v2/packages                    (catalog)
 *   POST /v2/orders                      (orderPackage)
 *   GET  /v2/sims/{iccid}                (getEsim)
 *   GET  /v2/sims/{iccid}/usage          (getUsage)
 *   POST /v2/orders/topups               (topUp)
 */
@Injectable()
export class AiraloProvider implements EsimProvider {
  readonly name = 'airalo';
  private readonly logger = new Logger(AiraloProvider.name);
  private token: { value: string; exp: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  private get clientId() { return this.config.get<string>('AIRALO_CLIENT_ID') || ''; }
  private get clientSecret() { return this.config.get<string>('AIRALO_CLIENT_SECRET') || ''; }
  private get base() { return (this.config.get<string>('AIRALO_BASE_URL') || 'https://partners-api.airalo.com').replace(/\/$/, ''); }
  private get version() { return this.config.get<string>('AIRALO_API_VERSION') || 'v2'; }
  private get markupPct() { return this.config.get<number>('ESIM_MARKUP_PCT') ?? 0; }
  get enabled() { return !!(this.clientId && this.clientSecret); }

  private url(path: string) { return `${this.base}/${this.version}/${path.replace(/^\//, '')}`; }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.exp > now + 60_000) return this.token.value;
    const form = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'client_credentials',
    });
    const r = await fetch(this.url('token'), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!r.ok) throw new Error(`Airalo token HTTP ${r.status}`);
    const j: any = await r.json();
    const value = j?.data?.access_token || j?.access_token;
    const ttl = Number(j?.data?.expires_in || j?.expires_in || 86400) * 1000;
    if (!value) throw new Error('Airalo token missing in response');
    this.token = { value, exp: now + ttl };
    return value;
  }

  private async authHeaders(extra?: Record<string, string>) {
    const token = await this.accessToken();
    return { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(extra || {}) };
  }

  private minor(price: any): number {
    const p = Number(price) || 0;
    const withMarkup = p * (1 + this.markupPct / 100);
    return Math.round(withMarkup * 100);
  }

  // ── Catalog ────────────────────────────────────────────────────────────────
  async listPackages(q: ListPackagesQuery = {}): Promise<EsimPackage[]> {
    if (!this.enabled) return [];
    const params = new URLSearchParams();
    if (q.scope === 'global' || q.scope === 'regional') params.set('filter[type]', 'global');
    if (q.scope === 'local') params.set('filter[type]', 'local');
    if (q.country) params.set('filter[country]', q.country.toUpperCase());
    params.set('include', 'topup');
    params.set('limit', String(q.limit ?? 1000));
    let raw: any;
    try {
      const r = await fetch(this.url(`packages?${params.toString()}`), { headers: await this.authHeaders({ 'Accept-Language': 'en' }) });
      if (!r.ok) { this.logger.warn(`Airalo packages HTTP ${r.status}`); return []; }
      raw = await r.json();
    } catch (e) {
      this.logger.warn(`Airalo packages error: ${String(e)}`);
      return [];
    }
    const out: EsimPackage[] = [];
    for (const entry of raw?.data || []) {
      // Airalo nests packages under country/region entries (and sometimes operators).
      const countries: string[] = (entry?.coverages || []).map((c: any) => c?.code).filter(Boolean);
      const cc = entry?.country_code ? [String(entry.country_code).toUpperCase()] : countries;
      const groups: any[] = entry?.operators?.length ? entry.operators : [entry];
      for (const g of groups) {
        const list: any[] = g?.packages || entry?.packages || [];
        const scope: EsimPackage['scope'] = q.scope || (cc.length > 1 ? 'regional' : (params.get('filter[type]') === 'global' ? 'global' : 'local'));
        for (const p of list) {
          out.push({
            id: String(p?.id),
            provider: this.name,
            title: p?.title || p?.data || String(p?.id),
            scope,
            countries: cc,
            region: entry?.title ?? null,
            dataMb: p?.is_unlimited ? null : Number(p?.amount ?? 0),
            unlimited: !!p?.is_unlimited,
            days: Number(p?.day ?? 0),
            priceMinor: this.minor(p?.price),
            currency: (raw?.meta?.currency || 'USD').toUpperCase(),
            topupAvailable: Array.isArray(p?.topup) ? p.topup.length > 0 : !!q,
          });
        }
      }
    }
    return out;
  }

  // ── Order ──────────────────────────────────────────────────────────────────
  async orderPackage(input: OrderPackageInput): Promise<EsimOrder> {
    const form = new URLSearchParams({
      package_id: input.packageId,
      quantity: String(input.quantity ?? 1),
      type: 'sim',
    });
    if (input.reference) form.set('description', input.reference);
    if (input.email) form.set('to_email', input.email);
    const r = await fetch(this.url('orders'), {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: form,
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Airalo order HTTP ${r.status}: ${j?.message || ''}`);
    return this.mapOrder(j?.data);
  }

  async topUp(input: TopUpInput): Promise<EsimOrder> {
    const form = new URLSearchParams({ package_id: input.packageId, iccid: input.iccid });
    if (input.reference) form.set('description', input.reference);
    const r = await fetch(this.url('orders/topups'), {
      method: 'POST',
      headers: await this.authHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: form,
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Airalo topup HTTP ${r.status}: ${j?.message || ''}`);
    return this.mapOrder(j?.data);
  }

  // ── eSIM details / usage ────────────────────────────────────────────────────
  async getEsim(iccid: string): Promise<Esim | null> {
    try {
      const r = await fetch(this.url(`sims/${encodeURIComponent(iccid)}`), { headers: await this.authHeaders() });
      if (!r.ok) return null;
      const j: any = await r.json();
      return this.mapEsim(j?.data);
    } catch (e) {
      this.logger.warn(`Airalo getEsim error: ${String(e)}`);
      return null;
    }
  }

  async getUsage(iccid: string): Promise<EsimUsage | null> {
    try {
      const r = await fetch(this.url(`sims/${encodeURIComponent(iccid)}/usage`), { headers: await this.authHeaders() });
      if (!r.ok) return null;
      const d: any = (await r.json())?.data ?? {};
      return {
        iccid,
        provider: this.name,
        remainingMb: d?.remaining != null ? Number(d.remaining) : null,
        totalMb: d?.total != null ? Number(d.total) : null,
        unlimited: !!d?.is_unlimited,
        status: d?.status ?? null,
        expiresAt: d?.expired_at ?? null,
      };
    } catch (e) {
      this.logger.warn(`Airalo getUsage error: ${String(e)}`);
      return null;
    }
  }

  // ── Mappers ────────────────────────────────────────────────────────────────
  private mapEsim(s: any): Esim | null {
    if (!s?.iccid) return null;
    return {
      iccid: String(s.iccid),
      provider: this.name,
      packageId: s?.package_id ?? null,
      status: s?.status ?? null,
      activation: {
        qrCode: s?.qrcode ?? null,
        qrCodeUrl: s?.qrcode_url ?? null,
        directAppleInstallUrl: s?.direct_apple_installation_url ?? null,
        smdpAddress: s?.apn?.smdp ?? null,
        activationCode: s?.matching_id ?? s?.lpa ?? null,
        apn: s?.apn?.value ?? s?.apn_value ?? null,
        instructionsHtml: s?.qrcode_installation ?? s?.manual_installation ?? null,
      },
    };
  }

  private mapOrder(d: any): EsimOrder {
    const sims: Esim[] = Array.isArray(d?.sims) ? d.sims.map((s: any) => this.mapEsim(s)).filter(Boolean) : [];
    if (!sims.length && (d?.qrcode_installation || d?.manual_installation)) {
      sims.push({
        iccid: String(d?.iccid ?? ''),
        provider: this.name,
        packageId: d?.package_id ?? null,
        status: d?.status ?? null,
        activation: {
          directAppleInstallUrl: d?.direct_apple_installation_url ?? null,
          instructionsHtml: d?.qrcode_installation ?? d?.manual_installation ?? null,
        },
      });
    }
    return {
      id: String(d?.id ?? d?.code ?? ''),
      provider: this.name,
      packageId: String(d?.package_id ?? ''),
      status: d?.status ?? 'created',
      priceMinor: Math.round((Number(d?.price) || 0) * 100),
      currency: (d?.currency || 'USD').toUpperCase(),
      createdAt: d?.created_at ?? new Date().toISOString(),
      esims: sims,
    };
  }
}
