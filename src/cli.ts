#!/usr/bin/env node
import { Command, CommanderError, Option } from 'commander';
import { MscEventApi } from './api.js';
import { loadAccessToken } from './auth.js';
import { loadRuntimeConfig } from './config.js';
import { CliError, EXIT, safeError } from './errors.js';
import { parseSearchSpec } from './lookup.js';
import {
  adminQueryOperationSchema,
  type AdminQueryParameters,
} from './admin-query.js';
import { parseFormat, renderOutput, type OutputFormat } from './output.js';
import { SupportService } from './service.js';

type CommonOptions = { baseUrl?: string; format: OutputFormat };

const common = (command: Command): Command => command
  .option('--base-url <url>', 'MSC Event API base URL (or MSC_EVENT_API_URL)')
  .addOption(new Option('--format <format>', 'output format').choices(['json', 'text']).default('json'));

const service = async (options: CommonOptions, auth: boolean): Promise<SupportService> => {
  const config = loadRuntimeConfig(options.baseUrl ? { baseUrl: options.baseUrl } : {});
  const token = auth ? await loadAccessToken({ timeoutMs: config.timeoutMs }) : undefined;
  return new SupportService(new MscEventApi(token ? { ...config, token } : config));
};

const write = (value: unknown, format: OutputFormat): void => {
  process.stdout.write(`${renderOutput(value, format)}\n`);
};

const program = new Command().name('msc-event').description('Read-only MSC Event support CLI').version('0.1.0');
program.showHelpAfterError();

common(program.command('health').description('Check the MSC Event API'))
  .action(async (options: CommonOptions) => write(await (await service(options, false)).health(), options.format));

common(program.command('lookup').description('Find registrations in the current event'))
  .option('--orga-code <code>')
  .option('--email <email>')
  .option('--name <name>')
  .option('--codriver-name <name>')
  .option('--start-number <number>')
  .option('--full', 'include all detail fields returned by the backend', false)
  .action(async (options: CommonOptions & { orgaCode?: string; email?: string; name?: string; codriverName?: string; startNumber?: string; full: boolean }) => {
    const spec = parseSearchSpec(options);
    const result = await (await service(options, true)).lookup(spec, options.full);
    write(result, options.format);
    if (result.status === 'not_found') process.exitCode = EXIT.notFound;
    if (result.status === 'ambiguous') process.exitCode = EXIT.ambiguous;
  });

common(program.command('admin-query').description('Run a typed read-only admin query'))
  .requiredOption('--operation <name>')
  .option('--params-json <json>', 'Typed query parameters', '{}')
  .action(async (options) => {
    let parameters: AdminQueryParameters;
    try {
      parameters = JSON.parse(options.paramsJson) as AdminQueryParameters;
    } catch {
      throw new CliError('INVALID_ADMIN_QUERY', 'Admin query parameters must be valid JSON.', EXIT.usage);
    }
    const runtime = await service(options, true);
    write(await runtime.adminQuery(
      adminQueryOperationSchema.parse(options.operation),
      parameters,
    ), options.format);
  });

common(program.command('detail').description('Show one registration detail'))
  .requiredOption('--id <uuid>', 'entry UUID')
  .option('--full', 'include all detail fields returned by the backend', false)
  .action(async (options: CommonOptions & { id: string; full: boolean }) =>
    write(await (await service(options, true)).detail(options.id, options.full), options.format));

program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError && (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')) {
    process.exitCode = EXIT.ok;
  } else {
    const normalized = error instanceof CliError
      ? error
      : new CliError('USAGE_ERROR', error instanceof Error ? error.message : 'Invalid command.', EXIT.usage);
    process.stderr.write(`${JSON.stringify(safeError(normalized))}\n`);
    process.exitCode = normalized.exitCode;
  }
}
