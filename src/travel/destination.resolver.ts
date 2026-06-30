import { Injectable } from '@nestjs/common';
import { Camera } from '@prisma/client';
import { Destination } from './travel.types';

// Minimal city/cc -> IATA fallback table for seed destinations (extend as catalog grows, ТЗ §8.3).
const CITY_IATA: Record<string, string> = {
  'нью-йорк': 'NYC', 'new york': 'NYC',
  'новый орлеан': 'MSY', 'new orleans': 'MSY',
  'венеция': 'VCE', 'venice': 'VCE',
};

@Injectable()
export class DestinationResolver {
  fromCamera(cam: Pick<Camera, 'city' | 'cc' | 'lat' | 'lng' | 'iata'>): Destination {
    const iata =
      cam.iata ||
      (cam.city ? CITY_IATA[cam.city.toLowerCase()] : undefined) ||
      null;
    return { city: cam.city, cc: cam.cc, iata, lat: cam.lat, lng: cam.lng };
  }

  fromLatLng(lat: number, lng: number): Destination {
    return { lat, lng, cc: null, city: null, iata: null };
  }
}
