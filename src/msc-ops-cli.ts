#!/usr/bin/env node
import { Command, CommanderError, Option } from 'commander';
import { MscEventReadonlyProvider } from './event-readonly-provider.js';
import {
  adminQueryOperationSchema,
  type AdminQueryParameters,
} from './admin-query.js';
import type { EventEntryOperation } from './event-approved-action.js';
import { runMailFlowDemo } from './mail-flow-demo-cli.js';
import {
  mscMailAccountSchema,
  type MscMailAccount,
} from './mail-approved-action.js';
import { MscMailReadonlyProvider } from './mail-readonly-provider.js';
import {
  openMscApprovalProposalWriter,
  readOperatorDraftFile,
} from './msc-approval-proposal.js';

const output = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const mail = new MscMailReadonlyProvider();
const event = new MscEventReadonlyProvider();
const positiveInteger = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('positive integer required');
  }
  return parsed;
};
const collect = (value: string, previous: string[]): string[] => [
  ...previous,
  value,
];
const withProposalWriter = async <T>(
  configPath: string,
  use: (writer: Awaited<
    ReturnType<typeof openMscApprovalProposalWriter>
  >['writer']) => Promise<T>,
): Promise<T> => {
  const opened = await openMscApprovalProposalWriter(configPath, {
    event,
    mail,
  });
  try {
    return await use(opened.writer);
  } finally {
    opened.close();
  }
};
const program = new Command()
  .name('msc')
  .description('MSC operations: Nennungstool, Mail und Freigaben')
  .version('0.1.0')
  .showHelpAfterError();

const nennung = program.command('nennung').description('Nennungstool bedienen');
nennung.command('health')
  .description('Verbindung prüfen')
  .action(async () => output(await event.health()));
nennung.command('lookup')
  .description('Nennung suchen')
  .addOption(new Option('--email <value>'))
  .addOption(new Option('--name <value>'))
  .addOption(new Option('--codriver-name <value>'))
  .addOption(new Option('--orga-code <value>'))
  .addOption(new Option('--start-number <value>'))
  .action(async (options: {
    email?: string;
    name?: string;
    codriverName?: string;
    orgaCode?: string;
    startNumber?: string;
  }) => {
    const supplied = [
      ['email', options.email],
      ['name', options.name],
      ['codriver-name', options.codriverName],
      ['orga-code', options.orgaCode],
      ['start-number', options.startNumber],
    ].filter((item): item is [string, string] => Boolean(item[1]));
    if (supplied.length !== 1) {
      throw new Error('genau ein Suchkriterium ist erforderlich');
    }
    output(await event.lookup(
      supplied[0]![0] as
        | 'email'
        | 'name'
        | 'codriver-name'
        | 'orga-code'
        | 'start-number',
      supplied[0]![1],
    ));
  });
nennung.command('detail')
  .description('Eine Nennung anzeigen')
  .requiredOption('--id <uuid>')
  .action(async (options: { id: string }) => output(await event.detail(options.id)));
nennung.command('query')
  .description('Typisierte, rein lesende Admin-Abfrage ausführen')
  .requiredOption('--operation <name>')
  .option('--params-json <json>', 'Abfrageparameter als JSON-Objekt', '{}')
  .action(async (options: { operation: string; paramsJson: string }) => {
    let parameters: AdminQueryParameters;
    try {
      parameters = JSON.parse(options.paramsJson) as AdminQueryParameters;
    } catch {
      throw new Error('params-json muss ein gültiges JSON-Objekt sein');
    }
    output(await event.query(
      adminQueryOperationSchema.parse(options.operation),
      parameters,
    ));
  });
