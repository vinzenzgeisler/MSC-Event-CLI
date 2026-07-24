import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  PasskeyBootstrapService,
  type PasskeyBootstrapGrantStore,
} from './passkey-bootstrap.js';
import { SqliteWebAuthnStore } from './webauthn-sqlite.js';

const operatorConfigSchema = z.object({
  version: z.literal(1),
  stateDatabasePath: z.string().min(1),
  allowedOperatorUids: z.array(z.number().int().nonnegative()).min(1).max(20),
  allowedActors: z.array(z.string().trim().min(1).max(128)).min(1).max(20),
  bootstrapTtlSeconds: z.number().int().min(30).max(15 * 60).default(10 * 60),
}).strict().superRefine((config, context) => {
  if (!isAbsolute(config.stateDatabasePath)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stateDatabasePath'],
      message: 'state database path must be absolute',
    });
  }
});

export type PasskeyBootstrapOperatorConfig = z.infer<typeof operatorConfigSchema>;

export interface PasskeyBootstrapOperatorDependencies {
  currentUid(): number | undefined;
  loadConfig(path: string): Promise<PasskeyBootstrapOperatorConfig>;
  createGrantStore(path: string): PasskeyBootstrapGrantStore & {
    listByActor(actor: string): Promise<unknown[]>;
    close(): void;
  };
  writeOutput(value: string): void;
}

export interface LoadTrustedOperatorConfigOptions {
  expectedOwnerUid?: number;
}

/**
 * Opens, verifies and reads the local operator policy through one descriptor.
 * The production default requires a root-owned regular file, permits at most
 * group-read access, and refuses symlinks through O_NOFOLLOW.
 */
export const loadTrustedOperatorConfig = async (
  path: string,
  options: LoadTrustedOperatorConfigOptions = {},
): Promise<PasskeyBootstrapOperatorConfig> => {
  if (!isAbsolute(path)) throw new Error('operator config path must be absolute');
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('operator config must be a regular file');
    const expectedOwnerUid = options.expectedOwnerUid ?? 0;
    if (stat.uid !== expectedOwnerUid) {
      throw new Error(`operator config must be owned by uid ${expectedOwnerUid}`);
    }
    if ((stat.mode & 0o037) !== 0) {
      throw new Error(
        'operator config may be group-readable but must not be group-writable or world-accessible',
      );
    }
    return operatorConfigSchema.parse(
      JSON.parse(await handle.readFile({ encoding: 'utf8' })),
    );
  } finally {
    await handle.close();
  }
};

const parseArguments = (argv: string[]): { configPath: string; actor: string } => {
  let configPath: string | undefined;
  let actor: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`missing value for ${name ?? 'argument'}`);
    if (name === '--config' && configPath === undefined) configPath = value;
    else if (name === '--actor' && actor === undefined) actor = value;
    else throw new Error(`unknown or duplicate argument ${name}`);
  }
  if (!configPath || !actor) {
    throw new Error('--config and --actor are required');
  }
  return { configPath, actor: actor.trim() };
};

export const runPasskeyBootstrapOperator = async (
  argv: string[],
  dependencies: PasskeyBootstrapOperatorDependencies = {
    currentUid: () => process.getuid?.(),
    loadConfig: (path) => loadTrustedOperatorConfig(path),
    createGrantStore: (path) => new SqliteWebAuthnStore(path),
    writeOutput: (value) => process.stdout.write(value),
  },
): Promise<void> => {
  const { configPath, actor } = parseArguments(argv);
  const uid = dependencies.currentUid();
  if (uid === undefined) {
    throw new Error('local OS-user identity is unavailable');
  }
  const config = await dependencies.loadConfig(configPath);
  if (!config.allowedOperatorUids.includes(uid)) {
    throw new Error('local OS user is not authorized to issue bootstrap codes');
  }
  if (!config.allowedActors.includes(actor)) {
    throw new Error('requested reviewer actor is not allowlisted');
  }

  const store = dependencies.createGrantStore(config.stateDatabasePath);
  try {
    if ((await store.listByActor(actor)).length !== 0) {
      throw new Error('initial passkey already exists for requested reviewer');
    }
    const bootstrap = new PasskeyBootstrapService({
      grants: store,
      ttlSeconds: config.bootstrapTtlSeconds,
    });
    const issued = await bootstrap.issue(actor, {
      operatorId: `uid:${uid}`,
      authenticationMethod: 'local-os-user',
    });
    dependencies.writeOutput(`${JSON.stringify({
      actor: issued.actor,
      code: issued.code,
      expiresAt: issued.expiresAt,
      warning: 'Show once. Do not copy into logs or chat.',
    })}\n`);
  } finally {
    store.close();
  }
};
