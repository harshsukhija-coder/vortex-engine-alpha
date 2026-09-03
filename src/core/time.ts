export function parseTimeToDate(dateStr: string, timeStr: string): Date {
  let hour = 0;
  let minute = 0;

  const cleanTime = timeStr.trim().toUpperCase();
  const ampmMatch = cleanTime.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (ampmMatch) {
    hour = parseInt(ampmMatch[1], 10);
    minute = parseInt(ampmMatch[2], 10);
    const ampm = ampmMatch[3];
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
  } else {
    const simpleMatch = cleanTime.match(/^(\d{1,2}):(\d{2})$/);
    if (simpleMatch) {
      hour = parseInt(simpleMatch[1], 10);
      minute = parseInt(simpleMatch[2], 10);
    }
  }

  const [year, month, day] = dateStr.split('-').map(Number);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const kolkataStr = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`;
  return new Date(`${kolkataStr}+05:30`);
}

export function todayIst(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export function addDaysIst(dateStr: string, days: number): string {
  const start = parseTimeToDate(dateStr, '12:00 AM');
  const next = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
  return next.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export function formatIstTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata'
  });
}

export function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}
