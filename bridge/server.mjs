// Claude Usage Bridge
// Reads the Claude Code OAuth token from ~/.claude/.credentials.json, calls the
// undocumented Anthropic usage endpoint, caches the result, and serves a
// normalized, token-free JSON payload to the iCUE Xeneon Edge widget over
// localhost.
//
// Refresh policy: read-only by default. Only if the usage call returns 401 does
// the bridge refresh the access token (using the stored refresh token), write
// the rotated credentials back atomically, and retry once.

import http from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT) || 37650;
const HOST = "127.0.0.1";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 180_000;

const CREDENTIALS_PATH =
  process.env.CLAUDE_CREDENTIALS_PATH ||
  path.join(os.homedir(), ".claude", ".credentials.json");

const USAGE_ENDPOINT =
  process.env.USAGE_ENDPOINT || "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Current Claude Code token endpoint, with the legacy one as a fallback.
const TOKEN_ENDPOINTS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/v1/oauth/token",
];
const USER_AGENT = "claude-code/2.1.201 (claude-usage-bridge)";

// Friendly labels for known buckets. Unknown buckets fall back to a label
// derived from the key so new models (e.g. Fable) appear automatically.
const KNOWN_LABELS = {
  seven_day: "All Models",
  seven_day_opus: "Opus",
  seven_day_sonnet: "Sonnet",
  seven_day_haiku: "Haiku",
  seven_day_fable: "Fable",
  seven_day_oauth_apps: "OAuth Apps",
  seven_day_cowork: "Cowork",
};

let cache = null; // { at: number, payload: object }
let inflight = null; // shared upstream request promise
let blockedUntil = 0; // epoch ms; no upstream calls before this after a 429
let backoffMs = 0;
const BACKOFF_MIN_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function labelForKey(key) {
  if (KNOWN_LABELS[key]) return KNOWN_LABELS[key];
  return key
    .replace(/^seven_day_/, "")
    .replace(/^five_hour_?/, "")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function isBucket(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.utilization === "number" &&
    Number.isFinite(value.utilization)
  );
}

function clampPct(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  // Endpoint reports 0..100; clamp defensively.
  return Math.max(0, Math.min(100, n));
}

function normalizeBucket(raw) {
  if (!isBucket(raw)) return null;
  return {
    utilization: clampPct(raw.utilization),
    resets_at: typeof raw.resets_at === "string" ? raw.resets_at : null,
  };
}

// Build a widget bucket ({ utilization, resets_at }) from a limits[] entry.
function bucketFromLimit(limit) {
  if (!limit || typeof limit !== "object") return null;
  const pct = clampPct(limit.percent);
  if (pct === null) return null;
  return {
    utilization: pct,
    resets_at: typeof limit.resets_at === "string" ? limit.resets_at : null,
  };
}

// Human label for a scoped weekly limit (per-model). Prefers the model's
// display name, then the surface, then a generic fallback.
function labelForScopedLimit(limit) {
  const scope = limit && limit.scope;
  if (scope && scope.model && typeof scope.model.display_name === "string" && scope.model.display_name) {
    return scope.model.display_name;
  }
  if (scope && typeof scope.surface === "string" && scope.surface) {
    return scope.surface;
  }
  return "Model";
}

// Derive session / weeklyAll / models from the modern limits[] array (used by
// the Claude app). Returns null if limits[] is absent/empty so the caller can
// fall back to the legacy bucket keys.
function normalizeFromLimits(raw) {
  const limits = Array.isArray(raw.limits) ? raw.limits : null;
  if (!limits || limits.length === 0) return null;

  let session = null;
  let weeklyAll = null;
  const models = [];

  for (const limit of limits) {
    if (!limit || typeof limit !== "object") continue;
    const kind = limit.kind;
    if (kind === "session") {
      session = session || bucketFromLimit(limit);
    } else if (kind === "weekly_all") {
      weeklyAll = weeklyAll || bucketFromLimit(limit);
    } else if (limit.group === "weekly") {
      // Any other weekly entry is a scoped (per-model) limit, e.g. Fable.
      const bucket = bucketFromLimit(limit);
      if (!bucket) continue;
      models.push({
        key: (limit.scope && limit.scope.model && limit.scope.model.id) || labelForScopedLimit(limit),
        label: labelForScopedLimit(limit),
        is_active: Boolean(limit.is_active),
        ...bucket,
      });
    }
  }

  // Most relevant first: active limits, then higher utilization, so a display
  // cap keeps the models that actually matter.
  models.sort((a, b) => {
    if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
    if (b.utilization !== a.utilization) return b.utilization - a.utilization;
    return a.label.localeCompare(b.label);
  });

  // Fall back to legacy buckets for session/weekly if the array omitted them.
  if (!session) session = normalizeBucket(raw.five_hour);
  if (!weeklyAll) weeklyAll = normalizeBucket(raw.seven_day);

  return { session, weeklyAll, models };
}

