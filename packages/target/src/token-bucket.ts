/**
 * A minimal token bucket, replacing the `limiter` npm package.
 *
 * Refills are lazy: no timer runs in the background, tokens are credited from
 * the elapsed wall clock the moment someone asks for them. That matters in a
 * service worker, where a periodic timer would keep the worker alive (or be
 * killed and silently stop refilling).
 */

export type TokenBucketInterval = 'second' | 'minute' | 'hour' | 'day' | number;

const INTERVAL_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

export class TokenBucket {
  readonly bucketSize: number;
  readonly tokensPerInterval: number;
  /** Length of one refill interval, in milliseconds. */
  readonly interval: number;
  /** Tokens currently available. Fractional between drips. */
  content: number;
  private lastDrip: number;

  constructor(
    bucketSize: number,
    tokensPerInterval: number,
    interval: TokenBucketInterval = 'second',
    _parent: unknown = null,
  ) {
    this.bucketSize = bucketSize;
    this.tokensPerInterval = tokensPerInterval;
    const ms = typeof interval === 'number' ? interval : INTERVAL_MS[interval];
    if (!ms || ms < 0) throw new Error(`Invalid interval ${String(interval)}`);
    this.interval = ms;
    // Start full. `limiter` started empty, which under MV2 cost one refill wait
    // per browser session; under MV3 the worker is recycled constantly, so that
    // would delay the first write after every wake-up for no benefit.
    this.content = bucketSize;
    this.lastDrip = Date.now();
  }

  /** Credit the tokens accrued since the last drip, capped at bucketSize. */
  private drip(): void {
    if (!this.tokensPerInterval) {
      this.content = this.bucketSize;
      return;
    }
    const now = Date.now();
    const elapsed = Math.max(now - this.lastDrip, 0);
    this.lastDrip = now;
    const dripped = elapsed * (this.tokensPerInterval / this.interval);
    this.content = Math.min(this.content + dripped, this.bucketSize);
  }

  /** Take `count` tokens if that many are available right now. */
  tryRemoveTokens(count: number): boolean {
    if (count > this.bucketSize) return false;
    this.drip();
    if (count > this.content) return false;
    this.content -= count;
    return true;
  }

  /** Take `count` tokens, waiting for them to accrue when the bucket is short. */
  async removeTokens(count: number): Promise<void> {
    if (count > this.bucketSize) {
      throw new Error(`Requested tokens ${count} exceeds bucket size ${this.bucketSize}`);
    }
    while (!this.tryRemoveTokens(count)) {
      const wait = Math.ceil((count - this.content) * (this.interval / this.tokensPerInterval));
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  }

  /** Drop every token, forcing a full wait before the next removal succeeds. */
  clear(): void {
    this.drip();
    this.content = 0;
  }
}

export default TokenBucket;
