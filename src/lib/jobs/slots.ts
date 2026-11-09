import type { PhisAddonJobInterval, PhisAddonJobSchedule } from "@phis/contracts/addon";

/**
 * The moments a schedule names, computed from the clock alone.
 *
 * No state is read here. Every instance of Core runs this on its own clock and arrives at the same
 * moment, because every step divides the hour or the day and the moment is the latest one at or before
 * now: `5m` at 09:17 is 09:15 on every host whose clock is right. The scheduler then claims that moment
 * by inserting a row keyed on it, and the database admits one claim. Missed moments are never listed --
 * the latest one is the only one computed -- which is the catch-up policy: after a week down, a daily job
 * runs once, not seven times.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const STEP_MS: Record<PhisAddonJobInterval, number> = {
  "5m": 5 * MINUTE_MS,
  "15m": 15 * MINUTE_MS,
  "30m": 30 * MINUTE_MS,
  hourly: HOUR_MS,
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
};

export const PHI_JOB_TIME_PATTERN = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** The step of a schedule in milliseconds, which is also how long one of its runs may last at most. */
export function resolvePhiJobStepMs(every: PhisAddonJobInterval): number {
  return STEP_MS[every];
}

/** Whether a step is shorter than an hour, which decides how long its successful runs are kept. */
export function isPhiJobStepSubHourly(every: PhisAddonJobInterval): boolean {
  return STEP_MS[every] < HOUR_MS;
}

function readTime(at: string | undefined): { hours: number; minutes: number } {
  const match = at === undefined ? null : PHI_JOB_TIME_PATTERN.exec(at);
  if (!match) {
    return { hours: 0, minutes: 0 };
  }
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

function isoWeekday(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * The latest moment of `schedule` at or before `now`.
 *
 * The short steps and the hour fall out of the epoch, which starts at midnight UTC, so flooring the
 * epoch milliseconds aligns them with the clock. The day and the week carry a time and a weekday and
 * are walked back from today until the moment is not in the future.
 */
export function resolvePhiJobSlot(schedule: PhisAddonJobSchedule, now: Date): Date {
  const step = STEP_MS[schedule.every];
  if (schedule.every !== "daily" && schedule.every !== "weekly") {
    return new Date(Math.floor(now.getTime() / step) * step);
  }
  const { hours, minutes } = readTime(schedule.at);
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hours,
    minutes,
  ));
  if (schedule.every === "daily") {
    return candidate.getTime() > now.getTime() ? new Date(candidate.getTime() - DAY_MS) : candidate;
  }
  const weekday = schedule.weekday ?? 1;
  const back = (isoWeekday(candidate) - weekday + 7) % 7;
  const onWeekday = new Date(candidate.getTime() - back * DAY_MS);
  return onWeekday.getTime() > now.getTime() ? new Date(onWeekday.getTime() - 7 * DAY_MS) : onWeekday;
}
