import { z } from 'zod';
import { CliError, EXIT } from './errors.js';

const uuid = z.string().uuid();
const shortText = z.string().trim().min(1).max(320)
  .refine((value) => !/[\r\n\0]/.test(value), 'invalid text');
const cursor = z.string().trim().min(1).max(2048)
  .refine((value) => !/[\r\n\0]/.test(value), 'invalid cursor');
const limit = z.coerce.number().int().min(1).max(100);
const boolean = z.union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => String(value));
const sortDir = z.enum(['asc', 'desc']);

type ParamSchema = z.ZodType<string | number, z.ZodTypeDef, unknown>;
type QuerySpec = {
  path: string;
  pathParams?: Record<string, ParamSchema>;
  query?: Record<string, ParamSchema>;
  requiredQuery?: readonly string[];
};

const entryFilters: Record<string, ParamSchema> = {
  eventId: uuid,
  q: shortText,
  classId: uuid,
  acceptanceStatus: shortText,
  registrationStatus: shortText,
  paymentStatus: shortText,
  checkinIdVerified: boolean,
  techStatus: shortText,
  cursor,
  limit,
  sortBy: shortText,
  sortDir,
};

export const adminQuerySpecs = {
  'dashboard.summary': {
    path: '/admin/dashboard/summary',
    query: { eventId: uuid },
    requiredQuery: ['eventId'],
  },
  'dashboard.driver-locations': {
    path: '/admin/dashboard/driver-locations',
    query: { eventId: uuid },
    requiredQuery: ['eventId'],
  },
  'events.list': { path: '/admin/events' },
  'events.get': {
    path: '/admin/events/{id}',
    pathParams: { id: uuid },
  },
  'events.classes': {
    path: '/admin/events/{id}/classes',
    pathParams: { id: uuid },
  },
  'events.current': { path: '/admin/events/current' },
  'entries.list': {
    path: '/admin/entries',
    query: entryFilters,
    requiredQuery: ['eventId'],
  },
  'entries.deleted': {
    path: '/admin/entries/deleted',
    query: entryFilters,
    requiredQuery: ['eventId'],
  },
  'entries.get': {
    path: '/admin/entries/{id}',
    pathParams: { id: uuid },
  },
  'entries.checkin': {
    path: '/admin/checkin/entries',
    query: entryFilters,
    requiredQuery: ['eventId'],
  },
  'pricing.get': {
    path: '/admin/events/{id}/pricing-rules',
    pathParams: { id: uuid },
  },
  'invoices.list': {
    path: '/admin/invoices',
    query: {
      eventId: uuid,
      entryId: uuid,
      status: shortText,
      cursor,
      limit,
      sortBy: shortText,
      sortDir,
    },
  },
  'invoices.payments': {
    path: '/admin/invoices/{id}/payments',
    pathParams: { id: uuid },
    query: { cursor, limit, sortBy: shortText, sortDir },
  },
  'exports.list': {
    path: '/admin/exports',
    query: { eventId: uuid, cursor, limit, sortBy: shortText, sortDir },
    requiredQuery: ['eventId'],
  },
  'exports.get': {
    path: '/admin/exports/{id}',
    pathParams: { id: uuid },
  },
  'mail.outbox': {
    path: '/admin/mail/outbox',
    query: {
      eventId: uuid,
      status: shortText,
      cursor,
      limit,
      sortBy: shortText,
      sortDir,
    },
  },
  'mail.templates': { path: '/admin/mail/templates' },
  'mail.template-versions': {
    path: '/admin/mail/templates/{key}/versions',
    pathParams: { key: shortText },
  },
  'mail.template-placeholders': {
    path: '/admin/mail/templates/{key}/placeholders',
    pathParams: { key: shortText },
  },
  'mail.recipients': {
    path: '/admin/mail/recipients/search',
    query: {
      eventId: uuid,
      q: shortText,
      classId: uuid,
      acceptanceStatus: shortText,
      paymentStatus: shortText,
      limit,
    },
    requiredQuery: ['eventId'],
  },
  'iam.roles': { path: '/admin/iam/roles' },
  'iam.users': {
    path: '/admin/iam/users',
    query: { q: shortText, cursor, limit },
  },
} as const satisfies Record<string, QuerySpec>;

export type AdminQueryOperation = keyof typeof adminQuerySpecs;
export type AdminQueryParameters = Record<string, unknown>;

export const adminQueryOperationSchema = z.enum(
  Object.keys(adminQuerySpecs) as [AdminQueryOperation, ...AdminQueryOperation[]],
);

const parseParam = (
  schema: ParamSchema,
  value: unknown,
  name: string,
): string => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CliError(
      'INVALID_ADMIN_QUERY',
      `Invalid parameter: ${name}.`,
      EXIT.usage,
    );
  }
  return String(parsed.data);
};

export const buildAdminQueryPath = (
  operationInput: string,
  parametersInput: AdminQueryParameters = {},
): string => {
  const operation = adminQueryOperationSchema.safeParse(operationInput);
  if (!operation.success) {
    throw new CliError(
      'UNKNOWN_ADMIN_QUERY',
      'Unknown admin query operation.',
      EXIT.usage,
    );
  }
  const spec: QuerySpec = adminQuerySpecs[operation.data];
  const parameters = z.record(z.unknown()).parse(parametersInput);
  const allowed = new Set([
    ...Object.keys(spec.pathParams ?? {}),
    ...Object.keys(spec.query ?? {}),
  ]);
  const unknown = Object.keys(parameters).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new CliError(
      'INVALID_ADMIN_QUERY',
      `Unexpected parameter: ${unknown[0]}.`,
      EXIT.usage,
    );
  }

  let path = spec.path;
  for (const [name, schema] of Object.entries(spec.pathParams ?? {})) {
    if (!(name in parameters)) {
      throw new CliError(
        'INVALID_ADMIN_QUERY',
        `Missing parameter: ${name}.`,
        EXIT.usage,
      );
    }
    path = path.replace(`{${name}}`, encodeURIComponent(
      parseParam(schema, parameters[name], name),
    ));
  }

  const search = new URLSearchParams();
  for (const required of spec.requiredQuery ?? []) {
    if (!(required in parameters)) {
      throw new CliError(
        'INVALID_ADMIN_QUERY',
        `Missing parameter: ${required}.`,
        EXIT.usage,
      );
    }
  }
  for (const [name, schema] of Object.entries(spec.query ?? {})) {
    if (!(name in parameters) || parameters[name] === undefined) continue;
    search.set(name, parseParam(schema, parameters[name], name));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
};

export const isAdminQueryPath = (pathAndQuery: string): boolean => {
  try {
    const candidate = new URL(pathAndQuery, 'https://allowlist.invalid');
    return Object.entries(adminQuerySpecs).some(([operation, rawSpec]) => {
      const spec: QuerySpec = rawSpec;
      const pathNames = [...spec.path.matchAll(/\{([^}]+)\}/g)]
        .map((match) => match[1]!);
      const expression = new RegExp(`^${spec.path.replace(
        /\{[^}]+\}/g,
        '([^/]+)',
      )}$`);
      const match = candidate.pathname.match(expression);
      if (!match) return false;
      const parameters: AdminQueryParameters = Object.fromEntries(
        pathNames.map((name, index) => [
          name,
          decodeURIComponent(match[index + 1]!),
        ]),
      );
      for (const [name, value] of candidate.searchParams.entries()) {
        parameters[name] = value;
      }
      try {
        return buildAdminQueryPath(operation, parameters) ===
          `${candidate.pathname}${candidate.search}`;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
};
