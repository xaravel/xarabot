/**
 * The return shape of every fallible core function (AR35). Core never throws:
 * it returns `ok(value)` or `err(kind, message)`.
 */
export type Result<T, K extends string = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly kind: K; readonly message: string } };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function err<K extends string>(
  kind: K,
  message: string,
): { readonly ok: false; readonly error: { readonly kind: K; readonly message: string } } {
  return { ok: false, error: { kind, message } };
}
