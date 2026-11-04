/**
 * Social identity linking.
 *
 * Two mechanisms, chosen per platform because the platforms differ:
 *
 *   OAuth      Discord, Facebook. The person authorizes us with the platform
 *              itself, and the platform tells us which account they control.
 *
 *   Proof post GitHub, Bluesky, Mastodon. The person publishes a nonce we
 *              generated on their own account; we fetch it back and compare.
 *              No password, no scraping of anyone else, no API key needed.
 *
 * What we never do is take an identifier someone typed and go read a profile
 * behind it. Every read here happens *after* the person put our nonce on their
 * own page, which is the whole proof.
 */

import type { Config } from "./config.ts";
import { newNonce } from "./crypto.ts";
import { ApiError, badRequest, notImplemented, unavailable } from "./errors.ts";

export type NetworkMeta = {
  label: string;
  method: "proof_post" | "oauth";
  handleLabel: string;
  handleExample: string;
  whatItIs: string;
};

export const NETWORKS: Record<string, NetworkMeta> = {
  github: {
    label: "GitHub",
    method: "proof_post",
    handleLabel: "GitHub username",
    handleExample: "octocat",
    whatItIs: "Repos you actually push to. Good signal for what you build.",
  },
  bluesky: {
    label: "Bluesky",
    method: "proof_post",
    handleLabel: "Bluesky handle",
    handleExample: "you.bsky.social",
    whatItIs: "Public posts. Signal for what you talk about.",
  },
  mastodon: {
    label: "Mastodon",
    method: "proof_post",
    handleLabel: "Mastodon address",
    handleExample: "@you@fosstodon.org",
    whatItIs: "Your instance profile and public posts.",
  },
  discord: {
    label: "Discord",
    method: "oauth",
    handleLabel: "Discord account",
    handleExample: "authorize with Discord",
    whatItIs: "Account identity and which servers you are in (names only).",
  },
  facebook: {
    label: "Facebook",
    method: "oauth",
    handleLabel: "Facebook account",
    handleExample: "authorize with Facebook",
    whatItIs: "Account identity only. Facebook restricted profile access in 2018, so expect nothing more.",
  },
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ProofResult =
  | { ok: true; evidenceUrl: string | null; detail: string }
  | { ok: false; reason: string };

export function proofInstructions(
  network: string,
  handle: string,
  nonce: string,
): { steps: string[]; paste: string } {
  const paste = `tandem:${nonce}`;
  const meta = NETWORKS[network];
  switch (network) {
    case "github":
      return {
        paste,
        steps: [
          `Open https://github.com/${handle} in a browser.`,
          "Edit your profile.",
          `Put the text ${paste} in your Bio field and save.`,
          "Come back here and press Verify. You can remove it afterwards.",
        ],
      };
    case "bluesky":
      return {
        paste,
        steps: [
          "Compose a new post on Bluesky.",
          `Type exactly: ${paste}`,
          "Post it publicly, then press Verify here.",
          "Delete the post whenever you like. Verification is not re-checked.",
        ],
      };
    case "mastodon":
      return {
        paste,
        steps: [
          `Open your profile at ${handle} and edit it.`,
          `Add ${paste} to your bio and save.`,
          "Press Verify. Remove it afterwards if you want.",
        ],
      };
    default:
      return {
        paste,
        steps: [
          `${meta?.label ?? network} verifies through authorization rather than a proof post.`,
          "Use the authorize link instead of pasting anything.",
        ],
      };
  }
}

/** Extract lowercase text from an HTML fragment without a parser dependency. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

async function getJson(fetcher: FetchLike, url: string): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { Accept: "application/json", "User-Agent": "tandem-verify/0.1" },
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 404) {
    const missing = new ApiError(404, "account_not_found", "That account does not exist on this network.");
    throw missing;
  }
  if (!response.ok) {
    throw unavailable(`That account could not be read (HTTP ${response.status}). Try again in a moment.`);
  }
  return response.json();
}

function cleanHandle(raw: unknown): string {
  if (typeof raw !== "string") throw badRequest("handle must be a string");
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 120) throw badRequest("handle looks wrong");
  // Whitelist, not blacklist. Every supported handle format is covered by these
  // characters, so anything else (quotes, spaces, angle brackets, backslashes)
  // is rejected before it can reach a URL or a header.
  if (!/^[A-Za-z0-9._@:-]+$/.test(trimmed)) {
    throw badRequest("handle may only contain letters, digits, dots, underscores, @, :, and hyphens");
  }
  return trimmed;
}

/**
 * Verify a proof post. Pure-ish: the fetcher is injected so tests never touch
 * the network and CI stays fast.
 *
 * A missing nonce is a *failed* proof, never an error: the person simply has
 * not posted it yet, or the post has not propagated.
 */
export async function verifyProofPost(
  network: string,
  handle: string,
  nonce: string,
  fetcher: FetchLike = fetch,
): Promise<ProofResult> {
  const meta = NETWORKS[network];
  if (!meta) throw badRequest(`unknown network: ${network}`);
  if (meta.method === "oauth") {
    return { ok: false, reason: `${meta.label} uses authorization, not a proof post.` };
  }

  const target = cleanHandle(handle);
  const needle = nonce.toLowerCase();

  try {
    if (network === "github") {
      const data = (await getJson(fetcher, `https://api.github.com/users/${encodeURIComponent(target)}`)) as {
        bio?: string | null;
        name?: string | null;
        blog?: string | null;
        html_url?: string | null;
      };
      const haystack = [data.bio, data.name, data.blog].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(needle)
        ? { ok: true, evidenceUrl: data.html_url ?? null, detail: "Found in your GitHub profile." }
        : { ok: false, reason: "The code is not in your GitHub bio yet." };
    }

    if (network === "bluesky") {
      const actor = target.replace(/^@/, "");
      const resolved = (await getJson(
        fetcher,
        `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(actor)}`,
      )) as { did?: string };
      if (!resolved.did) return { ok: false, reason: "That Bluesky handle could not be resolved." };

      const feed = (await getJson(
        fetcher,
        `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(resolved.did)}&limit=25`,
      )) as { feed?: Array<{ post?: { uri?: string; record?: { text?: string } } }> };

      for (const item of feed.feed ?? []) {
        const text = item.post?.record?.text ?? "";
        if (text.toLowerCase().includes(needle)) {
          const uri = item.post?.uri ?? "";
          const rkey = uri.split("/").pop() ?? "";
          const url = rkey ? `https://bsky.app/profile/${actor}/post/${rkey}` : null;
          return { ok: true, evidenceUrl: url, detail: "Found in a recent public post." };
        }
      }
      return { ok: false, reason: "The code is not in your 25 most recent public posts yet." };
    }

    if (network === "mastodon") {
      const withoutAt = target.replace(/^@/, "");
      const parts = withoutAt.split("@").filter(Boolean);
      const [acct, instance] = parts.length >= 2 ? [parts[0], parts[1]] : [parts[0], ""];
      if (!instance) {
        return { ok: false, reason: "Use the full Mastodon address, like @you@fosstodon.org." };
      }

      const account = (await getJson(
        fetcher,
        `https://${instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`,
      )) as { id?: string; url?: string; note?: string };

      const bio = stripHtml(account.note ?? "");
      if (bio.includes(needle)) {
        return { ok: true, evidenceUrl: account.url ?? null, detail: "Found in your Mastodon bio." };
      }
      if (!account.id) return { ok: false, reason: "That Mastodon account could not be read." };

      const statuses = (await getJson(
        fetcher,
        `https://${instance}/api/v1/accounts/${encodeURIComponent(account.id)}/statuses?limit=20`,
      )) as Array<{ content?: string; url?: string }>;

      for (const status of statuses) {
        if (stripHtml(status.content ?? "").includes(needle)) {
          return { ok: true, evidenceUrl: status.url ?? null, detail: "Found in a recent post." };
        }
      }
      return { ok: false, reason: "The code is not in your bio or 20 most recent posts yet." };
    }

    throw badRequest(`no verifier for network: ${network}`);
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return { ok: false, reason: `${meta.label} did not respond in time. Try again in a moment.` };
    }
    if (error instanceof ApiError && error.code === "account_not_found") {
      return { ok: false, reason: "That account does not exist on this network." };
    }
    if (error instanceof Error && "status" in error) throw error;
    return { ok: false, reason: `Could not reach ${meta.label}: ${(error as Error).message}` };
  }
}

