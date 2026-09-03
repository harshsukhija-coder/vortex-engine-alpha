import { parseTimeToDate, formatIstTime } from './time.js';

export const SCHEDULE_OPEN_HOUR = 8;
export const SCHEDULE_SLOT_COUNT = 16;

export type SlotStatus = 'AVAILABLE' | 'BOOKED' | 'TENTATIVE' | 'LOCKED' | 'PAST';

export interface OccupiedInterval {
  startTime: Date;
  endTime: Date;
  setupInstanceId: number | null;
  status: 'BOOKED' | 'TENTATIVE' | 'LOCKED';
  bookingId?: number;
  lockedUntil?: Date;
}

export function getOperatingSlots(dateStr: string) {
  const first = parseTimeToDate(dateStr, '08:00 AM');
  return Array.from({ length: SCHEDULE_SLOT_COUNT }, (_, i) => {
    const startTime = new Date(first.getTime() + i * 60 * 60 * 1000);
    const endTime = new Date(first.getTime() + (i + 1) * 60 * 60 * 1000);
    return { startTime, endTime };
  });
}

export function classifySlot(
  slotStart: Date,
  slotEnd: Date,
  occupied: OccupiedInterval[],
  now: Date
): { status: SlotStatus; bookingId?: number } {
  if (slotEnd <= now) {
    return { status: 'PAST' };
  }

  const hits = occupied.filter((item) => item.startTime < slotEnd && item.endTime > slotStart);
  const booked = hits.find((item) => item.status === 'BOOKED');
  if (booked) return { status: 'BOOKED', bookingId: booked.bookingId };
  const tentative = hits.find((item) => item.status === 'TENTATIVE');
  if (tentative) return { status: 'TENTATIVE', bookingId: tentative.bookingId };
  const locked = hits.find((item) => item.status === 'LOCKED');
  if (locked) return { status: 'LOCKED' };
  return { status: 'AVAILABLE' };
}

export function formatSlot(slotStart: Date, slotEnd: Date, occupied: OccupiedInterval[], now: Date) {
  const classified = classifySlot(slotStart, slotEnd, occupied, now);
  return {
    startTime: formatIstTime(slotStart),
    endTime: formatIstTime(slotEnd),
    startTimeIso: slotStart.toISOString(),
    endTimeIso: slotEnd.toISOString(),
    ...classified
  };
}
