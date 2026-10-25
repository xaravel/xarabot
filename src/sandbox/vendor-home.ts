import { chmodSync, closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../core/result.ts";
import type { LaunchCredential, Vendor } from "../ports/sandbox.ts";
import { configDir, type LaunchingEnv } from "./environment.ts";

/**
 * The vendor home (AR18): emptied and re-seeded from the operator's
 * credential file before every session, so nothing a session leaves there
 * survives into the next. The credential file lives at
 * `<config>/xarabot/vendors/<vendor>/<file>`, must be a regular file of mode
 * 600 and must not be empty. Every failure names the file, never its contents.
 */

const CREDENTIAL_MODE = 0o600;

/** A plain file name: no separator, not `.` or `..`, no NUL. */
export function isPlainFileName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");
}

export function credentialPath(launching: LaunchingEnv, vendor: Vendor, file: string): Result<string, "refused"> {
  if (!isPlainFileName(file)) return err("refused", `credential: ${JSON.stringify(file)} is not a plain file name`);
  const config = configDir(launching);
  if (config === null) return err("refused", "credential: neither XDG_CONFIG_HOME nor HOME is set");
  return ok(join(config, "xarabot", "vendors", vendor, file));
}

function errCode(e: unknown): string {
  if (e !== null && typeof e === "object" && typeof (e as { code?: unknown }).code === "string") return (e as { code: string }).code;
  return "unreadable";
}

/** Reads a credential file after checking it is a regular, non-empty, mode-600 file. */
export function readCredential(path: string): Result<string, "refused"> {
  // One descriptor for the checks and the read, so the file can't be swapped in between.
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT") return err("refused", `credential ${path}: missing`);
    if (code === "ELOOP") return err("refused", `credential ${path}: not a regular file`);
    // Mode 000 can't be opened; report its mode when it can be read.
    try {
      const mode = lstatSync(path).mode & 0o777;
      if (mode !== CREDENTIAL_MODE) return err("refused", `credential ${path}: mode ${mode.toString(8).padStart(3, "0")}, must be 600`);
    } catch {
      // Fall through to the open error.
    }
    return err("refused", `credential ${path}: cannot read (${code})`);
  }
  let text: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return err("refused", `credential ${path}: not a regular file`);
    const mode = st.mode & 0o777;
    if (mode !== CREDENTIAL_MODE) {
      return err("refused", `credential ${path}: mode ${mode.toString(8).padStart(3, "0")}, must be 600`);
    }
    text = readFileSync(fd, "utf8");
  } catch (e) {
    return err("refused", `credential ${path}: cannot read (${errCode(e)})`);
  } finally {
    closeSync(fd);
  }
  if (text.trim() === "") return err("refused", `credential ${path}: empty`);
  return ok(text);
}

/** Gives every directory under `path` (not following symlinks) u+rwx, so a session's mode-000 folder can't block removal. */
function unlockTree(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  chmodSync(path, (st.mode & 0o777) | 0o700);
  for (const entry of readdirSync(path)) unlockTree(join(path, entry));
}

/** Removes `path` and everything below it, whatever modes a session left; a missing path is fine. */
export function removeTree(path: string): void {
  unlockTree(path);
  rmSync(path, { recursive: true, force: true });
}

/** Removes everything inside `dir`, creating it (mode 700) when missing. */
export function emptyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  unlockTree(dir);
  for (const entry of readdirSync(dir)) removeTree(join(dir, entry));
}

export type SeedParams = {
  readonly launching: LaunchingEnv;
  readonly vendor: Vendor;
  /** Absent for a repo command the runner starts (AR19): nothing is read or seeded. */
  readonly credential?: LaunchCredential;
  readonly vendorHome: string;
  /** Keep the vendor home's contents (a resume of the same session); default `false`. */
  readonly keep?: boolean;
};

/** The env-mode credential variable, when there is one. */
export type Seeded = { readonly env?: { readonly name: string; readonly value: string } };

/**
 * Reads and checks the credential, then empties the vendor home. In
 * `homeFile` mode it writes the credential to `<vendorHome>/<homeFile>` with
 * mode 600; in `env` mode the home stays empty and the trimmed credential is
 * returned for the variable. With `keep`, the home is not emptied (a resume
 * needs the session's transcript); a `homeFile` is still rewritten.
 *
 * With no credential (a repo command the runner starts, AR19) it only
 * empties the home (or keeps it): it reads no credential file, so a missing
 * one is no error, writes no home file and returns no variable.
 */
export function seedVendorHome(params: SeedParams): Result<Seeded, "refused"> {
  const credential = params.credential;
  let text: string | null = null;
  if (credential !== undefined) {
    const path = credentialPath(params.launching, params.vendor, credential.file);
    if (!path.ok) return path;
    if ("homeFile" in credential && !isPlainFileName(credential.homeFile)) {
      return err("refused", `credential: home file ${JSON.stringify(credential.homeFile)} is not a plain file name`);
    }
    const read = readCredential(path.value);
    if (!read.ok) return read;
    text = read.value;
  }
  try {
    if (params.keep === true) {
      mkdirSync(params.vendorHome, { recursive: true, mode: 0o700 });
      unlockTree(params.vendorHome);
    } else {
      emptyDir(params.vendorHome);
    }
    if (credential === undefined || text === null) return ok({});
    if ("homeFile" in credential) {
      const target = join(params.vendorHome, credential.homeFile);
      // On a resume the session may have left anything at this name: replace it.
      if (params.keep === true) removeTree(target);
      // Create it 600 from the start; chmod again in case the umask cleared more.
      closeSync(openSync(target, "wx", CREDENTIAL_MODE));
      chmodSync(target, CREDENTIAL_MODE);
      writeFileSync(target, text);
      return ok({});
    }
    return ok({ env: { name: credential.env, value: text.trim() } });
  } catch (e) {
    return err("refused", `vendor home ${params.vendorHome}: cannot re-seed (${errCode(e)})`);
  }
}
