import type { Socket, TCPSocketListener } from "bun";
import { isGitHubHost, isHostname, isIpLiteral, isLocalhost, normalizeHost } from "../core/network/hosts.ts";
import { err, ok, type Result } from "../core/result.ts";

/**
 * Xarabot's own CONNECT proxy (FR18, NFR8, AR40, AD-17). Seatbelt filters by
 * address and port only, so this proxy is the session's only hostname
 * boundary: it tunnels `CONNECT` to an allowlisted hostname on an allowed
 * port and nothing else. It never forwards plain HTTP, and it refuses a
 * GitHub host, an IP literal or `localhost` on every request, whatever its
 * allowlist holds.
 */

/** The most a request head may take, terminator included. */
export const MAX_HEAD_BYTES = 8 * 1024;
/** How long a connection has to send its request head. */
export const HEAD_TIMEOUT_MS = 10_000;
export const DEFAULT_PORTS: readonly number[] = [443];

export type ProxyOpts = {
  /** Allowed hostnames, as `buildAllowlist` returns them. */
  readonly allow: readonly string[];
  /** Allowed upstream ports; default `[443]`. */
  readonly ports?: readonly number[];
  /** The address to connect to for an allowed host; default the host itself. For tests. */
  readonly dial?: (host: string) => string | Promise<string>;
  /**
   * Called with every complete request head's first line and the decision on
   * it, before the proxy answers. A hook that throws is ignored.
   */
  readonly onRequest?: (line: string, decision: ConnectDecision) => void;
};

export type Proxy = {
  readonly port: number;
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** Closes the listener and every open socket. */
  stop(): void;
};

export type DenyStatus = 400 | 403 | 405;

export type ConnectDecision =
  | { readonly allow: true; readonly host: string; readonly port: number }
  | { readonly allow: false; readonly status: DenyStatus; readonly reason: string };

function deny(status: DenyStatus, reason: string): ConnectDecision {
  return { allow: false, status, reason };
}

function isPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * The decision for one request head (its text, terminator optional). Only
 * `CONNECT host:port HTTP/1.x` to an allowed hostname and port passes.
 */
export function decideConnect(head: string, allow: readonly string[], ports: readonly number[]): ConnectDecision {
  const parts = firstLine(head).split(" ");
  if (parts[0] !== "CONNECT") return deny(405, `method ${JSON.stringify(parts[0] ?? "")} is not CONNECT`);
  if (parts.length !== 3 || !/^HTTP\/1\.[01]$/.test(parts[2] as string)) return deny(400, "malformed request line");
  const authority = parts[1] as string;
  const m = /^\[([^\]]*)\]:(\d{1,5})$/.exec(authority) ?? /^([^:[\]]+):(\d{1,5})$/.exec(authority);
  if (m === null) return deny(400, `unparseable authority ${JSON.stringify(authority)}`);
  const host = normalizeHost(m[1] as string);
  const port = Number(m[2]);
  if (!isPort(port)) return deny(400, `bad port in ${JSON.stringify(authority)}`);
  if (m[0].startsWith("[") || isIpLiteral(host)) return deny(403, `${JSON.stringify(host)} is an IP literal`);
  if (!isHostname(host)) return deny(400, `${JSON.stringify(host)} is not a hostname`);
  if (isGitHubHost(host)) return deny(403, `${JSON.stringify(host)} is a GitHub host`);
  if (isLocalhost(host)) return deny(403, `${JSON.stringify(host)} is localhost`);
  if (!allow.includes(host)) return deny(403, `${JSON.stringify(host)} is not on the allowlist`);
  if (!ports.includes(port)) return deny(403, `port ${port} is not allowed`);
  return { allow: true, host, port };
}

/** A head's first line, without its line ending. */
export function firstLine(head: string): string {
  const nl = head.indexOf("\n");
  return (nl === -1 ? head : head.slice(0, nl)).replace(/\r$/, "");
}

const REASONS: Readonly<Record<number, string>> = {
  400: "Bad Request",
  403: "Forbidden",
  405: "Method Not Allowed",
  431: "Request Header Fields Too Large",
  502: "Bad Gateway",
};

