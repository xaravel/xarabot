import { describe } from "bun:test";

export type ContractImpl<T> = {
  readonly name: string;
  readonly make: () => T | Promise<T>;
};

/**
 * Runs one contract suite against every implementation of a port, one
 * `describe` block per implementation. The suite gets a factory so each test
 * can build a fresh instance.
 */
export function runContract<T>(
  name: string,
  impls: readonly ContractImpl<T>[],
  suite: (make: () => T | Promise<T>) => void,
): void {
  for (const impl of impls) {
    describe(`${name} contract: ${impl.name}`, () => {
      suite(impl.make);
    });
  }
}
