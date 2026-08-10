/**
 * Logging helpers.
 *
 * Call tracing (`Log.method`) is off by default. The CoffeeScript version ran
 * it on every storage operation, and because it pretty-prints its subject with
 * `JSON.stringify(..., 4)` that meant serialising the whole options object on
 * every read and write. It is now opt-in via {@link setTracing}.
 */

const SECRET_KEYS = new Set(['username', 'password', 'host', 'port']);

function replacer(key: string, value: unknown): unknown {
  return SECRET_KEYS.has(key) ? '<secret>' : value;
}

let tracing = false;

export interface Logger {
  str(obj: unknown): string;
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  func(name: string, args: ArrayLike<unknown>): void;
  method(name: string, self: unknown, args: ArrayLike<unknown>): void;
}

/** Enable or disable call tracing. */
export function setTracing(enabled: boolean): void {
  tracing = enabled;
}

export function isTracing(): boolean {
  return tracing;
}

export const Log: Logger = {
  /** Pretty-print a value, redacting keys with privacy implications. */
  str(obj: unknown): string {
    if (typeof obj === 'object' && obj !== null) {
      const debugStr = (obj as { debugStr?: unknown }).debugStr;
      if (debugStr !== undefined) {
        return typeof debugStr === 'function' ? String(debugStr.call(obj)) : String(debugStr);
      }
      if (obj instanceof Error) {
        return obj.stack || obj.message;
      }
      return JSON.stringify(obj, replacer, 4);
    }
    if (typeof obj === 'function') {
      return obj.name ? `<f: ${obj.name}>` : obj.toString();
    }
    return '' + obj;
  },

  log(...args: unknown[]): void {
    console.log(...args);
  },

  error(...args: unknown[]): void {
    console.error(...args);
  },

  func(name: string, args: ArrayLike<unknown>): void {
    if (!tracing) return;
    this.log(name, '(', Array.prototype.slice.call(args), ')');
  },

  method(name: string, self: unknown, args: ArrayLike<unknown>): void {
    if (!tracing) return;
    this.log(this.str(self), '<<', name, Array.prototype.slice.call(args));
  },
};

export default Log;