// Legacy shape: per-model data lived in top-level keys like seven_day_fable.
function normalizeFromBuckets(raw) {
  const session = normalizeBucket(raw.five_hour);
  const weeklyAll = normalizeBucket(raw.seven_day);

  const skip = new Set(["five_hour", "seven_day", "extra_usage"]);
  const models = [];
  for (const [key, value] of Object.entries(raw)) {
    if (skip.has(key)) continue;
    const bucket = normalizeBucket(value);
    if (!bucket) continue; // ignore null / non-utilization buckets
    models.push({ key, label: labelForKey(key), ...bucket });
  }
  // Stable, readable order: known labels first (in map order), then the rest.
  const order = Object.keys(KNOWN_LABELS);
  models.sort((a, b) => {
    const ia = order.indexOf(a.key);
    const ib = order.indexOf(b.key);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.label.localeCompare(b.label);
  });

  return { session, weeklyAll, models };
}

function normalizeUsage(raw) {
  const derived = normalizeFromLimits(raw) || normalizeFromBuckets(raw);
  const { session, weeklyAll, models } = derived;

  let extraUsage = null;
  const eu = raw.extra_usage;
  if (eu && typeof eu === "object") {
    extraUsage = {
      is_enabled: Boolean(eu.is_enabled),
      monthly_limit: typeof eu.monthly_limit === "number" ? eu.monthly_limit : null,
      used_credits: typeof eu.used_credits === "number" ? eu.used_credits : null,
      utilization: clampPct(eu.utilization),
    };
  }

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    session,
    weeklyAll,
    models,
    extraUsage,
  };
}

async function readCredentials() {
  const text = await readFile(CREDENTIALS_PATH, "utf8");
  const json = JSON.parse(text);
  const oauth = json.claudeAiOauth;
  if (!oauth || !oauth.accessToken) {
    const err = new Error(
      "No claudeAiOauth block in credentials file (API-key mode or not logged in)."
    );
    err.code = "NO_OAUTH";
    throw err;
  }
  return { json, oauth };
}

