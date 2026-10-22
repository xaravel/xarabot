import { expect, test } from "bun:test";
import { err, ok, type Result } from "../../src/core/result.ts";
import { runContract } from "./run-contract.ts";

/** A toy port showing how a real port's contract suite is shaped. */
type Counter = {
  increment(): Promise<number>;
  read(): Promise<number>;
  set(expected: number, next: number): Promise<Result<number, "conflict">>;
};

function memoryCounter(): Counter {
  let n = 0;
  return {
    increment: async () => ++n,
    read: async () => n,
    set: async (expected, next) => {
      if (n !== expected) return err("conflict", `expected ${expected}, found ${n}`);
      n = next;
      return ok(n);
    },
  };
}

function mapCounter(): Counter {
  const store = new Map<string, number>([["n", 0]]);
  const get = (): number => store.get("n") ?? 0;
  return {
    increment: async () => {
      store.set("n", get() + 1);
      return get();
    },
    read: async () => get(),
    set: async (expected, next) => {
      const current = get();
      if (current !== expected) return err("conflict", `expected ${expected}, found ${current}`);
      store.set("n", next);
      return ok(next);
    },
  };
}

runContract<Counter>(
  "Counter",
  [
    { name: "memory", make: memoryCounter },
    { name: "map", make: mapCounter },
  ],
  (make) => {
    test("starts at zero", async () => {
      const c = await make();
      expect(await c.read()).toBe(0);
    });

    test("increment returns the new value", async () => {
      const c = await make();
      expect(await c.increment()).toBe(1);
      expect(await c.increment()).toBe(2);
      expect(await c.read()).toBe(2);
    });

    test("compare-and-set succeeds on a match and conflicts otherwise", async () => {
      const c = await make();
      expect(await c.set(0, 5)).toEqual(ok(5));
      const stale = await c.set(0, 6);
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.kind).toBe("conflict");
      expect(await c.read()).toBe(5);
    });
  },
);
