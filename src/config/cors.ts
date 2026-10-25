import { env } from './env.js';

/**
 * Validates origins against localhost, configured CLIENT_ORIGIN,
 * and RFC 1918 private LAN IP ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x).
 */
export const isOriginAllowed = (origin?: string): boolean => {
  if (!origin) return true; // allow non-browser clients (ESP32, Postman, curl)
  if (
    origin === env.CLIENT_ORIGIN ||
    origin.includes('localhost') ||
    origin.includes('127.0.0.1')
  ) {
    return true;
  }
  // Match private LAN IP ranges with optional port
  const lanRegex = /^https?:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;
  return lanRegex.test(origin);
};