// Atomic write: write to a temp file in the same directory, then rename over the
// original. rename() is atomic on NTFS, so no reader ever sees a partial file.
async function writeCredentialsAtomic(json) {
  const dir = path.dirname(CREDENTIALS_PATH);
  const tmp = path.join(dir, `.credentials.${crypto.randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmp, JSON.stringify(json, null, 2), { mode: 0o600 });
  await rename(tmp, CREDENTIALS_PATH);
}

async function refreshToken(refreshTokenValue) {
  let lastErr = null;
  for (const endpoint of TOKEN_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshTokenValue,
          client_id: CLAUDE_CODE_CLIENT_ID,
        }),
      });
      if (!res.ok) {
        lastErr = new Error(`refresh ${endpoint} -> ${res.status}`);
        // invalid_grant means the refresh token is dead; no point trying others.
        if (res.status === 400 || res.status === 401) {
          lastErr.code = "INVALID_GRANT";
          throw lastErr;
        }
        continue;
      }
      const data = await res.json();
      if (!data.access_token) {
        lastErr = new Error(`refresh ${endpoint} -> missing access_token`);
        continue;
      }
      return data;
    } catch (err) {
      if (err.code === "INVALID_GRANT") throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error("token refresh failed");
}

async function callUsage(accessToken) {
  return fetch(USAGE_ENDPOINT, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": BETA_HEADER,
      "User-Agent": USER_AGENT,
    },
  });
}

// Fetch fresh usage from Anthropic. Returns { payload } on success, or throws an
// Error with .code and optional .retryAfterMs.
async function fetchUsage() {
  const { json, oauth } = await readCredentials();

  let res = await callUsage(oauth.accessToken);

  if (res.status === 401) {
    // Access token likely expired. Refresh once and retry.
    if (!oauth.refreshToken) {
      const err = new Error("401 from usage endpoint and no refresh token available.");
      err.code = "UNAUTHORIZED";
      throw err;
    }
    log("usage 401 -> refreshing token");
    let refreshed;
    try {
      refreshed = await refreshToken(oauth.refreshToken);
    } catch (err) {
      if (err.code === "INVALID_GRANT") {
        const e = new Error("Refresh token rejected (invalid_grant). Run `claude` to sign in again.");
        e.code = "INVALID_GRANT";
        throw e;
      }
      throw err;
    }

    // Persist rotated credentials (re-read first so we merge into the latest
    // on-disk state in case Claude Code also updated it).
    try {
      const latest = await readCredentials();
      const updated = latest.json;
      updated.claudeAiOauth = {
        ...latest.oauth,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token || latest.oauth.refreshToken,
        expiresAt: refreshed.expires_in
          ? Date.now() + refreshed.expires_in * 1000
          : latest.oauth.expiresAt,
      };
      await writeCredentialsAtomic(updated);
      log("token refreshed and written back");
    } catch (err) {
      // If write fails we can still use the new token in-memory for this request.
      log("warning: could not write refreshed credentials:", err.message);
    }

    res = await callUsage(refreshed.access_token);
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const rlHeaders = [...res.headers.entries()]
      .filter(([k]) => k === "retry-after" || k.includes("ratelimit"))
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    let body = "";
    try {
      body = (await res.text()).slice(0, 200);
    } catch {}
    log(`usage 429 headers[${rlHeaders}] body[${body}]`);
    const err = new Error("Rate limited by Anthropic usage endpoint (429).");
    err.code = "RATE_LIMITED";
    err.retryAfterMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`Usage endpoint returned ${res.status}.`);
    err.code = "HTTP_" + res.status;
    throw err;
  }

  const raw = await res.json();
  return { payload: normalizeUsage(raw) };
}

function failurePayload(code, message, retryAt) {
  const extra = retryAt ? { retryAt: new Date(retryAt).toISOString() } : {};
  if (cache) {
    return { ...cache.payload, stale: true, error: code, ...extra };
  }
  return {
    ok: false,
    error: code,
    message,
    fetchedAt: new Date().toISOString(),
    ...extra,
  };
}

// One upstream attempt, with backoff bookkeeping. Shared by all callers.
async function refreshUsage() {
  try {
    const { payload } = await fetchUsage();
    cache = { at: Date.now(), payload };
    blockedUntil = 0;
    backoffMs = 0;
    return payload;
  } catch (err) {
    if (err.code === "RATE_LIMITED") {
      backoffMs = err.retryAfterMs
        ? err.retryAfterMs
        : Math.min(backoffMs ? backoffMs * 2 : BACKOFF_MIN_MS, BACKOFF_MAX_MS);
      blockedUntil = Date.now() + backoffMs;
      log(`rate limited; backing off ${Math.round(backoffMs / 1000)}s`);
    } else {
      log(`fetch failed (${err.code || err.message})`);
    }
    return failurePayload(err.code || "ERROR", err.message, blockedUntil || 0);
  }
}

// Returns a payload to serve, using cache / backoff / in-flight dedupe.
async function getUsage() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return { payload: cache.payload, cached: true };
  }
  if (now < blockedUntil) {
    return {
      payload: failurePayload("RATE_LIMITED", "Backing off after 429.", blockedUntil),
      cached: true,
    };
  }
  if (!inflight) {
    inflight = refreshUsage().finally(() => {
      inflight = null;
    });
  }
  return { payload: await inflight, cached: false };
}

const server = http.createServer(async (req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ ok: true, service: "claude-usage-bridge", port: PORT }));
    return;
  }

  if (url.pathname === "/usage") {
    const { payload } = await getUsage();
    const status = payload.ok === false ? 502 : 200;
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...cors,
    });
    res.end(JSON.stringify(payload));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json", ...cors });
  res.end(JSON.stringify({ ok: false, error: "NOT_FOUND" }));
});

server.listen(PORT, HOST, () => {
  log(`Claude Usage Bridge listening on http://${HOST}:${PORT}`);
  log(`Credentials: ${CREDENTIALS_PATH}`);
  log(`Endpoints: GET /usage , GET /health`);
});
