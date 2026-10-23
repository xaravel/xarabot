import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Socket, TCPSocketListener } from "bun";
import { decideConnect, MAX_HEAD_BYTES, startProxy, type Proxy, type ProxyOpts } from "../../src/sandbox/proxy.ts";
import { liveTest } from "../support/live.ts";

/**
 * The proxy against a local echo upstream: every allowed host is dialled to
 * 127.0.0.1, so these cases run on any host.
 */

const ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";
const HOST = "api.vendor.test";

let echo: TCPSocketListener<{ pending: Uint8Array | null }>;
let echoPort = 0;
let accepted = 0;

beforeAll(() => {
  echo = Bun.listen<{ pending: Uint8Array | null }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: (s) => {
        accepted += 1;
        s.data = { pending: null };
      },
      data: (s, d) => {
        const data = s.data.pending === null ? d : Buffer.concat([s.data.pending, d]);
        const n = s.write(data);
        s.data.pending = n < data.length ? data.slice(Math.max(n, 0)) : null;
        if (s.data.pending !== null) s.pause();
      },
      drain: (s) => {
        if (s.data.pending === null) return;
        const n = s.write(s.data.pending);
        s.data.pending = n < s.data.pending.length ? s.data.pending.slice(Math.max(n, 0)) : null;
        if (s.data.pending === null) s.resume();
      },
    },
  });
  echoPort = echo.port;
});

afterAll(() => {
  echo?.stop(true);
});

type Client = {
  readonly socket: Socket<undefined>;
  readonly closed: Promise<void>;
  isClosed(): boolean;
  bytes(): number;
  text(): string;
  send(data: string | Uint8Array): void;
  waitFor(pred: (text: string) => boolean, ms?: number): Promise<string>;
};

