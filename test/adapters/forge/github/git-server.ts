import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A real smart-HTTP git remote for tests: `Bun.serve` on 127.0.0.1 running
 * `git http-backend` as CGI for one bare repo at `/<owner>/<name>.git`. Every
 * request needs Basic auth `x-access-token:<token>` with a token
 * `tokenValid` accepts, else 401. After each receive-pack it reports the
 * remote's branch refs to `onPush`.
 */

export type GitServerOptions = {
  /** A folder the server owns; the bare repo is created below it. */
  readonly root: string;
  readonly owner: string;
  readonly name: string;
  readonly tokenValid: (token: string) => boolean;
  /** The remote's branches (name to SHA) after each push. */
  readonly onPush?: (refs: Readonly<Record<string, string>>) => void;
  /** Runs before each request is served. */
  readonly hold?: (request: Request) => Promise<void>;
};

export type GitServer = {
  /** `http://127.0.0.1:<port>`: the adapter's `gitUrl`. */
  readonly url: string;
  /** The repo's URL: `<url>/<owner>/<name>.git`. */
  readonly repoUrl: string;
  /** The bare repo's path on disk. */
  readonly repoDir: string;
  /** Every password a request presented, valid or not, oldest first. */
  seen(): string[];
  /** The remote's branches, name to SHA. */
  refs(): Promise<Record<string, string>>;
  stop(): Promise<void>;
};

const SERVER_ENV = (home: string): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
});

async function git(repoDir: string, args: readonly string[]): Promise<string> {
  const p = Bun.spawn(["git", `--git-dir=${repoDir}`, ...args], { env: SERVER_ENV(repoDir), stdio: ["ignore", "pipe", "pipe"] });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out;
}

async function branchRefs(repoDir: string): Promise<Record<string, string>> {
  const out = await git(repoDir, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"]);
  const refs: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]+) refs\/heads\/(.+)$/.exec(line);
    if (m !== null) refs[m[2] as string] = m[1] as string;
  }
  return refs;
}

function basicPassword(header: string | null): { user: string; password: string } | null {
  if (header === null || !header.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  const i = decoded.indexOf(":");
  return i === -1 ? null : { user: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

/** Splits a CGI reply into status, headers and body. */
function parseCgi(out: Uint8Array): Response {
  let split = -1;
  let sep = 0;
  for (let i = 0; i < out.length - 1; i += 1) {
    if (out[i] === 10 && out[i + 1] === 10) {
      split = i;
      sep = 2;
      break;
    }
    if (out[i] === 13 && out[i + 1] === 10 && out[i + 2] === 13 && out[i + 3] === 10) {
      split = i;
      sep = 4;
      break;
    }
  }
  if (split === -1) return new Response("bad CGI reply", { status: 500 });
  const head = new TextDecoder().decode(out.subarray(0, split));
  const headers = new Headers();
  let status = 200;
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else headers.append(key, value);
  }
  return new Response(out.subarray(split + sep), { status, headers });
}

export async function startGitServer(options: GitServerOptions): Promise<GitServer> {
  const repoDir = join(options.root, options.owner, `${options.name}.git`);
  mkdirSync(join(options.root, options.owner), { recursive: true });
  await git(repoDir, ["init", "--quiet", "--bare", "--initial-branch=main"]);
  const seen: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await options.hold?.(request);
      const auth = basicPassword(request.headers.get("authorization"));
      if (auth !== null) seen.push(auth.password);
      if (auth === null || auth.user !== "x-access-token" || !options.tokenValid(auth.password)) {
        return new Response("Authentication required\n", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="fake-github"' } });
      }
      const url = new URL(request.url);
      const body = new Uint8Array(await request.arrayBuffer());
      const env: Record<string, string> = {
        ...SERVER_ENV(options.root),
        GIT_PROJECT_ROOT: options.root,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: request.method,
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.replace(/^\?/, ""),
        CONTENT_TYPE: request.headers.get("content-type") ?? "",
        CONTENT_LENGTH: String(body.byteLength),
        REMOTE_USER: auth.user,
        REMOTE_ADDR: "127.0.0.1",
      };
      const encoding = request.headers.get("content-encoding");
      if (encoding !== null) env["HTTP_CONTENT_ENCODING"] = encoding;
      const protocol = request.headers.get("git-protocol");
      if (protocol !== null) env["GIT_PROTOCOL"] = protocol;
      const cgi = Bun.spawn(["git", "http-backend"], { env, stdin: body, stdout: "pipe", stderr: "pipe" });
      const [out] = await Promise.all([new Response(cgi.stdout).arrayBuffer(), new Response(cgi.stderr).text(), cgi.exited]);
      const response = parseCgi(new Uint8Array(out));
      if (request.method === "POST" && url.pathname.endsWith("/git-receive-pack")) options.onPush?.(await branchRefs(repoDir));
      return response;
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    repoUrl: `${url}/${options.owner}/${options.name}.git`,
    repoDir,
    seen: () => [...seen],
    refs: () => branchRefs(repoDir),
    stop: async () => {
      await server.stop(true);
    },
  };
}
