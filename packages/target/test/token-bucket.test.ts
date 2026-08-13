/**
 * Token bucket: starts full (MIGRATION.md deliberate change), lazy refill,
 * and the wait / overflow paths used by OptionsSync.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenBucket } from '../src/token-bucket.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('TokenBucket', () => {
  it('starts full rather than empty', () => {
    const bucket = new TokenBucket(10, 10, 'minute');
    expect(bucket.content).toBe(10);
    expect(bucket.tryRemoveTokens(10)).toBe(true);
    expect(bucket.content).toBe(0);
  });

  it('refuses a request larger than the bucket', async () => {
    const bucket = new TokenBucket(2, 2, 'second');
    expect(bucket.tryRemoveTokens(3)).toBe(false);
    expect(bucket.content).toBe(2);
    await expect(bucket.removeTokens(3)).rejects.toThrow(/exceeds bucket size/);
  });

  it('credits tokens from elapsed wall clock', () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket(4, 4, 1000);
    expect(bucket.tryRemoveTokens(4)).toBe(true);
    expect(bucket.tryRemoveTokens(1)).toBe(false);
    vi.advanceTimersByTime(500);
    expect(bucket.tryRemoveTokens(2)).toBe(true);
    expect(bucket.content).toBeCloseTo(0);
  });

  it('removeTokens waits until a drip covers the request', async () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket(1, 1, 1000);
    expect(bucket.tryRemoveTokens(1)).toBe(true);
    const pending = bucket.removeTokens(1);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(bucket.content).toBe(0);
  });

  it('clear forces a full wait before the next take', () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket(5, 5, 1000);
    bucket.clear();
    expect(bucket.content).toBe(0);
    expect(bucket.tryRemoveTokens(1)).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(bucket.tryRemoveTokens(5)).toBe(true);
  });

  it('rejects an invalid interval', () => {
    expect(() => new TokenBucket(1, 1, 'nope' as 'second')).toThrow(/Invalid interval/);
  });

  it('treats a zero drip rate as "always full"', () => {
    const bucket = new TokenBucket(3, 0, 'second');
    expect(bucket.tryRemoveTokens(3)).toBe(true);
    expect(bucket.tryRemoveTokens(3)).toBe(true);
  });
});
