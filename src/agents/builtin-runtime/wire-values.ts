/**
 * Per-turn identity codec. Host-owned messages/tools/models return as opaque
 * references, preserving WeakMap provenance and rejecting fabricated references.
 * No function, registry, credential object, or prototype crosses this boundary.
 */
const hostReference = Symbol("builtin-runtime-host-reference");
type ReferenceObject = { [hostReference]?: number };
type WireValue =
  | null
  | boolean
  | number
  | string
  | { kind: "undefined" }
  | { kind: "array" | "set"; values: WireValue[] }
  | { kind: "object"; entries: [string, WireValue][]; ref?: number };
const MAX_VALUES = 200_000;
export class WireValues {
  private next = 0;
  private readonly projections = new Map<number, object>();
  private readonly originals = new Map<number, object>();
  private readonly references = new WeakMap<object, { id: number; projection: object }>();
  constructor(private readonly owner: "host" | "runtime") {}
  bind(value: object, projection: object = value): void {
    if (this.owner !== "host" || this.references.has(value)) {
      return;
    }
    const id = ++this.next;
    if (id > MAX_VALUES) {
      throw new Error("Runtime reference budget exceeded");
    }
    this.references.set(value, { id, projection });
    this.originals.set(id, value);
  }
  owns(value: object): boolean {
    return this.references.has(value);
  }
  /** Native messages gain a host reference only after Gateway persistence acknowledges them. */
  adoptReference(value: object, acknowledged: object): void {
    const ref = hostReference in acknowledged ? acknowledged[hostReference] : undefined;
    if (this.owner !== "runtime" || typeof ref !== "number" || hostReference in value) {
      throw new Error("Invalid native message acknowledgement");
    }
    // Finalization may replace/remove tool blocks. Synchronize canonical content before attaching identity.
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(acknowledged, key)) {
        Reflect.deleteProperty(value, key);
      }
    }
    Object.assign(value, acknowledged);
    Object.defineProperty(value, hostReference, { value: ref, enumerable: true });
    this.projections.set(ref, value);
  }
  encode(value: unknown, preserveReferences = true): WireValue {
    let count = 0;
    const visit = (item: unknown, depth: number): WireValue => {
      if (++count > MAX_VALUES || depth > 100) {
        throw new Error("Runtime value budget exceeded");
      }
      if (item === undefined) {
        return { kind: "undefined" };
      }
      if (item === null || typeof item === "string" || typeof item === "boolean") {
        return item;
      }
      if (typeof item === "number" && Number.isFinite(item)) {
        return item;
      }
      if (typeof item !== "object") {
        throw new Error("Non-data runtime value");
      }
      if (Array.isArray(item)) {
        return { kind: "array", values: item.map((v) => visit(v, depth + 1)) };
      }
      if (item instanceof Set) {
        return { kind: "set", values: [...item].map((v) => visit(v, depth + 1)) };
      }
      if (
        preserveReferences &&
        this.owner === "host" &&
        ("role" in item || item instanceof Error)
      ) {
        this.bind(item, item instanceof Error ? { message: "Host operation failed" } : item);
      }
      const reference = preserveReferences ? this.references.get(item) : undefined;
      const marker = hostReference in item ? item[hostReference] : undefined;
      const ref = preserveReferences
        ? (reference?.id ?? (typeof marker === "number" ? marker : undefined))
        : undefined;
      if (this.owner === "runtime" && ref !== undefined) {
        return { kind: "object", entries: [], ref };
      }
      const source = reference?.projection ?? item;
      const entries = Object.entries(source).map(([key, v]): [string, WireValue] => {
        if (["__proto__", "constructor", "prototype"].includes(key)) {
          throw new Error("Invalid runtime value key");
        }
        return [key, visit(v, depth + 1)];
      });
      return { kind: "object", entries, ...(ref === undefined ? {} : { ref }) };
    };
    return visit(value, 0);
  }
  decode(value: unknown): unknown {
    let count = 0;
    const visit = (item: unknown, depth: number): unknown => {
      if (++count > MAX_VALUES || depth > 100) {
        throw new Error("Runtime value budget exceeded");
      }
      if (item === null || typeof item === "string" || typeof item === "boolean") {
        return item;
      }
      if (typeof item === "number" && Number.isFinite(item)) {
        return item;
      }
      if (!item || typeof item !== "object" || Array.isArray(item) || !("kind" in item)) {
        throw new Error("Invalid runtime value");
      }
      if (item.kind === "undefined") {
        return undefined;
      }
      if (
        (item.kind === "array" || item.kind === "set") &&
        "values" in item &&
        Array.isArray(item.values)
      ) {
        const values = item.values.map((v) => visit(v, depth + 1));
        return item.kind === "set" ? new Set(values) : values;
      }
      if (item.kind !== "object" || !("entries" in item) || !Array.isArray(item.entries)) {
        throw new Error("Invalid runtime object");
      }
      const ref = "ref" in item ? item.ref : undefined;
      if (
        ref !== undefined &&
        (typeof ref !== "number" || !Number.isSafeInteger(ref) || ref <= 0)
      ) {
        throw new Error("Invalid runtime reference");
      }
      if (ref !== undefined && this.owner === "host") {
        const original = this.originals.get(ref);
        if (!original) {
          throw new Error("Unknown or stale runtime reference");
        }
        return original;
      }
      const result: Record<string, unknown> & ReferenceObject = {};
      for (const entry of item.entries) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== "string" ||
          ["__proto__", "constructor", "prototype"].includes(entry[0]) ||
          Object.hasOwn(result, entry[0])
        ) {
          throw new Error("Invalid runtime object entry");
        }
        result[entry[0]] = visit(entry[1], depth + 1);
      }
      if (typeof ref === "number") {
        const existing = this.projections.get(ref);
        if (existing) {
          for (const key of Object.keys(existing)) {
            Reflect.deleteProperty(existing, key);
          }
          Object.assign(existing, result);
          return existing;
        }
        if (this.projections.size >= MAX_VALUES) {
          throw new Error("Runtime reference budget exceeded");
        }
        Object.defineProperty(result, hostReference, { value: ref, enumerable: true });
        this.projections.set(ref, result);
      }
      return result;
    };
    return visit(value, 0);
  }
}
