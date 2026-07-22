import type { EntryDetailResponse, EntryListItem } from './schemas.js';

export type CompactEntry = {
  ids: { entryId: string; eventId: string; classId: string; driverPersonId: string; vehicleId?: string | null };
  driver: { firstName?: string | null; lastName?: string | null; email?: string | null; orgaCode?: string | null };
  start: { startNumber?: string | null; className: string; vehicle: string };
  status: {
    registration: string;
    acceptance: string;
    confirmationMailSent: boolean;
    confirmationMailVerified: boolean;
  };
  payment: { totalCents: number; paidAmountCents: number; amountOpenCents: number; status: string | null };
  documents: Array<{ id: string; type: string; status: string }>;
  checkin: { idVerified: boolean; techStatus: string };
};

export const compactEntry = (response: EntryDetailResponse): CompactEntry => {
  const entry = response.entry;
  const vehicle = entry.vehicleLabel ?? ([entry.vehicle.make, entry.vehicle.model].filter(Boolean).join(' ') || 'Unbekannt');
  return {
    ids: {
      entryId: entry.ids.entryId,
      eventId: entry.ids.eventId,
      classId: entry.ids.classId,
      driverPersonId: entry.ids.driverPersonId,
      vehicleId: entry.ids.vehicleId ?? null
    },
    driver: {
      firstName: entry.person.driver.firstName ?? null,
      lastName: entry.person.driver.lastName ?? null,
      email: entry.person.driver.email ?? null,
      orgaCode: entry.orgaCode ?? null
    },
    start: { startNumber: entry.startNumberNorm ?? null, className: entry.className, vehicle },
    status: {
      registration: entry.registrationStatus,
      acceptance: entry.acceptanceStatus,
      confirmationMailSent: entry.confirmationMailSent ?? false,
      confirmationMailVerified: entry.confirmationMailVerified ?? false
    },
    payment: {
      totalCents: entry.payment.totalCents,
      paidAmountCents: entry.payment.paidAmountCents,
      amountOpenCents: entry.payment.amountOpenCents,
      status: entry.payment.paymentStatus
    },
    documents: entry.documents.map(({ id, type, status }) => ({ id, type, status })),
    checkin: { idVerified: entry.checkin.checkinIdVerified, techStatus: entry.checkin.techStatus }
  };
};

export const ambiguousCandidate = (entry: EntryListItem) => ({
  driverPersonId: entry.driverPersonId,
  name: [entry.driverFirstName, entry.driverLastName].filter(Boolean).join(' '),
  email: entry.driverEmail,
  orgaCode: entry.orgaCode
});
