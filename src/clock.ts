export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Controllable clock for tests and demos. */
export class ManualClock implements Clock {
  t: number;
  constructor(start: number) {
    this.t = start;
  }
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}
