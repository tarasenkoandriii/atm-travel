import { DiscoveredCamera } from '../source.types';

// Curated YouTube live highlights — migrated from worldwatch-premvp.html `CAMERAS`.
// Manage/extend via admin API later (ТЗ §5.1).
export const YOUTUBE_SEED: DiscoveredCamera[] = [
  { source: 'YOUTUBE', externalId: 'z-jYdOIKcTQ', type: 'YOUTUBE', videoId: 'z-jYdOIKcTQ', title: 'Таймс-сквер', city: 'Нью-Йорк', country: 'США', cc: 'US', lat: 40.7580, lng: -73.9855, tz: 'America/New_York', res: '4K', category: 'tourism', provider: 'earthcam', iata: 'NYC' },
  { source: 'YOUTUBE', externalId: 'VjSIXFwB_WQ', type: 'YOUTUBE', videoId: 'VjSIXFwB_WQ', title: 'Таймс-сквер · 24/7', city: 'Нью-Йорк', country: 'США', cc: 'US', lat: 40.7588, lng: -73.9862, tz: 'America/New_York', res: '4K', category: 'tourism', provider: 'earthcam', iata: 'NYC' },
  { source: 'YOUTUBE', externalId: 'rnXIjl_Rzy4', type: 'YOUTUBE', videoId: 'rnXIjl_Rzy4', title: 'Таймс-сквер · аэро', city: 'Нью-Йорк', country: 'США', cc: 'US', lat: 40.7575, lng: -73.9850, tz: 'America/New_York', res: '4K', category: 'tourism', provider: 'earthcam', iata: 'NYC' },
  { source: 'YOUTUBE', externalId: 'Ksrleaxxxhw', type: 'YOUTUBE', videoId: 'Ksrleaxxxhw', title: 'Французский квартал', city: 'Новый Орлеан', country: 'США', cc: 'US', lat: 29.9584, lng: -90.0644, tz: 'America/Chicago', res: 'HD', category: 'tourism', provider: 'earthcam', iata: 'MSY' },
  { source: 'YOUTUBE', externalId: 'ryyC8t-mxyQ', type: 'YOUTUBE', videoId: 'ryyC8t-mxyQ', title: 'Бурбон-стрит', city: 'Новый Орлеан', country: 'США', cc: 'US', lat: 29.9588, lng: -90.0650, tz: 'America/Chicago', res: 'HD', category: 'people', provider: 'earthcam', iata: 'MSY' },
  { source: 'YOUTUBE', externalId: 'rnNPl27Arpk', type: 'YOUTUBE', videoId: 'rnNPl27Arpk', title: 'Балкон над Бурбон-стрит', city: 'Новый Орлеан', country: 'США', cc: 'US', lat: 29.9591, lng: -90.0648, tz: 'America/Chicago', res: 'HD', category: 'people', provider: 'earthcam', iata: 'MSY' },
  { source: 'YOUTUBE', externalId: 'dFBRpHHwQeg', type: 'YOUTUBE', videoId: 'dFBRpHHwQeg', title: 'Бассейн Сан-Марко', city: 'Венеция', country: 'Италия', cc: 'IT', lat: 45.4326, lng: 12.3397, tz: 'Europe/Rome', res: '4K', category: 'architecture', provider: 'worldcam', wcCategory: 'Венеция · каналы', iata: 'VCE' },
];
