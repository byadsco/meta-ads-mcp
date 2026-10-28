import { getAccessToken, hashToken } from "../auth/token-store.js";
import { metaApiClient } from "./client.js";
import { amountLine } from "./currency.js";

// The lookup only decorates the result of a write that already happened, so
// it must not hold that result back (a client that times out waiting would
// repeat the write) and must not weigh on the writes that follow: it uses
// the client's detached GET, is cancelled at the deadline, and is refused
// outright when too many are already waiting.
const LOOKUP_DEADLINE_MS = 2000;
const MAX_CONCURRENT_LOOKUPS = 8;
const MAX_ENTRIES = 2000;

// An account's currency and an object's account never change, so entries do
// not expire. Keys carry the token hash: one tenant's read never answers
// another's.
const remembered = new Map<string, string>();
let lookupsInProgress = 0;

type Owner = { accountId: string } | { entityId: string };
type Read = (key: string, path: string, field: string, accept: RegExp) => Promise<string | undefined>;

function remember(key: string, value: string): void {
  if (!remembered.has(key) && remembered.size >= MAX_ENTRIES) {
    const oldest = remembered.keys().next().value;
    if (oldest !== undefined) remembered.delete(oldest);
  }
  remembered.set(key, value);
}

const fromMemory: Read = async (key) => remembered.get(key);

function fromMeta(signal: AbortSignal, token: string): Read {
  return async (key, path, field, accept) => {
    const known = remembered.get(key);
    if (known !== undefined) return known;
    const response = await metaApiClient.getDetached<Record<string, unknown>>(path, { fields: field }, signal, token);
    const value = response?.[field];
    if (signal.aborted || typeof value !== "string" || !accept.test(value)) return undefined;
    remember(key, value);
    return value;
  };
}

async function resolveCurrency(tokenHash: string, owner: Owner, read: Read): Promise<string | undefined> {
  let accountId: string | undefined;
  if ("entityId" in owner) {
    if (!/^\d{1,30}$/.test(owner.entityId)) return undefined;
    accountId = await read(`${tokenHash}:account:${owner.entityId}`, `/${owner.entityId}`, "account_id", /^\d{1,30}$/);
  } else {
    accountId = owner.accountId;
  }
  const match = /^(?:act_)?(\d{1,30})$/.exec(accountId ?? "");
  if (!match) return undefined;
  const account = `act_${match[1]}`;
  const currency = await read(`${tokenHash}:currency:${account}`, `/${account}`, "currency", /^[A-Za-z]{3}$/);
  return currency?.toUpperCase();
}

async function lookup(owner: Owner): Promise<string | undefined> {
  // The token is read once, here, before anything is awaited. Where it is
  // process-wide it can change during the lookup, and the cache key and
  // every request of this lookup must belong to the same one.
  let token: string;
  try {
    token = getAccessToken();
  } catch {
    return undefined;
  }
  const tokenHash = hashToken(token);

  const known = await resolveCurrency(tokenHash, owner, fromMemory);
  if (known !== undefined) return known;
  if (lookupsInProgress >= MAX_CONCURRENT_LOOKUPS) return undefined;

  lookupsInProgress += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_DEADLINE_MS);
  timer.unref?.();
  const cancelled = new Promise<undefined>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
  try {
    const answer = resolveCurrency(tokenHash, owner, fromMeta(controller.signal, token)).catch(() => undefined);
    return await Promise.race([answer, cancelled]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    lookupsInProgress -= 1;
  }
}

/**
 * The currency of an ad account, read once per token and account and then
 * answered from memory. Resolves to undefined, and never rejects, when the
 * read fails, when Meta does not answer within two seconds (the request is
 * cancelled) or when eight lookups are already waiting: callers use it to
 * word a result, not to decide anything.
 */
export function accountCurrency(accountId: string): Promise<string | undefined> {
  return lookup({ accountId });
}

/** Same, starting from a campaign, ad set or ad id: its account is read first. */
export function entityAccountCurrency(entityId: string): Promise<string | undefined> {
  return lookup({ entityId });
}

const AMOUNT_LABELS: Readonly<Record<string, string>> = {
  daily_budget: "Daily budget",
  lifetime_budget: "Lifetime budget",
  bid_amount: "Bid amount",
};

// A campaign's spend_cap is in the budgets' minor unit, but the same field
// sent to an ad account is the account cap, in whole currency. Only a write
// known to be a new campaign states it.
export const CAMPAIGN_AMOUNT_LABELS: Readonly<Record<string, string>> = { ...AMOUNT_LABELS, spend_cap: "Spend cap" };

/**
 * Lines for the result of a write, one per amount in the body that was sent,
 * each starting with a line break:
 * "\nDaily budget: COP 50,000 (account currency COP)". Pass the form body
 * itself, never the tool's arguments: an argument the handler dropped must
 * not be confirmed. Empty, and without any request, when the body carried no
 * amount. A value that is neither a number nor a string of digits is left
 * out. `labels` names the fields read; the default is the budgets and the bid.
 */
export async function statedAmounts(sentBody: Record<string, unknown>, owner: Owner, labels = AMOUNT_LABELS): Promise<string> {
  const given: Array<[string, number]> = [];
  for (const [field, label] of Object.entries(labels)) {
    const raw = sentBody[field];
    const amount = typeof raw === "string" && /^\d{1,15}$/.test(raw) ? Number(raw) : raw;
    if (typeof amount === "number" && Number.isFinite(amount)) given.push([label, amount]);
  }
  if (given.length === 0) return "";

  const currency = await lookup(owner);
  return given.map(([label, amount]) => `\n${amountLine(label, amount, currency)}`).join("");
}

export function resetAccountCurrencyCacheForTests(): void {
  remembered.clear();
  lookupsInProgress = 0;
}
