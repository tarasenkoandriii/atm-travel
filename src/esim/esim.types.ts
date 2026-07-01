// ── Normalized, provider-agnostic eSIM domain DTOs ──────────────────────────────
// Money is expressed in minor units (cents) to avoid float drift across providers.
// Data volume is expressed in MB (null => unlimited).

export type EsimScope = 'local' | 'regional' | 'global';

export interface EsimPackage {
  id: string;                 // provider-native package id
  provider: string;           // 'airalo' | 'ubigi' | ...
  title: string;
  scope: EsimScope;
  countries: string[];        // ISO-3166 alpha-2 codes covered
  region?: string | null;
  dataMb: number | null;      // null when unlimited
  unlimited: boolean;
  days: number;               // validity in days
  priceMinor: number;         // retail price in minor units
  currency: string;
  topupAvailable: boolean;
}

export interface EsimActivation {
  qrCode?: string | null;               // LPA activation string (e.g. LPA:1$...)
  qrCodeUrl?: string | null;            // hosted QR image
  directAppleInstallUrl?: string | null;
  smdpAddress?: string | null;
  activationCode?: string | null;
  apn?: string | null;
  instructionsHtml?: string | null;
}

export interface Esim {
  iccid: string;
  provider: string;
  packageId?: string | null;
  status?: string | null;
  activation: EsimActivation;
}

export interface EsimOrder {
  id: string;                 // provider order id
  provider: string;
  packageId: string;
  status: string;             // 'completed' | 'created' | 'failed' | provider raw
  priceMinor: number;
  currency: string;
  createdAt: string;
  esims: Esim[];
}

export interface EsimUsage {
  iccid: string;
  provider: string;
  remainingMb: number | null;
  totalMb: number | null;
  unlimited: boolean;
  status: string | null;      // ACTIVE | NOT_ACTIVE | FINISHED | ...
  expiresAt?: string | null;
}

// ── Inputs ──────────────────────────────────────────────────────────────────────
export interface ListPackagesQuery {
  country?: string;           // ISO alpha-2
  scope?: EsimScope;
  limit?: number;
}
export interface OrderPackageInput {
  packageId: string;
  quantity?: number;          // default 1
  reference?: string;         // your internal order id/ref
  email?: string;             // optional white-label delivery
}
export interface TopUpInput {
  iccid: string;
  packageId: string;
  reference?: string;
}

// ── The contract every provider implements ─────────────────────────────────────
export interface EsimProvider {
  readonly name: string;
  readonly enabled: boolean;
  listPackages(q?: ListPackagesQuery): Promise<EsimPackage[]>;
  orderPackage(input: OrderPackageInput): Promise<EsimOrder>;
  getEsim(iccid: string): Promise<Esim | null>;
  getUsage(iccid: string): Promise<EsimUsage | null>;
  topUp(input: TopUpInput): Promise<EsimOrder>;
}