function statusBytes(status: number): Uint8Array {
  return new TextEncoder().encode(`HTTP/1.1 ${status} ${REASONS[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

const ESTABLISHED = new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n");

/** One socket of a tunnel: the client's, or the upstream's. */
type Side = {
  socket: Socket<Side> | null;
  peer: Side | null;
  /** Bytes still to be written to this socket. */
  pending: Uint8Array | null;
  /** End this socket once `pending` is written. */
  ending: boolean;
  closed: boolean;
  /** Client only: reading the head, dialling, tunnelling, or answered. */
  phase: "head" | "dialing" | "open" | "done";
  head: Uint8Array;
  /** Client only: bytes that arrived while dialling. */
  early: Uint8Array[];
  timer: ReturnType<typeof setTimeout> | undefined;
};

function newSide(): Side {
  return { socket: null, peer: null, pending: null, ending: false, closed: false, phase: "open", head: new Uint8Array(0), early: [], timer: undefined };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** The end of the head (index after its blank line), or -1. */
function headEnd(buf: Uint8Array): number {
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== 0x0a) continue;
    if (buf[i + 1] === 0x0a) return i + 2;
    if (buf[i + 1] === 0x0d && buf[i + 2] === 0x0a) return i + 3;
  }
  return -1;
}

/** Writes to `to`, buffering what doesn't fit and pausing `from` until `to` drains. */
function send(to: Side, data: Uint8Array, from: Side | null): void {
  if (to.closed || to.socket === null || data.length === 0) return;
  if (to.pending !== null) {
    to.pending = concat(to.pending, data);
    from?.socket?.pause();
    return;
  }
  const n = to.socket.write(data);
  if (n < data.length) {
    to.pending = data.slice(Math.max(n, 0));
    from?.socket?.pause();
  }
}

/** Ends `side` now, or once its pending bytes are written. */
function finish(side: Side): void {
  if (side.closed || side.socket === null) return;
  if (side.pending !== null) {
    side.ending = true;
    return;
  }
  side.closed = true;
  side.socket.end();
}

function flush(side: Side): void {
  if (side.closed || side.socket === null || side.pending === null) return;
  const data = side.pending;
  const n = side.socket.write(data);
  if (n < data.length) {
    side.pending = data.slice(Math.max(n, 0));
    return;
  }
  side.pending = null;
  if (side.ending) finish(side);
  else side.peer?.socket?.resume();
}

function respond(side: Side, status: number): void {
  side.phase = "done";
  clearTimeout(side.timer);
  send(side, statusBytes(status), null);
  finish(side);
}

/**
 * Starts a proxy on `127.0.0.1`, port 0. Refuses (`invalid`) an allowlist
 * holding a GitHub host, an IP literal or `localhost`, and a bad port list;
 * `unavailable` when it cannot listen.
 */
export function startProxy(opts: ProxyOpts): Result<Proxy> {
  const allow = opts.allow.map(normalizeHost);
  for (const host of allow) {
    if (isGitHubHost(host) || isIpLiteral(host) || isLocalhost(host) || !isHostname(host)) return err("invalid", `proxy: ${JSON.stringify(host)} may not be allowed`);
  }
  const ports = opts.ports ?? DEFAULT_PORTS;
  if (ports.length === 0 || !ports.every(isPort)) return err("invalid", `proxy: bad ports ${JSON.stringify(ports)}`);
  const dial = opts.dial ?? ((host: string): string | Promise<string> => host);
  const sockets = new Set<Socket<Side>>();
  let stopped = false;

  function closed(side: Side): void {
    side.closed = true;
    clearTimeout(side.timer);
    if (side.socket !== null) sockets.delete(side.socket);
    if (side.phase === "head" || side.phase === "dialing") side.phase = "done";
    if (side.peer !== null) finish(side.peer);
  }

  async function tunnel(client: Side, host: string, port: number): Promise<void> {
    const upstream = newSide();
    let socket: Socket<Side>;
    try {
      socket = await Bun.connect<Side>({
        hostname: await dial(host),
        port,
        data: upstream,
        socket: {
          data: (s, data) => {
            if (s.data.peer !== null) send(s.data.peer, data, s.data);
          },
          drain: (s) => flush(s.data),
          end: (s) => closed(s.data),
          close: (s) => closed(s.data),
          error: () => {},
        },
      });
    } catch {
      if (client.phase === "dialing" && !client.closed) respond(client, 502);
      return;
    }
    if (stopped || client.closed || client.phase !== "dialing") {
      socket.terminate();
      return;
    }
    sockets.add(socket);
    upstream.socket = socket;
    upstream.peer = client;
    client.peer = upstream;
    client.phase = "open";
    send(client, ESTABLISHED, null);
    for (const chunk of client.early) send(upstream, chunk, client);
    client.early = [];
    if (upstream.pending === null) client.socket?.resume();
  }

  function onClientData(client: Side, data: Uint8Array): void {
    if (client.phase === "open") {
      if (client.peer !== null) send(client.peer, data, client);
      return;
    }
    if (client.phase === "dialing") {
      client.early.push(data.slice());
      // Hold the client back once more than a head's worth is waiting.
      if (client.early.reduce((n, c) => n + c.length, 0) > MAX_HEAD_BYTES) client.socket?.pause();
      return;
    }
    if (client.phase !== "head") return;
    const buf = concat(client.head, data);
    const end = headEnd(buf.subarray(0, MAX_HEAD_BYTES));
    if (end === -1) {
      if (buf.length >= MAX_HEAD_BYTES) respond(client, 431);
      else client.head = buf;
      return;
    }
    clearTimeout(client.timer);
    client.head = new Uint8Array(0);
    const head = new TextDecoder("latin1").decode(buf.subarray(0, end));
    const decision = decideConnect(head, allow, ports);
    if (opts.onRequest !== undefined) {
      try {
        opts.onRequest(firstLine(head), decision);
      } catch {
        // A hook's failure must not change the decision.
      }
    }
    if (!decision.allow) {
      respond(client, decision.status);
      return;
    }
    client.phase = "dialing";
    if (end < buf.length) client.early.push(buf.slice(end));
    void tunnel(client, decision.host, decision.port);
  }

  let listener: TCPSocketListener<Side>;
  try {
    listener = Bun.listen<Side>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (s) => {
          const side = newSide();
          side.socket = s;
          side.phase = "head";
          s.data = side;
          if (stopped) {
            s.terminate();
            return;
          }
          sockets.add(s);
          side.timer = setTimeout(() => {
            if (side.phase === "head") {
              side.phase = "done";
              finish(side);
            }
          }, HEAD_TIMEOUT_MS);
        },
        data: (s, data) => onClientData(s.data, data),
        drain: (s) => flush(s.data),
        end: (s) => closed(s.data),
        close: (s) => closed(s.data),
        error: () => {},
      },
    });
  } catch (e) {
    return err("unavailable", `proxy: cannot listen on 127.0.0.1: ${e instanceof Error ? e.message : String(e)}`);
  }

  const port = listener.port;
  return ok({
    port,
    url: `http://127.0.0.1:${port}`,
    stop: () => {
      if (stopped) return;
      stopped = true;
      listener.stop(true);
      for (const s of sockets) {
        clearTimeout(s.data?.timer);
        s.terminate();
      }
      sockets.clear();
    },
  });
}
