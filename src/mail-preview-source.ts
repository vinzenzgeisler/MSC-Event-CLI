import { z } from 'zod';

const email = z.string().trim().email().max(320).refine(
  (value) => !/[\r\n<>]/.test(value),
  'plain source email address required',
);
const subject = z.string().trim().min(1).max(200).refine(
  (value) => !/[\r\n\0]/.test(value),
  'plain source subject required',
);
const structuredSource = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  from: z.union([
    email,
    z.object({ addr: email }).passthrough().transform((value) => value.addr),
  ]),
  replyTo: z.union([
    email,
    z.object({ addr: email }).passthrough().transform((value) => value.addr),
  ]).optional(),
  subject,
}).passthrough();

const MSC_CONTACT_FORM_SUBJECT = 'Neue Nachricht: Nennung Oberlausitzer Dreieck';

export interface ParseMailPreviewSourceOptions {
  trustedSenderIdentity?: string;
}

export interface ParsedMailPreviewSource {
  id: string;
  from: string;
  subject: string;
}

const headerBlock = (preview: string): Map<string, string> => {
  if (Buffer.byteLength(preview, 'utf8') > 2 * 1024 * 1024) {
    throw new Error('mail preview exceeds 2 MiB');
  }
  const lines = preview.replaceAll('\r\n', '\n').split('\n');
  const unfolded: string[] = [];
  for (const line of lines) {
    if (line === '') break;
    if (/^[ \t]/.test(line)) {
      if (unfolded.length === 0) {
        throw new Error('mail preview starts with an invalid folded header');
      }
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
      continue;
    }
    unfolded.push(line);
  }
  const headers = new Map<string, string>();
  for (const line of unfolded) {
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error('mail preview contains an invalid header');
    const name = line.slice(0, separator).trim().toLowerCase();
    if (!/^[a-z0-9-]{1,100}$/.test(name)) {
      throw new Error('mail preview contains an invalid header name');
    }
    if (
      headers.has(name) &&
      (name === 'from' || name === 'reply-to' || name === 'subject')
    ) {
      throw new Error(`mail preview contains duplicate ${name} headers`);
    }
    if (!headers.has(name)) {
      headers.set(name, line.slice(separator + 1).trim());
    }
  }
  return headers;
};

const sourceAddress = (value: string): string => {
  const bracketed = /<([^<>]+)>/.exec(value);
  return email.parse(bracketed?.[1] ?? value);
};

const contactFormReplyAddress = (
  preview: string,
  sourceFrom: string,
  sourceSubject: string,
  trustedSenderIdentity: string | undefined,
): string | undefined => {
  if (
    !trustedSenderIdentity ||
    sourceFrom.toLowerCase() !== trustedSenderIdentity.toLowerCase() ||
    sourceSubject !== MSC_CONTACT_FORM_SUBJECT
  ) {
    return undefined;
  }
  const body = preview.replaceAll('\r\n', '\n').split('\n\n', 2)[1] ?? '';
  const candidates = body
    .split('\n')
    .map((line) => /^E-Mail:\s*(\S+)\s*$/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
  if (candidates.length !== 1) {
    throw new Error('MSC contact form must contain exactly one reply email');
  }
  return email.parse(candidates[0]);
};

/**
 * The installed read-only wrapper intentionally returns an RFC-style preview
 * string instead of a rich object. Reply-To is preferred. The body remains
 * untrusted except for one strictly bounded MSC contact-form reply-address
 * field when From equals the configured account sender and the subject matches.
 */
export const parseMailPreviewSource = (
  value: unknown,
  expectedMessageId: string,
  options: ParseMailPreviewSourceOptions = {},
): ParsedMailPreviewSource => {
  if (typeof value !== 'string') {
    const parsed = structuredSource.parse(value);
    if (parsed.id !== expectedMessageId) {
      throw new Error('mail provider returned a mismatched source message');
    }
    return {
      id: parsed.id,
      from: parsed.replyTo ?? parsed.from,
      subject: parsed.subject,
    };
  }
  const headers = headerBlock(value);
  const from = headers.get('from');
  const replyTo = headers.get('reply-to');
  const sourceSubject = headers.get('subject');
  if (!from || !sourceSubject) {
    throw new Error('mail preview is missing From or Subject');
  }
  const parsedFrom = sourceAddress(from);
  const parsedSubject = subject.parse(sourceSubject);
  return {
    id: expectedMessageId,
    from: replyTo === undefined
      ? contactFormReplyAddress(
        value,
        parsedFrom,
        parsedSubject,
        options.trustedSenderIdentity,
      ) ?? parsedFrom
      : sourceAddress(replyTo),
    subject: parsedSubject,
  };
};
