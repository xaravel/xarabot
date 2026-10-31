/**
 * The GitHub App manifest `xarabot join` creates a lane bot's App from, and
 * the check a re-run makes against an existing App (FR13, NFR9, AR27). Pure.
 *
 * The App asks for exactly the permissions Xarabot uses: no merge-queue,
 * `administration`, `workflows` or bypass permission.
 */

/** The App's permissions, record name → level, in the order `join` reports them. */
export const MANIFEST_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "read",
  statuses: "read",
  actions: "read",
  metadata: "read",
} as const satisfies Readonly<Record<string, "read" | "write">>;

/** The project page the manifest's `url` and inactive webhook point at. */
export const PROJECT_URL = "https://github.com/xaravel/xarabot";

/** The page a manifest form posts to; GitHub returns `state` on the callback. */
export const MANIFEST_PAGE = "https://github.com/settings/apps/new";

export type AppManifest = {
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly public: true;
  readonly redirect_url: string;
  readonly hook_attributes: { readonly url: string; readonly active: false };
  readonly request_oauth_on_install: false;
  readonly default_permissions: Readonly<Record<string, string>>;
};

/** The owner's App name: `<login>-xarabot`. */
export function appName(login: string): string {
  return `${login}-xarabot`;
}

/** The manifest for `login`'s App; GitHub redirects to `redirectUrl` with the conversion code. */
export function buildManifest(params: { readonly login: string; readonly redirectUrl: string }): AppManifest {
  return {
    name: appName(params.login),
    url: PROJECT_URL,
    description: `Xarabot lane bot operated by @${params.login}. Its lanes commit, push and open PRs as this App.`,
    public: true,
    redirect_url: params.redirectUrl,
    hook_attributes: { url: PROJECT_URL, active: false },
    request_oauth_on_install: false,
    default_permissions: { ...MANIFEST_PERMISSIONS },
  };
}

/** The manifest page URL carrying `state`. */
export function manifestPageUrl(state: string): string {
  return `${MANIFEST_PAGE}?state=${encodeURIComponent(state)}`;
}

/** The App's settings page, where its owner deletes it (under Advanced). */
export function appSettingsUrl(slug: string): string {
  return `https://github.com/settings/apps/${slug}`;
}

/** The App's permissions page: a Human Live Step changes them there. */
export function appPermissionsUrl(slug: string): string {
  return `${appSettingsUrl(slug)}/permissions`;
}

/** The page that installs the App on an account or org. */
export function appInstallUrl(slug: string): string {
  return `https://github.com/apps/${slug}/installations/new`;
}

/**
 * What to change so an App's granted permissions equal the manifest's, as
 * lines: every `add <name>: <level>` (manifest order), then every
 * `remove <name>: <level>` (by name), then every
 * `change <name>: <has> to <name>: <wants>` (manifest order). Empty when they
 * are equal.
 */
export function comparePermissions(actual: Readonly<Record<string, string>>): string[] {
  const wanted: Readonly<Record<string, string>> = MANIFEST_PERMISSIONS;
  const has = (name: string): boolean => Object.hasOwn(actual, name);
  const adds: string[] = [];
  const changes: string[] = [];
  for (const [name, level] of Object.entries(wanted)) {
    if (!has(name)) adds.push(`add ${name}: ${level}`);
    else if (actual[name] !== level) changes.push(`change ${name}: ${actual[name]} to ${name}: ${level}`);
  }
  const removes = Object.keys(actual)
    .filter((name) => !Object.hasOwn(wanted, name))
    .sort()
    .map((name) => `remove ${name}: ${actual[name]}`);
  return [...adds, ...removes, ...changes];
}
