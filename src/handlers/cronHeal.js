/**
 * Cron-trigger self-healing (MULTI-IND-v1.8.0) — root-cause countermeasure
 * for the silent-cron failure class documented in commit 2599bb0 and
 * AGENT_LOG.md (2026-09-22).
 *
 * WHY THIS EXISTS (the investigated root causes):
 *   1. `wrangler deploy` REPLACES the worker's entire cron-trigger set with
 *      whatever `wrangler.toml` currently declares. This repo rewrote the
 *      crons array SEVEN times (every-minute, then every-2, adding every-5,
 *      a weekly reset, dropping to the 15-min scanner only — see git log),
 *      so every one of those deploys was a moment a trigger could silently
 *      vanish. Any deploy from a config missing/changing [triggers] deletes
 *      the live schedule with NO error and NO log.
 *   2. Platform-side trigger silence (2026-09-20 07:15-11:59 UTC): fetch,
 *      push and webhook kept working while scheduled invocations stopped —
 *      not caused by config drift, only detectable after the fact.
 *
 * This module gives the WORKER (not the operator) the ability to read its
 * own schedule set through the Cloudflare API and restore the expected
 * crons if they are missing. It runs:
 *   - on every staleness detection (src/handlers/scan.js watchdog), and
 *   - proactively once per hour even when the scan looks fresh (the
 *     heartbeat can keep the scan alive through catch-ups, which would
 *     otherwise mask a dead trigger forever).
 *
 * Credentials: env.CF_API_TOKEN + env.CF_ACCOUNT_ID (worker secrets) and
 * env.WORKER_NAME (wrangler.toml [vars]). Without credentials the check is
 * skipped cleanly ({ checked: false }) — the watchdog never depends on it.
 */

const CF_API = 'https://api.cloudflare.com/client/v4';

/** The schedule set this worker must always have (mirrors wrangler.toml). */
export const EXPECTED_CRONS = ['*/15 * * * *'];

export function cronScriptName(env) {
  return env && env.WORKER_NAME ? String(env.WORKER_NAME).trim() : 'fttotcv6';
}

function cfCreds(env) {
  const token = env && env.CF_API_TOKEN ? String(env.CF_API_TOKEN).trim() : '';
  const account = env && env.CF_ACCOUNT_ID ? String(env.CF_ACCOUNT_ID).trim() : '';
  return token && account ? { token, account } : null;
}

/** Read the worker's current cron-trigger set. Never throws. */
export async function readCronSchedules(env) {
  const creds = cfCreds(env);
  if (!creds) return { checked: false, reason: 'no cf credentials (CF_API_TOKEN/CF_ACCOUNT_ID)' };
  try {
    const res = await fetch(
      CF_API + '/accounts/' + creds.account + '/workers/scripts/' + encodeURIComponent(cronScriptName(env)) + '/schedules',
      { headers: { Authorization: 'Bearer ' + creds.token }, signal: AbortSignal.timeout(10000) },
    );
    const j = await res.json().catch(() => null);
    if (!j || j.success !== true) {
      const msg = j && j.errors && j.errors[0] ? j.errors[0].message : 'HTTP ' + res.status;
      return { checked: false, reason: 'schedules read failed: ' + msg };
    }
    const crons = (((j.result || {}).schedules) || []).map(s => s && s.cron).filter(Boolean);
    return { checked: true, present: true, crons };
  } catch (e) {
    return { checked: false, reason: 'error: ' + e.message };
  }
}

/**
 * Verify the schedule set contains EXPECTED_CRONS; PUT the expected set back
 * if (and only if) entries are missing. Returns a plain diagnostic object —
 * the caller folds it into the admin alert. Never throws.
 */
export async function verifyAndRepairCronTrigger(env, expectedCrons = EXPECTED_CRONS) {
  const creds = cfCreds(env);
  if (!creds) return { checked: false, reason: 'no cf credentials (CF_API_TOKEN/CF_ACCOUNT_ID)' };
  try {
    const url = CF_API + '/accounts/' + creds.account + '/workers/scripts/'
      + encodeURIComponent(cronScriptName(env)) + '/schedules';
    const getRes = await fetch(url, {
      headers: { Authorization: 'Bearer ' + creds.token },
      signal: AbortSignal.timeout(10000),
    });
    const gj = await getRes.json().catch(() => null);
    if (!gj || gj.success !== true) {
      const msg = gj && gj.errors && gj.errors[0] ? gj.errors[0].message : 'HTTP ' + getRes.status;
      return { checked: false, reason: 'schedules read failed: ' + msg };
    }
    const crons = (((gj.result || {}).schedules) || []).map(s => s && s.cron).filter(Boolean);
    const missing = expectedCrons.filter(c => !crons.includes(c));
    if (missing.length === 0) return { checked: true, present: true, crons };

    // PUT replaces the WHOLE schedule set -> always write the full desired
    // array (idempotent, and removes nothing that should stay).
    const putRes = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + creds.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(expectedCrons.map(cron => ({ cron }))),
      signal: AbortSignal.timeout(10000),
    });
    const pj = await putRes.json().catch(() => null);
    if (pj && pj.success === true) {
      return { checked: true, present: false, repaired: true, missing, crons: expectedCrons };
    }
    const msg = pj && pj.errors && pj.errors[0] ? pj.errors[0].message : 'HTTP ' + putRes.status;
    return { checked: true, present: false, repaired: false, missing, error: msg };
  } catch (e) {
    return { checked: false, reason: 'error: ' + e.message };
  }
}
