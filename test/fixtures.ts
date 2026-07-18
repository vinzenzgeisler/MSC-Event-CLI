import type { EntryDetailResponse } from '../src/schemas.js';

export const detailFixture = (entryId = '10000000-0000-4000-8000-000000000001'): EntryDetailResponse => ({
  ok: true,
  entry: {
    ids: {
      entryId,
      eventId: '20000000-0000-4000-8000-000000000002',
      classId: '30000000-0000-4000-8000-000000000003',
      driverPersonId: '40000000-0000-4000-8000-000000000004',
      vehicleId: '50000000-0000-4000-8000-000000000005'
    },
    className: 'Classic',
    registrationStatus: 'submitted_verified',
    acceptanceStatus: 'accepted',
    startNumberNorm: '42',
    orgaCode: '11OLD-7K4P9',
    vehicleLabel: 'KTM EXC',
    confirmationMailSent: true,
    confirmationMailVerified: true,
    person: {
      driver: {
        firstName: 'Max',
        lastName: 'Musterfahrer',
        email: 'max@example.org',
        street: 'Must not leave the API client',
        phone: 'Must not leave the API client'
      }
    },
    vehicle: { make: 'KTM', model: 'EXC', ownerName: 'Sensitive owner' },
    payment: { totalCents: 10000, paidAmountCents: 2000, amountOpenCents: 8000, paymentStatus: 'due' },
    checkin: { checkinIdVerified: false, techStatus: 'pending', techCheckedBy: 'hidden' },
    documents: [{ id: '60000000-0000-4000-8000-000000000006', type: 'waiver', status: 'received', createdAt: 'hidden' }],
    internalNote: 'hidden'
  },
  history: [{ payload: 'hidden' }]
});
