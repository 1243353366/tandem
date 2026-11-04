/**
 * Runtime configuration.
 *
 * Every secret comes from the environment. Nothing here has a production
 * default: if `TANDEM_PEPPER` is missing and we are not explicitly in dev mode,
 * the process refuses to start. A silent fallback pepper is how consent
 * receipts quietly stop being verifiable.
 */

export const POLICY_VERSION = "2026-11-01";

export type Config = {
  port: number;
  host: string;
  dbPath: string;
  matcherUrl: string;
  pepper: string;
  dev: boolean;
  policyVersion: string;
  publicBaseUrl: string;
  otp: { ttlSeconds: number; maxAttempts: number; maxPerHour: number };
  social: {
    proofTtlSeconds: number;
    discordClientId: string;
    discordRedirectUri: string;
    facebookAppId: string;
    facebookRedirectUri: string;
  };
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`environment variable ${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function envStr(name: string, fallback = ""): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  // Overrides count as explicit intent, including for the dev-mode escape hatch,
  // so a test harness can run without exporting env vars first.
  const dev = overrides.dev ?? envStr("TANDEM_DEV", "0") === "1";
  const pepper = overrides.pepper || envStr("TANDEM_PEPPER");

  if (!pepper && !dev) {
    throw new Error(
      "TANDEM_PEPPER is required. Generate one with: openssl rand -hex 32 " +
        "(or set TANDEM_DEV=1 for a throwaway local run).",
    );
  }

  const config: Config = {
    port: envInt("PORT", 8080),
    host: envStr("HOST", "127.0.0.1"),
    dbPath: envStr("TANDEM_DB", "data/tandem.db"),
    matcherUrl: envStr("MATCHER_URL", "http://127.0.0.1:8081"),
    pepper: pepper || "dev-only-pepper-not-for-real-data",
    dev,
    policyVersion: envStr("TANDEM_POLICY_VERSION", POLICY_VERSION),
    publicBaseUrl: envStr("TANDEM_PUBLIC_URL", "http://127.0.0.1:8080"),
    otp: {
      ttlSeconds: envInt("TANDEM_OTP_TTL_SECONDS", 600),
      maxAttempts: envInt("TANDEM_OTP_MAX_ATTEMPTS", 5),
      maxPerHour: envInt("TANDEM_OTP_MAX_PER_HOUR", 5),
    },
    social: {
      proofTtlSeconds: envInt("TANDEM_PROOF_TTL_SECONDS", 60 * 60 * 24),
      discordClientId: envStr("TANDEM_DISCORD_CLIENT_ID"),
      discordRedirectUri: envStr(
        "TANDEM_DISCORD_REDIRECT_URI",
        `${envStr("TANDEM_PUBLIC_URL", "http://127.0.0.1:8080")}/v1/social/discord/callback`,
      ),
      facebookAppId: envStr("TANDEM_FACEBOOK_APP_ID"),
      facebookRedirectUri: envStr(
        "TANDEM_FACEBOOK_REDIRECT_URI",
        `${envStr("TANDEM_PUBLIC_URL", "http://127.0.0.1:8080")}/v1/social/facebook/callback`,
      ),
    },
    ...overrides,
  };

  // A deployment with no SMS route says "code sent" and sends nothing, which looks
  // exactly like success until a real person is stuck. Fail at startup instead of
  // at the first verification.
  if (!config.dev && !envStr("TANDEM_SMS_WEBHOOK")) {
    throw new Error(
      "TANDEM_SMS_WEBHOOK is not set, so phone verification would deliver nothing while " +
        'reporting success. Point it at a URL that accepts {"to", "body"}, or set TANDEM_DEV=1 ' +
        "for a local run where codes come back in the response.",
    );
  }

  return config;
}
