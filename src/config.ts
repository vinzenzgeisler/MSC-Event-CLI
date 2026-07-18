import { readFile } from 'node:fs/promises';
import { CliError, EXIT } from './errors.js';

export type RuntimeConfig = {
  baseUrl: URL;
  timeoutMs: number;
};

const isLocalHost = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';

export const parseBaseUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError('INVALID_BASE_URL', 'MSC Event API URL is invalid.', EXIT.usage);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError('INVALID_BASE_URL', 'API URL must not contain credentials, query parameters or fragments.', EXIT.usage);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw new CliError('INSECURE_BASE_URL', 'API URL must use HTTPS (HTTP is allowed only for localhost).', EXIT.usage);
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
};

export const loadRuntimeConfig = (input: { baseUrl?: string; env?: NodeJS.ProcessEnv } = {}): RuntimeConfig => {
  const env = input.env ?? process.env;
  const rawBaseUrl = input.baseUrl ?? env.MSC_EVENT_API_URL;
  if (!rawBaseUrl) {
    throw new CliError('MISSING_BASE_URL', 'Set MSC_EVENT_API_URL or pass --base-url.', EXIT.usage);
  }
  const rawTimeout = env.MSC_EVENT_TIMEOUT_MS ?? '10000';
  const timeoutMs = Number.parseInt(rawTimeout, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw new CliError('INVALID_TIMEOUT', 'MSC_EVENT_TIMEOUT_MS must be between 100 and 120000.', EXIT.usage);
  }
  return { baseUrl: parseBaseUrl(rawBaseUrl), timeoutMs };
};

export const loadBearerToken = async (
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string, encoding: 'utf8') => Promise<string> = (path, encoding) => readFile(path, encoding)
): Promise<string> => {
  const direct = env.MSC_EVENT_TOKEN?.trim();
  const file = env.MSC_EVENT_TOKEN_FILE?.trim();
  if (direct && file) {
    throw new CliError('MULTIPLE_TOKEN_SOURCES', 'Set only one of MSC_EVENT_TOKEN or MSC_EVENT_TOKEN_FILE.', EXIT.auth);
  }
  if (direct) {
    return direct;
  }
  if (!file) {
    throw new CliError('MISSING_TOKEN', 'Set MSC_EVENT_TOKEN or MSC_EVENT_TOKEN_FILE for admin commands.', EXIT.auth);
  }
  try {
    const token = (await read(file, 'utf8')).trim();
    if (!token) {
      throw new Error('empty');
    }
    return token;
  } catch {
    throw new CliError('TOKEN_FILE_UNREADABLE', 'The configured token file cannot be read or is empty.', EXIT.auth);
  }
};
