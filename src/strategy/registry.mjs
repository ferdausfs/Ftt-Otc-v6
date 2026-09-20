/**
 * Indicator registry — the seam where every signal source plugs in.
 *
 * CFD message contract (user requirement 2026-09-19/20): the scanner is
 * indicator-AGNOSTIC. It runs every enabled registry entry over the same
 * candle window, and each indicator speaks ONLY its own output in its own
 * words (UT Bot says BUY/SELL; Multi Kernel Regression says Up/Down — the
 * exact labels the TradingView script draws). When several indicators fire
 * on the same closed candle, ONE combined message lists each line — no
 * expiry, no win/loss, no cross-indicator interpretation is ever added.
 *
 * Adding a future indicator = append one entry here (+ a formatter in
 * push.js + optional per-pair config keys). The scan loop, KV plumbing,
 * push mechanics and history ledger stay untouched.
 *
 * Registry entry contract:
 *   id          stable config id (KV config key: indicators.<id>)
 *   name        human name (combined-message lines, history records)
 *   engineTag   value written to history records' `engine` field
 *   defaultCfg  per-pair defaults for this indicator (merged under KV cfg)
 *   compute(candles, cfg, meta)
 *               -> { events: [{ i, t, closeT, type, price, ...audit }] }
 *               `type` is the indicator's NATIVE event kind
 *               (utbot: 'buy'|'sell', mkr: 'up'|'down')
 *   toSignal(event, pair, icfg, extra)
 *               event -> CFD signal object (finalSignal BUY/SELL; the
 *               indicator's own vocabulary rides in `audit` untouched)
 *   eventLabel(type)      the indicator's own chart label, display form
 *   cfdDirection(type)    CFD ledger direction: 'BUY' | 'SELL'
 *   detail(audit)         one-line detail for combined Telegram messages
 *   snapshot(series, i, icfg)
 *               per-candle state for the latest-cache / API responses
 */

import { computeUtBot, eventToSignal } from './utBotAlerts.mjs';
import { computeMultiKernelRegression, mkrEventToSignal } from './multiKernelRegression.mjs';

export const INDICATORS = [
  {
    id: 'utbot',
    name: 'UT Bot Alerts',
    engineTag: 'UT-BOT',
    defaultCfg: { enabled: true },
    compute(candles, cfg, meta) {
      return computeUtBot(candles, { a: cfg.a, c: cfg.c }, meta);
    },
    toSignal(event, pair, icfg, extra = {}) {
      return eventToSignal(event, pair, { ...extra, a: icfg.a, c: icfg.c });
    },
    snapshot(series, i, icfg) {
      return {
        event: series.buy[i] ? 'buy' : series.sell[i] ? 'sell' : null,
        atr: series.atr[i],
        stop: series.stop[i],
        pos: series.pos[i],
      };
    },
    eventLabel(type) { return type === 'buy' ? 'BUY' : 'SELL'; },
    cfdDirection(type) { return type === 'buy' ? 'BUY' : 'SELL'; },
    detail(audit) {
      if (!audit || audit.stop === undefined || audit.stop === null) return '';
      return 'trailing stop ' + audit.stop;
    },
  },
  {
    id: 'mkr',
    name: 'Multi Kernel Regression',
    engineTag: 'MKR',
    defaultCfg: { enabled: true, kernel: 'Laplace', bandwidth: 14 },
    compute(candles, cfg, meta) {
      return computeMultiKernelRegression(candles, {
        kernel: cfg.kernel,
        bandwidth: cfg.bandwidth,
      }, meta);
    },
    toSignal(event, pair, icfg, extra = {}) {
      return mkrEventToSignal(event, pair, {
        ...extra, kernel: icfg.kernel, bandwidth: icfg.bandwidth,
      });
    },
    snapshot(series, i, icfg) {
      const ev = series.events.find(e => e.i === i);
      return {
        kernel: icfg.kernel,
        bandwidth: icfg.bandwidth,
        value: series.value[i],
        valuePrev: i > 0 ? series.value[i - 1] : null,
        dirUp: series.dirUp[i],
        event: ev ? ev.type : null,
        stdev: series.stdev[i],
      };
    },
    eventLabel(type) { return type === 'up' ? 'UP' : 'DOWN'; },
    cfdDirection(type) { return type === 'up' ? 'BUY' : 'SELL'; },
    detail(audit) {
      if (!audit) return '';
      return 'kernel MA ' + audit.value
        + (audit.kernel ? ' (' + audit.kernel + ' x' + audit.bandwidth + ')' : '');
    },
  },
];

export const INDICATOR_BY_ID = Object.fromEntries(INDICATORS.map(i => [i.id, i]));
