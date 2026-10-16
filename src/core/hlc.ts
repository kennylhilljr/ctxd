/**
 * Hybrid logical clock (SPEC section 5).
 *
 * Encoded as a fixed-width, lexicographically sortable string:
 *   <physical ms, 13 hex digits>-<counter, 4 hex digits>-<node_id>
 */

const PHYSICAL_WIDTH = 13;
const COUNTER_WIDTH = 4;
const COUNTER_MAX = 0xffff;

export interface HlcParts {
  physical: number;
  counter: number;
  node: string;
}

export function encodeHlc({ physical, counter, node }: HlcParts): string {
  return [
    physical.toString(16).padStart(PHYSICAL_WIDTH, "0"),
    counter.toString(16).padStart(COUNTER_WIDTH, "0"),
    node,
  ].join("-");
}

export function decodeHlc(value: string): HlcParts {
  const first = value.indexOf("-");
  const second = value.indexOf("-", first + 1);
  if (first !== PHYSICAL_WIDTH || second !== PHYSICAL_WIDTH + 1 + COUNTER_WIDTH) {
    throw new Error(`Invalid HLC: ${value}`);
  }
  return {
    physical: parseInt(value.slice(0, first), 16),
    counter: parseInt(value.slice(first + 1, second), 16),
    node: value.slice(second + 1),
  };
}

/** Total order: physical, then counter, then node id. Fixed widths make string order correct. */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class HlcClock {
  private physical = 0;
  private counter = 0;

  constructor(
    private readonly node: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Timestamp for a local event. */
  tick(): string {
    const wall = this.now();
    if (wall > this.physical) {
      this.physical = wall;
      this.counter = 0;
    } else {
      this.bump();
    }
    return this.current();
  }

  /** Merge a remote timestamp, then return a timestamp for the receive event. */
  receive(remote: string): string {
    const r = decodeHlc(remote);
    const wall = this.now();
    const maxPhysical = Math.max(wall, this.physical, r.physical);
    if (maxPhysical === this.physical && maxPhysical === r.physical) {
      this.counter = Math.max(this.counter, r.counter);
      this.bump();
    } else if (maxPhysical === this.physical) {
      this.bump();
    } else if (maxPhysical === r.physical) {
      this.physical = r.physical;
      this.counter = r.counter;
      this.bump();
    } else {
      this.physical = maxPhysical;
      this.counter = 0;
    }
    return this.current();
  }

  private bump(): void {
    if (this.counter >= COUNTER_MAX) {
      this.physical += 1;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
  }

  private current(): string {
    return encodeHlc({ physical: this.physical, counter: this.counter, node: this.node });
  }
}
