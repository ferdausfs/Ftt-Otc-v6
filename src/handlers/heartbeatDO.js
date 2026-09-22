/**
 * Durable Object alarm heartbeat (MULTI-IND-v1.8.0) — the in-worker,
 * traffic-independent watchdog invocation path.
 *
 * WHY: the platform cron trigger has gone silent before (2026-09-20, ~5h)
 * and the scan watchdog was only invoked by organic HTTP traffic. External
 * pingers (GitHub Actions heartbeat.yml) fix that but depend on a third
 * party scheduler. A Durable Object ALARM is the primitive Cloudflare
 * documents as more reliable than Cron Triggers for exactly this use case:
 * alarms fire even with ZERO requests, survive deploys (storage/alarm state
 * is preserved), and retry with backoff if the handler fails.
 *
 * Design (purely additive — if this DO ever breaks, nothing else breaks):
 *   - alarm() runs runScanWatchdog() (lock-guarded, no-op when fresh) and
 *     then re-arms itself for the next interval. The re-arm happens AFTER
 *     the check, so a slow catch-up scan can never pile up alarms.
 *   - POST /ping (classic fetch-based DO interface — RPC over bindings would
 *     require `extends DurableObject`, which drags `cloudflare:workers` into
 *     the Node test suite; plain classes + fetch keep everything portable)
 *     bootstraps: arms the first alarm only if none is pending. Cheap: one
 *     getAlarm.
 *   - If the alarm chain ever dies, the next scheduled tick or /watchdog
 *     ping re-arms it.
 *
 * The alarm handler gets NO execution ctx — runScanWatchdog only uses ctx
 * for opportunistic cache writes, which are guarded (candles.js checks
 * `ctx &&`) or shimmed below.
 */

import { runScanWatchdog } from './scan.js';

const HB_INTERVAL_MS = 5 * 60 * 1000;   // ping the watchdog every 5 minutes
const HB_FIRST_DELAY_MS = 30 * 1000;    // arm ~30s after bootstrap
const HB_TICK_KEY = 'scan:heartbeat:tick';   // KV breadcrumb for /health
const HB_TICK_EVERY_MS = 15 * 60 * 1000;     // KV-write throttle (96/day)

export class HeartbeatDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async alarm() {
    // Minimal ctx shim: scan plumbing may ctx.waitUntil() background cache
    // writes; in a DO alarm there is no waitUntil, so just let them run.
    const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
    try {
      const r = await runScanWatchdog(this.env, ctx);
      console.log('HeartbeatDO alarm tick: watchdog ' + JSON.stringify({ ran: r && r.ran, reason: r && r.reason }));
    } catch (e) {
      console.warn('HeartbeatDO alarm: watchdog error: ' + e.message);
    }
    await this.breadcrumb();
    try {
      await this.state.storage.setAlarm(Date.now() + HB_INTERVAL_MS);
    } catch (e) {
      console.warn('HeartbeatDO re-arm failed: ' + e.message);
    }
  }

  /**
   * Positive liveness breadcrumb: DO alarm logs do NOT reliably reach
   * `wrangler tail`, so "silence" proves nothing. Every ~15 min the tick
   * stamps KV (TTL 30 min) and /health surfaces it — if
   * watchdog.heartbeat.lastTickAt is older than ~30 min, the alarm chain
   * is dead and must be re-bootstrapped (any scheduled tick / /watchdog
   * ping does that automatically).
   */
  async breadcrumb() {
    try {
      const now = Date.now();
      const last = (await this.state.storage.get('lastTick')) || 0;
      if (now - last >= HB_TICK_EVERY_MS) {
        await this.state.storage.put('lastTick', now);
        if (this.env && this.env.SIGNAL_CACHE) {
          await this.env.SIGNAL_CACHE.put(HB_TICK_KEY, String(now), { expirationTtl: 1800 });
        }
      }
    } catch (e) {
      console.warn('HeartbeatDO breadcrumb failed: ' + e.message + ' | stack: ' + (e.stack || '').split('\n')[1]);
    }
  }

  /**
   * Classic fetch-based DO interface (no RPC): POST /ping bootstraps the
   * alarm chain — arm the first alarm if none is pending.
   */
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/ping') {
      try {
        const current = await this.state.storage.getAlarm();
        if (current === null) {
          await this.state.storage.setAlarm(Date.now() + HB_FIRST_DELAY_MS);
        }
        return Response.json({ armed: (await this.state.storage.getAlarm()) !== null });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }
}

/**
 * Bootstrap from scheduled()/fetch paths. Never throws; returns null when
 * the DO binding is absent (e.g. removed binding or failed migration).
 */
export async function bootstrapHeartbeat(env) {
  if (!env || !env.HEARTBEAT) return null;
  try {
    const stub = env.HEARTBEAT.get(env.HEARTBEAT.idFromName('scan-heartbeat'));
    const res = await stub.fetch('https://heartbeat-do/ping', { method: 'POST' });
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}
