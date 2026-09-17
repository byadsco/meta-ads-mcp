const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_NODES = 4000;
const DEFAULT_MAX_STRING = 4000;
const DEFAULT_MAX_KEYS = 200;
const DEFAULT_MAX_KEY_CHARS = 128;
const DEFAULT_MAX_TOTAL_CHARS = 200_000;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface BoundedCloneOptions {
  maxDepth?: number;
  maxNodes?: number;
  maxString?: number;
  maxKeys?: number;
  maxKeyChars?: number;
  maxTotalChars?: number;
}

/**
 * JSON-safe copy under depth, node, key and character budgets. Every visited
 * value (null included) spends one node; property names count as characters
 * and are truncated instead of copied when huge; enumeration stops as soon as
 * a budget or the key cap is hit. Untrusted records can neither overflow the
 * stack in JSON.stringify nor dominate CPU, memory or output. Omitted parts
 * are replaced by a marker string.
 */
export function boundedClone(value: unknown, options: BoundedCloneOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxString = options.maxString ?? DEFAULT_MAX_STRING;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const maxKeyChars = options.maxKeyChars ?? DEFAULT_MAX_KEY_CHARS;
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  let budget = options.maxNodes ?? DEFAULT_MAX_NODES;
  let chars = 0;
  const spend = (n: number): boolean => {
    chars += n;
    return chars <= maxTotalChars;
  };
  const visit = (v: unknown, depth: number): unknown => {
    if (budget-- <= 0) return "[omitted: budget]";
    if (v === undefined || v === null) return v;
    if (typeof v === "string") {
      const kept = v.length > maxString ? v.slice(0, maxString) + " [truncated]" : v;
      return spend(kept.length) ? kept : "[omitted: size budget]";
    }
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v !== "object") return String(v);
    if (depth >= maxDepth) return "[omitted: too deep]";
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        if (i >= maxKeys || budget <= 0 || chars > maxTotalChars) {
          out.push("[omitted: " + (v.length - i) + " more]");
          break;
        }
        out.push(visit(v[i], depth + 1));
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const k in v as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(v, k) || UNSAFE_KEYS.has(k)) continue;
      if (n++ >= maxKeys || budget <= 0 || chars > maxTotalChars) {
        out["[omitted]"] = "more keys";
        break;
      }
      const key = k.length > maxKeyChars ? k.slice(0, 32) + "…[key truncated]" : k;
      if (!spend(key.length)) {
        out["[omitted]"] = "size budget";
        break;
      }
      out[key] = visit((v as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  };
  return visit(value, 0);
}