async function connect(port: number): Promise<Client> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let isClosed = false;
  let pending: Uint8Array | null = null;
  let markClosed = (): void => {};
  const closed = new Promise<void>((r) => (markClosed = r));
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data: (_s, d) => {
        chunks.push(d.slice());
        size += d.length;
      },
      drain: (s) => {
        if (pending === null) return;
        const n = s.write(pending);
        pending = n < pending.length ? pending.slice(Math.max(n, 0)) : null;
      },
      close: () => {
        isClosed = true;
        markClosed();
      },
      error: () => {},
    },
  });
  const text = (): string => Buffer.concat(chunks).toString("latin1");
  return {
    socket,
    closed,
    isClosed: () => isClosed,
    bytes: () => size,
    text,
    send: (data) => {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      if (pending !== null) {
        pending = Buffer.concat([pending, bytes]);
        return;
      }
      const n = socket.write(bytes);
      if (n < bytes.length) pending = bytes.slice(Math.max(n, 0));
    },
    waitFor: async (pred, ms = 5_000) => {
      const deadline = Date.now() + ms;
      while (!pred(text())) {
        if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(text().slice(0, 200))}`);
        await Bun.sleep(5);
      }
      return text();
    },
  };
}

type Started = { readonly proxy: Proxy; readonly dialled: string[] };

function start(opts: Partial<ProxyOpts> = {}): Started {
  const dialled: string[] = [];
  const r = startProxy({
    allow: [HOST, "pypi.org"],
    ports: [echoPort],
    dial: (host) => {
      dialled.push(host);
      return "127.0.0.1";
    },
    ...opts,
  });
  if (!r.ok) throw new Error(r.error.message);
  return { proxy: r.value, dialled };
}

/** Sends one request and waits for the proxy to answer and close. */
async function answer(proxy: Proxy, request: string): Promise<string> {
  const c = await connect(proxy.port);
  c.send(request);
  await Promise.race([c.closed, Bun.sleep(5_000)]);
  expect(c.isClosed()).toBe(true);
  return c.text();
}

function status(code: number, reason: string): string {
  return `HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
}

describe("decideConnect", () => {
  const ALLOW = ["api.vendor.test", "pypi.org", "github.com", "localhost", "app.localhost"];
  test.each<[string, string, number | "allow"]>([
    ["an allowed host", "CONNECT pypi.org:443 HTTP/1.1\r\nHost: pypi.org:443\r\n\r\n", "allow"],
    ["an allowed host in upper case with a trailing dot", "CONNECT PyPI.org.:443 HTTP/1.1\r\n\r\n", "allow"],
    ["HTTP/1.0", "CONNECT pypi.org:443 HTTP/1.0\r\n\r\n", "allow"],
    ["GitHub, even when allowed", "CONNECT github.com:443 HTTP/1.1\r\n\r\n", 403],
    ["api.github.com", "CONNECT api.github.com:443 HTTP/1.1\r\n\r\n", 403],
    ["raw.githubusercontent.com", "CONNECT raw.githubusercontent.com:443 HTTP/1.1\r\n\r\n", 403],
    ["an IPv4 literal", "CONNECT 140.82.112.3:443 HTTP/1.1\r\n\r\n", 403],
    ["an IPv6 literal", "CONNECT [::1]:443 HTTP/1.1\r\n\r\n", 403],
    ["a numeric last label", "CONNECT pypi.123:443 HTTP/1.1\r\n\r\n", 403],
    ["localhost, even when allowed", "CONNECT localhost:443 HTTP/1.1\r\n\r\n", 403],
    ["a .localhost host, even when allowed", "CONNECT app.localhost:443 HTTP/1.1\r\n\r\n", 403],
    ["an unlisted host", "CONNECT example.com:443 HTTP/1.1\r\n\r\n", 403],
    ["a subdomain of an allowed host", "CONNECT evil.pypi.org:443 HTTP/1.1\r\n\r\n", 403],
    ["a wrong port", "CONNECT pypi.org:22 HTTP/1.1\r\n\r\n", 403],
    ["plain HTTP", "GET http://pypi.org/ HTTP/1.1\r\nHost: pypi.org\r\n\r\n", 405],
    ["lower-case connect", "connect pypi.org:443 HTTP/1.1\r\n\r\n", 405],
    ["no port", "CONNECT pypi.org HTTP/1.1\r\n\r\n", 400],
    ["port 0", "CONNECT pypi.org:0 HTTP/1.1\r\n\r\n", 400],
    ["port 65536", "CONNECT pypi.org:65536 HTTP/1.1\r\n\r\n", 400],
    ["userinfo", "CONNECT u@pypi.org:443 HTTP/1.1\r\n\r\n", 400],
    ["a bare IPv6 authority", "CONNECT ::1:443 HTTP/1.1\r\n\r\n", 400],
    ["no version", "CONNECT pypi.org:443\r\n\r\n", 400],
    ["extra spaces", "CONNECT  pypi.org:443 HTTP/1.1\r\n\r\n", 400],
    ["an underscore host", "CONNECT a_b.test:443 HTTP/1.1\r\n\r\n", 400],
  ])("%s", (_name, head, want) => {
    const d = decideConnect(head, ALLOW, [443]);
    if (want === "allow") expect(d).toEqual({ allow: true, host: "pypi.org", port: 443 });
    else expect(d).toMatchObject({ allow: false, status: want });
  });
});

describe("startProxy", () => {
  test("listens on 127.0.0.1 and names itself by URL", () => {
    const { proxy } = start();
    try {
      expect(proxy.port).toBeGreaterThan(0);
      expect(proxy.url).toBe(`http://127.0.0.1:${proxy.port}`);
    } finally {
      proxy.stop();
    }
  });

  test.each<[string, Partial<ProxyOpts>]>([
    ["a GitHub host on the allowlist", { allow: ["github.com"] }],
    ["an IP literal on the allowlist", { allow: ["140.82.112.3"] }],
    ["localhost on the allowlist", { allow: ["localhost"] }],
    ["a .localhost host on the allowlist", { allow: ["app.localhost"] }],
    ["no ports", { ports: [] }],
    ["port 0", { ports: [0] }],
  ])("refuses %s", (_name, patch) => {
    const r = startProxy({ allow: [HOST], ...patch });
    expect(r.ok).toBe(false);
  });
});

describe("the proxy", () => {
  let s: Started;
  beforeAll(() => {
    s = start();
  });
  afterAll(() => s.proxy.stop());

  test("an allowed host gets 200, then bytes round-trip", async () => {
    const before = accepted;
    const c = await connect(s.proxy.port);
    c.send(`CONNECT ${HOST}:${echoPort} HTTP/1.1\r\nHost: ${HOST}:${echoPort}\r\n\r\n`);
    await c.waitFor((t) => t === ESTABLISHED);
    c.send("ping");
    await c.waitFor((t) => t === `${ESTABLISHED}ping`);
    expect(accepted).toBe(before + 1);
    c.socket.end();
  });

  test("bytes sent after the head are forwarded", async () => {
    const c = await connect(s.proxy.port);
    c.send(`CONNECT ${HOST}:${echoPort} HTTP/1.1\r\n\r\nearly`);
    await c.waitFor((t) => t === `${ESTABLISHED}early`);
    c.socket.end();
  });

  test("bytes written after the head but before the upstream connects are forwarded", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    let dialling = false;
    const p = start({
      dial: async () => {
        dialling = true;
        await gate;
        return "127.0.0.1";
      },
    });
    try {
      const c = await connect(p.proxy.port);
      c.send(`CONNECT ${HOST}:${echoPort} HTTP/1.1\r\n\r\n`);
      const deadline = Date.now() + 5_000;
      while (!dialling && Date.now() < deadline) await Bun.sleep(5);
      expect(dialling).toBe(true);
      c.send("mid");
      await Bun.sleep(50);
      expect(c.text()).toBe("");
      release();
      await c.waitFor((t) => t === `${ESTABLISHED}mid`);
      c.socket.end();
    } finally {
      p.proxy.stop();
    }
  });

  test("a large transfer survives backpressure both ways", async () => {
    const c = await connect(s.proxy.port);
    c.send(`CONNECT ${HOST}:${echoPort} HTTP/1.1\r\n\r\n`);
    await c.waitFor((t) => t === ESTABLISHED);
    const payload = new Uint8Array(16 * 1024 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
    c.send(payload);
    const deadline = Date.now() + 20_000;
    while (c.bytes() < ESTABLISHED.length + payload.length && Date.now() < deadline) await Bun.sleep(10);
    expect(c.bytes()).toBe(ESTABLISHED.length + payload.length);
    const got = new Uint8Array(Buffer.from(c.text(), "latin1")).subarray(ESTABLISHED.length);
    expect(Buffer.compare(got, payload)).toBe(0);
    c.socket.end();
  }, 30_000);

  test("the client closing ends the upstream, and the upstream closing ends the client", async () => {
    let upstreamClosed = false;
    let upstreamSocket: Socket<undefined> | null = null;
    const closer = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (u) => void (upstreamSocket = u),
        data: () => {},
        close: () => void (upstreamClosed = true),
      },
    });
    const p = start({ ports: [closer.port] });
    try {
      const a = await connect(p.proxy.port);
      a.send(`CONNECT ${HOST}:${closer.port} HTTP/1.1\r\n\r\n`);
      await a.waitFor((t) => t === ESTABLISHED);
      a.socket.end();
      const deadline = Date.now() + 5_000;
      while (!upstreamClosed && Date.now() < deadline) await Bun.sleep(5);
      expect(upstreamClosed).toBe(true);

      const b = await connect(p.proxy.port);
      b.send(`CONNECT ${HOST}:${closer.port} HTTP/1.1\r\n\r\n`);
      await b.waitFor((t) => t === ESTABLISHED);
      (upstreamSocket as Socket<undefined> | null)?.end();
      await Promise.race([b.closed, Bun.sleep(5_000)]);
      expect(b.isClosed()).toBe(true);
    } finally {
      p.proxy.stop();
      closer.stop(true);
    }
  });

  for (const host of ["github.com", "api.github.com", "raw.githubusercontent.com"]) {
    test(`GitHub by name: ${host} gets 403 and no dial`, async () => {
      const before = s.dialled.length;
      expect(await answer(s.proxy, `CONNECT ${host}:443 HTTP/1.1\r\n\r\n`)).toBe(status(403, "Forbidden"));
      expect(s.dialled.length).toBe(before);
    });
  }

  for (const authority of ["140.82.112.3:443", "[::1]:443"]) {
    test(`GitHub by IP: ${authority} gets 403`, async () => {
      const before = s.dialled.length;
      expect(await answer(s.proxy, `CONNECT ${authority} HTTP/1.1\r\n\r\n`)).toBe(status(403, "Forbidden"));
      expect(s.dialled.length).toBe(before);
    });
  }

  test("an unlisted host gets 403", async () => {
    expect(await answer(s.proxy, "CONNECT example.com:443 HTTP/1.1\r\n\r\n")).toBe(status(403, "Forbidden"));
  });

  test("an allowed host on a wrong port gets 403", async () => {
    expect(await answer(s.proxy, `CONNECT ${HOST}:22 HTTP/1.1\r\n\r\n`)).toBe(status(403, "Forbidden"));
  });

  test("plain HTTP gets 405", async () => {
    const before = s.dialled.length;
    expect(await answer(s.proxy, "GET http://pypi.org/ HTTP/1.1\r\nHost: pypi.org\r\n\r\n")).toBe(status(405, "Method Not Allowed"));
    expect(s.dialled.length).toBe(before);
  });

  test("an unparseable authority gets 400", async () => {
    expect(await answer(s.proxy, "CONNECT pypi.org HTTP/1.1\r\n\r\n")).toBe(status(400, "Bad Request"));
  });

  test("an oversized head gets 431", async () => {
    const c = await connect(s.proxy.port);
    c.send(`CONNECT ${HOST}:${echoPort} HTTP/1.1\r\nX-Pad: ${"a".repeat(MAX_HEAD_BYTES)}\r\n\r\n`);
    await Promise.race([c.closed, Bun.sleep(5_000)]);
    expect(c.text()).toBe(status(431, "Request Header Fields Too Large"));
  });

  test("a head that arrives in pieces is read whole", async () => {
    const c = await connect(s.proxy.port);
    c.send("CONNECT pypi");
    await Bun.sleep(20);
    c.send(`.org:${echoPort} HTTP/1.1\r\n`);
    await Bun.sleep(20);
    c.send("\r\n");
    await c.waitFor((t) => t === ESTABLISHED);
    c.socket.end();
  });

  test(
    "a head that never completes is closed after 10 s with no reply",
    async () => {
      const c = await connect(s.proxy.port);
      c.send("CONNECT pypi.org:443 HTTP/1.1\r\n");
      await Promise.race([c.closed, Bun.sleep(12_000)]);
      expect(c.isClosed()).toBe(true);
      expect(c.text()).toBe("");
    },
    15_000,
  );
});

