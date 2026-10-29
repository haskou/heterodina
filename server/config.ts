import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  plexUrl: string;
  plexToken: string;
  /** Library title as shown in Plex; matched ignoring case and accents. */
  plexLibrary: string;
  /** Interface to listen on: loopback by default, 0.0.0.0 in a container. */
  host: string;
  port: number;
}

/** Variables already in the environment win; `.env` only fills the gaps, if it exists. */
export function loadConfig(envFile = '.env'): Config {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;
  const plexToken = env.PLEX_TOKEN?.trim();
  const plexUrl = env.PLEX_URL?.trim();
  const missing = [!plexUrl && 'PLEX_URL', !plexToken && 'PLEX_TOKEN'].filter(Boolean);
  if (!plexUrl || !plexToken) {
    const file = existsSync(envFile) ? `${resolve(envFile)} has none either` : `no ${resolve(envFile)} found`;
    throw new Error(`${missing.join(' and ')} missing: not in the environment, and ${file}`);
  }
  return {
    plexUrl: plexUrl.replace(/\/+$/, ''),
    plexToken,
    plexLibrary: env.PLEX_LIBRARY?.trim() || 'Music',
    host: env.HOST?.trim() || '127.0.0.1',
    port: Number(env.API_PORT ?? 5174),
  };
}