nennung.command('change')
  .description('Schreibende Änderung als persistierte Freigabe vorbereiten')
  .requiredOption('--config <absolute-path>')
  .requiredOption('--id <uuid>')
  .requiredOption('--operation-file <absolute-path>')
  .requiredOption('--idempotency-key <key>')
  .option('--label <label>')
  .option('--ttl-seconds <seconds>', 'Gültigkeit, maximal 3600', positiveInteger)
  .action(async (options: {
    config: string;
    id: string;
    operationFile: string;
    idempotencyKey: string;
    label?: string;
    ttlSeconds?: number;
  }) => {
    const operation = JSON.parse(
      await readOperatorDraftFile(options.operationFile, 32 * 1024),
    ) as EventEntryOperation;
    output(await withProposalWriter(options.config, (writer) =>
      writer.proposeEventEntryChange({
        entryId: options.id,
        operation,
        idempotencyKey: options.idempotencyKey,
        ...(options.label ? { label: options.label } : {}),
        ...(options.ttlSeconds === undefined
          ? {}
          : { ttlSeconds: options.ttlSeconds }),
      })));
  });

const mailCommand = program.command('mail').description('MSC-Mail bedienen');
mailCommand.command('accounts')
  .description('Mailkonten anzeigen')
  .action(async () => output(await mail.accounts()));
mailCommand.command('folders')
  .description('Ordner anzeigen')
  .requiredOption('--account <account>')
  .action(async (options: { account: string }) =>
    output(await mail.folders(mscMailAccountSchema.parse(options.account))));
mailCommand.command('list')
  .description('Mails auflisten')
  .requiredOption('--account <account>')
  .option('--folder <folder>', 'Mailordner', 'INBOX')
  .action(async (options: { account: string; folder: string }) =>
    output(await mail.list(
      mscMailAccountSchema.parse(options.account),
      options.folder,
    )));
mailCommand.command('read')
  .description('Eine Mail als sichere Vorschau lesen')
  .requiredOption('--account <account>')
  .option('--folder <folder>', 'Mailordner', 'INBOX')
  .requiredOption('--message-id <id>')
  .action(async (options: {
    account: string;
    folder: string;
    messageId: string;
  }) => output(await mail.preview(
    mscMailAccountSchema.parse(options.account) as MscMailAccount,
    options.folder,
    options.messageId,
  )));
mailCommand.command('reply')
  .description('Bearbeitete Antwort als persistierte Freigabe vorbereiten')
  .requiredOption('--config <absolute-path>')
  .requiredOption('--account <account>')
  .option('--folder <folder>', 'Mailordner', 'INBOX')
  .requiredOption('--message-id <id>')
  .requiredOption('--body-file <absolute-path>')
  .requiredOption('--source <reference>', 'Bestätigte Quelle', collect, [])
  .option('--uncertainty <text>', 'Offene Unsicherheit', collect, [])
  .requiredOption('--idempotency-key <key>')
  .option('--ttl-seconds <seconds>', 'Gültigkeit, maximal 3600', positiveInteger)
  .action(async (options: {
    config: string;
    account: string;
    folder: string;
    messageId: string;
    bodyFile: string;
    source: string[];
    uncertainty: string[];
    idempotencyKey: string;
    ttlSeconds?: number;
  }) => {
    const bodyText = await readOperatorDraftFile(options.bodyFile);
    output(await withProposalWriter(options.config, (writer) =>
      writer.proposeMailReply({
        account: mscMailAccountSchema.parse(options.account),
        folder: options.folder,
        messageId: options.messageId,
        bodyText,
        sources: options.source,
        uncertainties: options.uncertainty,
        idempotencyKey: options.idempotencyKey,
        ...(options.ttlSeconds === undefined
          ? {}
          : { ttlSeconds: options.ttlSeconds }),
      })));
  });

const approval = program.command('approval').description('Freigaben bedienen');
approval.command('demo')
  .description('Den vollständigen Mail-Freigabeflow lokal demonstrieren')
  .action(async () => output(await runMailFlowDemo()));

program.exitOverride();
try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError &&
      (error.code === 'commander.helpDisplayed' ||
       error.code === 'commander.version')) {
    process.exitCode = 0;
  } else {
    process.stderr.write(`${JSON.stringify({
      error: error instanceof Error ? error.message : 'ungültiger Aufruf',
    })}\n`);
    process.exitCode = 2;
  }
}
