import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  mscMailAccountPolicySchema,
} from './mail-approved-action.js';
import type { MscMailProductionCompositionOptions } from './msc-mail-production-composition.js';

const privateIpv4 = (address: string): boolean => {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every(
    (part) => Number.isInteger(part) && part >= 0 && part <= 255,
  ) && (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 127
  );
};

const exactHttpsOrigin = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'publicOrigin must be an exact HTTPS origin',
    });
  }
});

const absolutePath = z.string().min(1).refine(isAbsolute, 'absolute path required');
const email = z.string().trim().email().max(320);
const account = z.enum(['msc-nennung', 'msc-info', 'msc-vorstand']);
const configSchema = z.object({
  version: z.literal(1),
  stateDatabasePath: absolutePath,
  encryptionKeyFile: absolutePath,
  signingKeyFile: absolutePath,
  sessionCsrfKeyFile: absolutePath,
  publicOrigin: exactHttpsOrigin,
  basePath: z.string().regex(/^\/[a-z0-9][a-z0-9._~-]*$/),
  rpId: z.string().trim().min(1).max(253),
  reviewerActor: z.string().trim().min(1).max(128),
  trustedProxyAddresses: z.array(z.string().refine(
    (value) => isIP(value) > 0,
    'trusted proxy must be an exact IP',
  )).min(1).max(16),
  trustConfiguredActorWithoutHeader: z.boolean().default(false),
  bindInterface: z.string().regex(/^[a-zA-Z0-9_.:-]{1,32}$/),
  port: z.number().int().min(1).max(65_535),
  workerIntervalMs: z.number().int().min(1_000).max(300_000),
  workerId: z.string().trim().min(1).max(200),
  messageIdDomain: z.string().trim().min(1).max(253),
  mailPolicy: mscMailAccountPolicySchema,
  smtpAccounts: z.array(z.object({
    account,
    host: z.string().trim().min(1).max(253),
    port: z.union([z.literal(465), z.literal(587)]),
    secure: z.boolean(),
    username: email,
    passwordFile: absolutePath,
    senderIdentity: email,
  }).strict()).min(1).max(3),
}).strict();

export type MscMailProductionConfig = z.infer<typeof configSchema>;

const readTrustedFile = async (
  path: string,
  ownerUid: number,
  forbiddenMode: number,
  maxBytes: number,
): Promise<Buffer> => {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== ownerUid ||
        (stat.mode & forbiddenMode) !== 0 || stat.size > maxBytes) {
      throw new Error('trusted production file failed ownership, mode or size validation');
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const decodeKey = (value: Buffer): Buffer => {
  const text = value.toString('utf8').trim();
  const decoded = /^[a-f0-9]{64}$/i.test(text)
    ? Buffer.from(text, 'hex')
    : Buffer.from(text, 'base64url');
  if (decoded.byteLength !== 32) {
    throw new Error('production key must contain exactly 32 bytes');
  }
  return decoded;
};

export const resolvePrivateInterfaceAddress = (
  interfaceName: string,
  interfaces = networkInterfaces(),
): string => {
  const candidates = (interfaces[interfaceName] ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
    .filter(privateIpv4);
  if (candidates.length !== 1) {
    throw new Error('bind interface must expose exactly one private IPv4 address');
  }
  return candidates[0]!;
};

export const loadMscMailProductionOptions = async (
  configPath: string,
  options: {
    configOwnerUid?: number;
    secretOwnerUid?: number;
  } = {},
): Promise<MscMailProductionCompositionOptions> => {
  if (!isAbsolute(configPath)) {
    throw new Error('production config path must be absolute');
  }
  const configOwnerUid = options.configOwnerUid ?? 0;
  const secretOwnerUid = options.secretOwnerUid ?? process.getuid?.() ?? 0;
  const config = configSchema.parse(JSON.parse(
    (await readTrustedFile(configPath, configOwnerUid, 0o037, 128 * 1024))
      .toString('utf8'),
  ));
  const [encryptionKey, signingKey, sessionCsrfKey, ...passwords] =
    await Promise.all([
      readTrustedFile(config.encryptionKeyFile, secretOwnerUid, 0o077, 256)
        .then(decodeKey),
      readTrustedFile(config.signingKeyFile, secretOwnerUid, 0o077, 256)
        .then(decodeKey),
      readTrustedFile(config.sessionCsrfKeyFile, secretOwnerUid, 0o077, 256)
        .then(decodeKey),
      ...config.smtpAccounts.map((smtp) =>
        readTrustedFile(smtp.passwordFile, secretOwnerUid, 0o077, 4_096)
          .then((value) => value.toString('utf8').trimEnd())),
    ]);
  return {
    stateDatabasePath: config.stateDatabasePath,
    encryptionKey,
    signingKey,
    sessionCsrfKey,
    publicOrigin: config.publicOrigin,
    basePath: config.basePath,
    rpId: config.rpId,
    reviewerActor: config.reviewerActor,
    trustedProxyAddresses: config.trustedProxyAddresses,
    trustConfiguredActorWithoutHeader:
      config.trustConfiguredActorWithoutHeader,
    bindAddress: resolvePrivateInterfaceAddress(config.bindInterface),
    port: config.port,
    workerIntervalMs: config.workerIntervalMs,
    workerId: config.workerId,
    messageIdDomain: config.messageIdDomain,
    mailPolicy: config.mailPolicy,
    smtpAccounts: config.smtpAccounts.map((smtp, index) => ({
      account: smtp.account,
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      username: smtp.username,
      password: passwords[index]!,
      senderIdentity: smtp.senderIdentity,
    })),
  };
};
