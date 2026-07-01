import { CameraSource, CameraType } from '@prisma/client';

export interface DiscoveredCamera {
  source: CameraSource;
  externalId: string;
  type: CameraType;
  provider?: string;
  title: string;
  city?: string;
  country?: string;
  cc?: string;
  lat: number;
  lng: number;
  tz?: string;
  res?: string;
  videoId?: string | null;
  embed?: string | null;
  clipUrl?: string | null;
  img?: string | null;
  category?: string | null;
  wcCategory?: string | null;
  iata?: string | null;
  // transient: liveness known at discovery time (Windy)
  isLive?: boolean;
}

export interface CameraSourceAdapter {
  readonly source: CameraSource;
  discover(): Promise<DiscoveredCamera[]>;
  /** Validate a single camera is currently live. */
  isLive(cam: { externalId: string; videoId?: string | null; embed?: string | null; isLive?: boolean }): Promise<boolean>;
}
