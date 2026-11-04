/**
 * Profile validation.
 *
 * Two jobs:
 *   1. Reject junk before it reaches the matcher.
 *   2. Keep contact identifiers out of public fields.
 *
 * Job 2 is a product decision, not a nicety. If "headline" accepts
 * "text me at 555-0134", the platform has quietly become a people-search
 * engine built by its own users, and the first person to notice is the one
 * who didn't want to be found.
 */

import type { Config } from "./config.ts";

export const ROLES = [
  "cofounder",
  "collaborator",
  "study_partner",
  "accountability",
  "mentor",
  "mentee",
  "hobby_group",
  "friend",
] as const;

export const PACES = ["async", "mixed", "sync"] as const;
export const GROUP_SIZES = ["one_on_one", "small", "large"] as const;
export const CHANNELS = ["text", "voice", "video", "in_person"] as const;
export const VISIBILITIES = ["searchable", "unlisted"] as const;

export type FieldError = { field: string; message: string };
export type Result = { ok: true; value: Record<string, unknown> } | { ok: false; errors: FieldError[] };

const PHONE_LIKE = /(?:\+?\d[\s().-]?){9,}/;
const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const HANDLE_LIKE = /(?:^|\s)@[A-Za-z0-9_.]{3,}/;

export function findContactInfo(text: string): string | null {
  if (EMAIL_LIKE.test(text)) return "an email address";
  if (PHONE_LIKE.test(text)) return "a phone number";
  if (HANDLE_LIKE.test(text)) return "a social handle";
  return null;
}

function str(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > max) return null;
  return trimmed;
}

function strList(value: unknown, max: number, eachMax: number): string[] | null {
  if (value === undefined || value === null) return [];
  const raw = typeof value === "string" ? value.split(/[,;]/) : value;
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > eachMax) return null;
    if (!out.includes(trimmed)) out.push(trimmed);
    if (out.length > max) return null;
  }
  return out;
}

function roleList(value: unknown): string[] | null {
  const list = strList(value, 8, 32);
  if (!list) return null;
  const out: string[] = [];
  for (const item of list) {
    const normalized = item.toLowerCase().replace(/[\s-]+/g, "_");
    if (!(ROLES as readonly string[]).includes(normalized)) return null;
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (allowed as readonly string[]).includes(normalized) ? (normalized as T) : fallback;
}

export function validateProfile(
  body: unknown,
  config: Config,
  { partial = false }: { partial?: boolean } = {},
): Result {
  const errors: FieldError[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "_", message: "body must be a JSON object" }] };
  }
  const input = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const push = (field: string, message: string) => errors.push({ field, message });

  const publicText = (field: string, max: number, required = false) => {
    if (!(field in input)) {
      if (required && !partial) push(field, "required");
      return;
    }
    const value = str(input[field], max);
    if (value === null) {
      push(field, `must be a string of at most ${max} characters`);
      return;
    }
    const contact = findContactInfo(value);
    if (contact) {
      push(field, `remove ${contact}: public fields cannot carry contact details. Use the consent flow instead.`);
      return;
    }
    out[field] = value;
  };

  publicText("display_name", 60, true);
  if (typeof out.display_name === "string" && out.display_name.length > 0 && out.display_name.length < 2) {
    push("display_name", "must be at least 2 characters");
  }
  publicText("headline", 120);
  publicText("location_city", 80);
  publicText("location_region", 80);
  publicText("current_project", 200);

  if ("location_country" in input) {
    const country = str(input.location_country, 2);
    if (country === null || (country !== "" && !/^[A-Za-z]{2}$/.test(country))) {
      push("location_country", "must be a two-letter ISO country code");
    } else {
      out.location_country = country ? country.toUpperCase() : "";
    }
  }

  if ("timezone" in input) {
    const tz = str(input.timezone, 64);
    if (tz === null) push("timezone", "must be a string");
    else if (tz && !isKnownTimezone(tz)) push("timezone", "must be an IANA timezone such as America/New_York");
    else out.timezone = tz;
  }

  if ("interests" in input) {
    const list = strList(input.interests, 12, 40);
    if (list === null) push("interests", "must be a list of at most 12 tags, 40 characters each");
    else {
      const contact = list.find((tag) => findContactInfo(tag));
      if (contact) push("interests", `remove ${contact} from tags`);
      else out.interests = list;
    }
  }

  if ("project_tags" in input) {
    const list = strList(input.project_tags, 8, 40);
    if (list === null) push("project_tags", "must be a list of at most 8 tags");
    else out.project_tags = list;
  }

  if ("looking_for" in input) {
    const list = roleList(input.looking_for);
    if (list === null) push("looking_for", `must be a subset of: ${ROLES.join(", ")}`);
    else out.looking_for = list;
  }

  if ("offers" in input) {
    const list = roleList(input.offers);
    if (list === null) push("offers", `must be a subset of: ${ROLES.join(", ")}`);
    else out.offers = list;
  }

  if ("hours_per_week" in input) {
    const value = Number(input.hours_per_week);
    if (!Number.isFinite(value) || value < 0 || value > 80) {
      push("hours_per_week", "must be a number between 0 and 80");
    } else {
      out.hours_per_week = Math.round(value);
    }
  }

  if ("visibility" in input) {
    const value = oneOf(input.visibility, VISIBILITIES, "searchable");
    out.visibility = value;
  }

  if ("comm_style" in input) {
    const raw = input.comm_style;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      push("comm_style", "must be an object");
    } else {
      const comm = raw as Record<string, unknown>;
      const directnessRaw = Number(comm.directness ?? 3);
      const directness = Number.isFinite(directnessRaw)
        ? Math.max(1, Math.min(5, Math.round(directnessRaw)))
        : 3;
      const channels = Array.isArray(comm.prefers)
        ? comm.prefers
            .filter((c): c is string => typeof c === "string")
            .map((c) => oneOf(c, CHANNELS, "text"))
            .filter((c, i, arr) => arr.indexOf(c) === i)
        : [];
      out.comm_style = {
        pace: oneOf(comm.pace, PACES, "mixed"),
        directness,
        group_size: oneOf(comm.group_size, GROUP_SIZES, "small"),
        prefers: channels,
      };
    }
  }

  if (!partial && !("interests" in input)) out.interests = [];
  if (!partial && !("looking_for" in input)) out.looking_for = [];
  if (!partial && !("offers" in input)) out.offers = [];
  if (!partial && !("hours_per_week" in input)) out.hours_per_week = 0;
  if (!partial && !("comm_style" in input)) {
    out.comm_style = { pace: "mixed", directness: 3, group_size: "small", prefers: [] };
  }
  if (!partial && !("visibility" in input)) out.visibility = "searchable";

  // A profile with no goal can never match. Say so at write time rather than
  // letting the person sit in an empty results screen.
  if (!partial && Array.isArray(out.looking_for) && (out.looking_for as string[]).length === 0) {
    push("looking_for", "pick at least one thing you are looking for");
  }

  void config;
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

export function isKnownTimezone(tz: string): boolean {
  if (tz === "UTC") return true;
  if (!/^[A-Za-z]+\/[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
