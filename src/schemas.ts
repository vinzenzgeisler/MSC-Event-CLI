import { z } from 'zod';

export const EventSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.string()
}).passthrough();

export const CurrentEventResponseSchema = z.object({ ok: z.boolean(), event: EventSchema });

export const EntryListItemSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  classId: z.string().uuid(),
  driverPersonId: z.string().uuid(),
  className: z.string(),
  registrationStatus: z.string(),
  acceptanceStatus: z.string(),
  paymentStatus: z.string().nullable().optional(),
  startNumberNorm: z.string().nullable(),
  orgaCode: z.string().nullable(),
  driverFirstName: z.string().nullable(),
  driverLastName: z.string().nullable(),
  driverEmail: z.string().nullable(),
  vehicleLabel: z.string().nullable().optional(),
  confirmationMailSent: z.boolean().optional(),
  confirmationMailVerified: z.boolean().optional()
}).passthrough();

export const EntriesResponseSchema = z.object({
  ok: z.boolean(),
  entries: z.array(EntryListItemSchema),
  meta: z.object({ hasMore: z.boolean().optional(), nextCursor: z.string().nullable().optional() }).passthrough()
});

const NullableString = z.string().nullable().optional();
const PersonSchema = z.object({ firstName: NullableString, lastName: NullableString, email: NullableString }).passthrough();

export const EntryDetailResponseSchema = z.object({
  ok: z.boolean(),
  entry: z.object({
    ids: z.object({
      entryId: z.string().uuid(),
      eventId: z.string().uuid(),
      classId: z.string().uuid(),
      driverPersonId: z.string().uuid(),
      vehicleId: z.string().uuid().nullable().optional()
    }).passthrough(),
    className: z.string(),
    registrationStatus: z.string(),
    acceptanceStatus: z.string(),
    startNumberNorm: NullableString,
    orgaCode: NullableString,
    vehicleLabel: NullableString,
    confirmationMailSent: z.boolean().optional(),
    confirmationMailVerified: z.boolean().optional(),
    person: z.object({ driver: PersonSchema }).passthrough(),
    vehicle: z.object({ make: NullableString, model: NullableString }).passthrough(),
    payment: z.object({
      totalCents: z.number().int(),
      paidAmountCents: z.number().int(),
      amountOpenCents: z.number().int(),
      paymentStatus: z.string().nullable()
    }),
    checkin: z.object({ checkinIdVerified: z.boolean(), techStatus: z.string() }).passthrough(),
    documents: z.array(z.object({ id: z.string().uuid(), type: z.string(), status: z.string() }).passthrough())
  }).passthrough(),
  history: z.array(z.unknown())
});

export type EntryListItem = z.infer<typeof EntryListItemSchema>;
export type EntryDetailResponse = z.infer<typeof EntryDetailResponseSchema>;
