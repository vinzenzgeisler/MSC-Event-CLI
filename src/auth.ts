import { readFile } from 'node:fs/promises';
import { loadBearerToken, loadCognitoClientConfig } from './config.js';
import { CliError, EXIT } from './errors.js';

type FetchLike = typeof fetch;
type ReadLike = (path: string, encoding: 'utf8') => Promise<string>;

const readSecret: ReadLike = (path, encoding) => readFile(path, encoding);

export const loadAccessToken = async (input: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  read?: ReadLike;
  timeoutMs?: number;
} = {}): Promise<string> => {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  const read = input.read ?? readSecret;
  const cognito = loadCognitoClientConfig(env);
  const hasBearer = Boolean(env.MSC_EVENT_TOKEN?.trim() || env.MSC_EVENT_TOKEN_FILE?.trim());
  if (cognito && hasBearer) {
    throw new CliError('MULTIPLE_AUTH_SOURCES', 'Configure either a bearer token or Cognito client credentials, not both.', EXIT.auth);
  }
  if (!cognito) return loadBearerToken(env, read);

  let secret: string;
  try {
    secret = (await read(cognito.clientSecretFile, 'utf8')).trim();
    if (!secret) throw new Error('empty');
  } catch {
    throw new CliError('CLIENT_SECRET_FILE_UNREADABLE', 'The Cognito client secret file cannot be read or is empty.', EXIT.auth);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10000);
  try {
    const body = new URLSearchParams({ grant_type: 'client_credentials', scope: cognito.scope });
    const response = await fetchImpl(cognito.tokenUrl, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        authorization: `Basic ${Buffer.from(`${cognito.clientId}:${secret}`, 'utf8').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body
    });
    if (!response.ok) {
      throw new CliError('COGNITO_TOKEN_REJECTED', `Cognito token request failed with HTTP ${response.status}.`, EXIT.auth);
    }
    const value = await response.json() as Record<string, unknown>;
    const token = typeof value.access_token === 'string' ? value.access_token.trim() : '';
    if (!token || (value.token_type !== undefined && String(value.token_type).toLowerCase() !== 'bearer')) {
      throw new CliError('INVALID_COGNITO_RESPONSE', 'Cognito returned no usable bearer token.', EXIT.auth);
    }
    return token;
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code = error instanceof Error && error.name === 'AbortError' ? 'COGNITO_TOKEN_TIMEOUT' : 'COGNITO_TOKEN_UNREACHABLE';
    throw new CliError(code, 'Cognito token endpoint could not be reached.', EXIT.auth);
  } finally {
    clearTimeout(timer);
  }
};
