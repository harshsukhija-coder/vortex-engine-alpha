import { floorBillableMinutes } from './billing-duration.js';

const MINUTE_IN_MS = 60_000;
const AUTO_ADJUST_EXCEPTION_MINUTES = 15;

interface ResolveTerminationTimingInput {
  actualStartTime: Date;
  requestedEndTime: Date;
  scheduledDurationHours: number;
  autoAdjustEndTime: boolean;
}

export function resolveTerminationTiming({
  actualStartTime,
  requestedEndTime,
  scheduledDurationHours,
  autoAdjustEndTime
}: ResolveTerminationTimingInput) {
  const requestedElapsedMs = Math.max(
    0,
    requestedEndTime.getTime() - actualStartTime.getTime()
  );
  const elapsedMinutes = Math.floor(requestedElapsedMs / MINUTE_IN_MS);
  const scheduledMinutes = Math.max(
    0,
    Math.round(scheduledDurationHours * 60)
  );
  const endTimeAutoAdjusted =
    autoAdjustEndTime
    && elapsedMinutes >= AUTO_ADJUST_EXCEPTION_MINUTES
    && scheduledMinutes > 0;

  if (!endTimeAutoAdjusted) {
    const billedMinutes = floorBillableMinutes(requestedElapsedMs);
    return {
      requestedEndTime,
      effectiveEndTime: requestedEndTime,
      elapsedMinutes,
      billedMinutes,
      billedHours: billedMinutes / 60,
      scheduledDurationHours,
      endTimeAutoAdjusted,
      pricingDurationSource: "ACTUAL_FLOORED" as const
    };
  }

  const effectiveEndTime = new Date(
    actualStartTime.getTime() + scheduledMinutes * MINUTE_IN_MS
  );
  return {
    requestedEndTime,
    effectiveEndTime,
    elapsedMinutes,
    billedMinutes: scheduledMinutes,
    billedHours: scheduledMinutes / 60,
    scheduledDurationHours,
    endTimeAutoAdjusted,
    pricingDurationSource: "SCHEDULED" as const
  };
}
