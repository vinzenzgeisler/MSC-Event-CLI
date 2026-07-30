/**
 * Self-deploy module: triggers an OpenClaw update+restart via Docker socket.
 *
 * The Docker socket must be mounted read-only at /var/run/docker.sock (or the
 * path given by DOCKER_HOST). The compose project name must match the actual
 * deployment (default: "openclaw"). This module never touches any data files;
 * it only issues one `docker compose up -d --no-deps openclaw` call, which
 * causes Docker to pull the latest image and restart only the openclaw service.
 *
 * Usage from msc-ops-cli.ts:
 *   msc deploy openclaw [--project <name>] [--compose-file <path>]
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SelfDeployOptions {
  /** Docker Compose project name (default: "openclaw") */
  projectName?: string;
  /** Path to docker-compose.yml (optional; Docker uses the current directory default) */
  composeFile?: string;
  /** Timeout in milliseconds (default: 120_000) */
  timeoutMs?: number;
  /** Dry-run: print the command instead of running it */
  dryRun?: boolean;
}

export interface SelfDeployResult {
  service: string;
  command: string;
  stdout: string;
  stderr: string;
  dryRun: boolean;
}

/**
 * Runs `docker compose up -d --no-deps <service>` to update and restart a
 * single service without affecting other services in the stack.
 */
export const selfDeploy = async (
  service: string,
  options: SelfDeployOptions = {},
): Promise<SelfDeployResult> => {
  const {
    projectName = 'openclaw',
    composeFile,
    timeoutMs = 120_000,
    dryRun = false,
  } = options;

  const args: string[] = [
    'compose',
    '--project-name', projectName,
    ...(composeFile ? ['--file', composeFile] : []),
    'up',
    '--detach',
    '--no-deps',
    service,
  ];

  const command = `docker ${args.join(' ')}`;

  if (dryRun) {
    return { service, command, stdout: '', stderr: '', dryRun: true };
  }

  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync('docker', args, {
      timeout: timeoutMs,
      env: {
        ...process.env,
        // Explicitly clear DOCKER_HOST override only when not set already
      },
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error: unknown) {
    const execError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    const diagnostics = [
      execError.stderr?.trim() || execError.stdout?.trim() || execError.message,
    ].filter(Boolean).join('\n');
    throw new Error(
      `docker compose up failed for service "${service}": ${diagnostics}`,
    );
  }
  return { service, command, stdout, stderr, dryRun: false };
};
