// @effect-diagnostics nodeBuiltinImport:off -- Two small provider files read and hashed at the Node adapter boundary, once per update check.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Anonymous "active user" codes the update check carries, so the update feed
 * counts people rather than installs: every device signed into the same Claude
 * or ChatGPT account sends the same code that day, and three laptops are one
 * user.
 *
 * Only the providers' opaque account ids are read -- Claude's
 * `oauthAccount.accountUuid` and Codex's ChatGPT `tokens.account_id` -- never an
 * email or a name, and never a GitHub id, which is public and could be guessed
 * back from its hash. Each id is hashed here together with the UTC date, so
 * what leaves the machine is a one-way code that means nothing without the
 * account id and changes every day: the feed can count distinct people per day
 * but cannot follow anyone from one day to the next.
 */
export const ACTIVE_USER_HEADER = "x-mtcode-active-user";

export type ProviderAccount = readonly [provider: "claude" | "codex", id: string];

function activeUserCodes(accounts: ReadonlyArray<ProviderAccount>, day: string): string[] {
  return accounts.map(([provider, id]) =>
    NodeCrypto.createHash("sha256")
      .update(`mtcode-active-user/v1/${provider}/${day}/${id}`)
      .digest("hex")
      .slice(0, 32),
  );
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** The default Claude and Codex accounts this machine is signed into, if any. */
export function readProviderAccounts(input: {
  readonly homeDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): ProviderAccount[] {
  const accounts: ProviderAccount[] = [];
  for (const directory of [input.env.CLAUDE_CONFIG_DIR, input.homeDirectory]) {
    if (!nonEmpty(directory)) continue;
    const config = readJson(NodePath.join(directory, ".claude.json")) as
      | { oauthAccount?: { accountUuid?: unknown } }
      | undefined;
    const uuid = config?.oauthAccount?.accountUuid;
    if (nonEmpty(uuid)) {
      accounts.push(["claude", uuid.trim()]);
      break;
    }
  }
  const codexHome = nonEmpty(input.env.CODEX_HOME)
    ? input.env.CODEX_HOME
    : NodePath.join(input.homeDirectory, ".codex");
  const auth = readJson(NodePath.join(codexHome, "auth.json")) as
    | { tokens?: { account_id?: unknown } }
    | undefined;
  const accountId = auth?.tokens?.account_id;
  if (nonEmpty(accountId)) accounts.push(["codex", accountId.trim()]);
  return accounts;
}

/** Request headers for one update check: the day's codes, or none when signed out. */
export function activeUserHeaders(input: {
  readonly homeDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly day: string;
}): Record<string, string> {
  const codes = activeUserCodes(readProviderAccounts(input), input.day);
  return codes.length > 0 ? { [ACTIVE_USER_HEADER]: codes.join(",") } : {};
}
