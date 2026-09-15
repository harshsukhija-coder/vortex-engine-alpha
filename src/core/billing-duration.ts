const MINUTE_IN_MS = 60_000;
const MINUTES_PER_HOUR = 60;

export function floorBillableMinutes(elapsedMs: number): number {
  const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / MINUTE_IN_MS));
  const completedHours = Math.floor(elapsedMinutes / MINUTES_PER_HOUR);
  const remainingMinutes = elapsedMinutes % MINUTES_PER_HOUR;

  const billableRemainder = remainingMinutes < 15
    ? 0
    : remainingMinutes < 30
      ? 15
      : 30;

  return completedHours * MINUTES_PER_HOUR + billableRemainder;
}
