// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 Manuel Wechner (Berth)

// Time source for the fetchers. Production uses the system clock; tests use a manual clock so that
// throttling and Retry-After can be checked without waiting.

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

// A clock that only moves when someone sleeps on it. Each sleep advances the time at once.
export class ManualClock implements Clock {
  private t: number;
  constructor(start = Date.parse('2026-10-24T03:00:00Z')) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    if (ms > 0) this.t += ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
