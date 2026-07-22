export const EXIT = {
  ok: 0,
  unexpected: 1,
  notFound: 2,
  ambiguous: 3,
  usage: 4,
  auth: 5,
  api: 6
} as const;

export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;

  constructor(code: string, message: string, exitCode: number) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export const safeError = (error: unknown): { error: { code: string; message: string } } => {
  if (error instanceof CliError) {
    return { error: { code: error.code, message: error.message } };
  }
  return { error: { code: 'UNEXPECTED', message: 'Unexpected CLI failure.' } };
};