describe("upstream down", () => {
  test("an allowed host whose dial target refuses gets 502", async () => {
    const gone = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
    const port = gone.port;
    gone.stop(true);
    const { proxy } = start({ ports: [port] });
    try {
      expect(await answer(proxy, `CONNECT ${HOST}:${port} HTTP/1.1\r\n\r\n`)).toBe(status(502, "Bad Gateway"));
    } finally {
      proxy.stop();
    }
  });
});

describe("stop", () => {
  test("closes open tunnels and the listener", async () => {
    const { proxy } = start();
    const c = await connect(proxy.port);
    c.send(`CONNECT ${HOST}:${echoPort} HTTP/1.1\r\n\r\n`);
    await c.waitFor((t) => t === ESTABLISHED);
    const idle = await connect(proxy.port);
    proxy.stop();
    await Promise.race([Promise.all([c.closed, idle.closed]), Bun.sleep(5_000)]);
    expect(c.isClosed()).toBe(true);
    expect(idle.isClosed()).toBe(true);
    await expect(connect(proxy.port)).rejects.toThrow();
  });
});

describe("live", () => {
  liveTest("CONNECT pypi.org:443 gets 200", async () => {
    const r = startProxy({ allow: ["pypi.org"] });
    if (!r.ok) throw new Error(r.error.message);
    try {
      const c = await connect(r.value.port);
      c.send("CONNECT pypi.org:443 HTTP/1.1\r\nHost: pypi.org:443\r\n\r\n");
      await c.waitFor((t) => t.startsWith(ESTABLISHED), 15_000);
      c.socket.end();
    } finally {
      r.value.stop();
    }
  }, 20_000);
});