/** Build the authorize URL. State is the proof nonce, so the callback can find the row. */
export function oauthAuthorizeUrl(config: Config, network: string, state: string): string {
  if (network === "discord") {
    if (!config.social.discordClientId) {
      throw notImplemented(
        "Discord linking needs TANDEM_DISCORD_CLIENT_ID. Create an app at " +
          "https://discord.com/developers/applications, add the redirect URI, and restart.",
      );
    }
    const params = new URLSearchParams({
      client_id: config.social.discordClientId,
      redirect_uri: config.social.discordRedirectUri,
      response_type: "code",
      scope: "identify guilds",
      state,
      prompt: "consent",
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  if (network === "facebook") {
    if (!config.social.facebookAppId) {
      throw notImplemented(
        "Facebook linking needs TANDEM_FACEBOOK_APP_ID. Register an app at " +
          "https://developers.facebook.com/, add the redirect URI, and restart.",
      );
    }
    const params = new URLSearchParams({
      client_id: config.social.facebookAppId,
      redirect_uri: config.social.facebookRedirectUri,
      response_type: "code",
      scope: "public_profile",
      state,
    });
    return `https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`;
  }

  throw badRequest(`${network} does not use OAuth in Tandem.`);
}

export type OAuthIdentity = { subject: string; handle: string; evidenceUrl: string | null };

/** Exchange an authorization code for the identity behind it. */
export async function exchangeOAuthCode(
  config: Config,
  network: string,
  code: string,
  fetcher: FetchLike = fetch,
): Promise<OAuthIdentity> {
  if (network === "discord") {
    const secret = process.env.TANDEM_DISCORD_CLIENT_SECRET;
    if (!config.social.discordClientId || !secret) {
      throw notImplemented("Set TANDEM_DISCORD_CLIENT_ID and TANDEM_DISCORD_CLIENT_SECRET to finish Discord linking.");
    }
    const tokenResponse = await fetcher("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.social.discordClientId,
        client_secret: secret,
        grant_type: "authorization_code",
        code,
        redirect_uri: config.social.discordRedirectUri,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!tokenResponse.ok) throw unavailable("Discord rejected the authorization code.");
    const token = (await tokenResponse.json()) as { access_token?: string };
    if (!token.access_token) throw unavailable("Discord did not return an access token.");

    const meResponse = await fetcher("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!meResponse.ok) throw unavailable("Discord profile could not be read.");
    const me = (await meResponse.json()) as { id?: string; username?: string };
    if (!me.id) throw unavailable("Discord did not return a user id.");
    return {
      subject: me.id,
      handle: me.username ? `${me.username}` : me.id,
      evidenceUrl: null,
    };
  }

  if (network === "facebook") {
    const secret = process.env.TANDEM_FACEBOOK_APP_SECRET;
    if (!config.social.facebookAppId || !secret) {
      throw notImplemented("Set TANDEM_FACEBOOK_APP_ID and TANDEM_FACEBOOK_APP_SECRET to finish Facebook linking.");
    }
    const params = new URLSearchParams({
      client_id: config.social.facebookAppId,
      client_secret: secret,
      redirect_uri: config.social.facebookRedirectUri,
      code,
    });
    const tokenResponse = await fetcher(`https://graph.facebook.com/v19.0/oauth/access_token?${params.toString()}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!tokenResponse.ok) throw unavailable("Facebook rejected the authorization code.");
    const token = (await tokenResponse.json()) as { access_token?: string };
    if (!token.access_token) throw unavailable("Facebook did not return an access token.");

    const meResponse = await fetcher(
      `https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${encodeURIComponent(token.access_token)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!meResponse.ok) throw unavailable("Facebook profile could not be read.");
    const me = (await meResponse.json()) as { id?: string; name?: string };
    if (!me.id) throw unavailable("Facebook did not return a user id.");
    return { subject: me.id, handle: me.name ?? me.id, evidenceUrl: null };
  }

  throw badRequest(`${network} does not use OAuth in Tandem.`);
}

export function newOAuthState(): string {
  return newNonce(16);
}
