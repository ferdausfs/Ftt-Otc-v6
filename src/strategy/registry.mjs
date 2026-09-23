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
 *   params[]              editable-parameter descriptors for the Telegram
 *               bot UI (src/handlers/telegramBot.js renders menus from
 *               these — a future indicator's params become editable in
 *               the bot with zero bot-side code):
 *                 key      config key (pair-level for path 'pair',
 *                          indicators.<id>.<key> for path 'ind')
 *                 label    human name shown on the button row
 *                 kind     'number' | 'int' | 'enum'
 *                 min/max  numeric bounds (inclusive)
 *                 presets  quick-pick button values (optional)
 *                 options  enum values (kind 'enum')
 *                 path     'pair' (pairs.<PAIR>.<key>) | 'ind'
 *                          (pairs.<PAIR>.indicators.<id>.<key>)
 *
 * The scanner/pipeline never reads `params` — it is bot-UI metadata only.
 */

import { computeUtBot, eventToSignal } from './utBotAlerts.mjs';
import {
  computeMultiKernelRegression, computeMkrTv, mkrEventToSignal, MKR_KERNELS,
} from './multiKernelRegression.mjs';

export const INDICATORS = [
  {
    id: 'utbot',
    name: 'UT Bot Alerts',
    icon: '\uD83D\uDCC8',
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
    // TradingView inputs: Key Value (a) and ATR Period (c). Pair-level
    // config keys (utbot:config -> pairs.<PAIR>.a / .c).
    params: [
      { key: 'a', label: 'Key Value (a)', icon: '\uD83D\uDD11', kind: 'number', min: 0.1, max: 20,
        presets: [0.5, 1, 1.5, 2, 3], path: 'pair' },
      { key: 'c', label: 'ATR Period (c)', icon: '\uD83D\uDCCF', kind: 'int', min: 1, max: 200,
        presets: [5, 7, 9, 10, 14, 20], path: 'pair' },
    ],
  },
  {
    id: 'mkr',
    name: 'Multi Kernel Regression',
    icon: '\uD83D\uDCCA',
    engineTag: 'MKR',
    // PRODUCTION MODE (owner decision 2026-09-23, v1.9.0): 'nrp' — the
    // script's own NON-REPAINT branch (repaint=false). It analyzes the chart
    // data exactly like UT Bot: a causal kernel MA whose value at bar N
    // depends only on bars <= N, firing each Up/Down label at the flip bar's
    // OWN close — no detection delay, no reshape, deterministic history.
    // The previous default 'tv' (the chart-default repaint branch) anchored
    // labels one candle back and re-fit them every bar, so the bot kept
    // delivering signals the chart had shown long before (owner report:
    // "MKR gives the sell the chart gave long ago, whenever UT Bot fires").
    // 'tv' stays selectable per pair from the bot panel for chart-parity
    // comparison — but causal timeliness beats chart parity (standing rule).
    defaultCfg: { enabled: true, mode: 'nrp', kernel: 'Laplace', bandwidth: 14 },
    compute(candles, cfg, meta) {
      const common = { kernel: cfg.kernel, bandwidth: cfg.bandwidth, deviations: cfg.deviations };
      return cfg.mode === 'nrp'
        ? computeMultiKernelRegression(candles, common, meta)
        : computeMkrTv(candles, common, meta);
    },
    toSignal(event, pair, icfg, extra = {}) {
      return mkrEventToSignal(event, pair, {
        ...extra, mode: icfg.mode, kernel: icfg.kernel, bandwidth: icfg.bandwidth,
      });
    },
    snapshot(series, i, icfg) {
      const ev = series.events.find(e => e.i === i);
      return {
        mode: icfg.mode,
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
    // TradingView inputs: Mode (branch) + Kernel select + Bandwidth.
    // Indicator-level config keys (utbot:config -> pairs.<PAIR>.indicators.mkr.<key>).
    params: [
      { key: 'mode', label: 'Mode', icon: '\uD83E\uDDED', kind: 'enum', options: ['tv', 'nrp'],
        perRow: 2, path: 'ind' },
      { key: 'kernel', label: 'Kernel', icon: '\uD83C\uDF08', kind: 'enum', options: MKR_KERNELS,
        perRow: 1, path: 'ind' },
      { key: 'bandwidth', label: 'Bandwidth', icon: '\u2194\uFE0F', kind: 'int', min: 1, max: 200,
        presets: [7, 10, 14, 20, 28, 50], path: 'ind' },
    ],
  },
];

export const INDICATOR_BY_ID = Object.fromEntries(INDICATORS.map(i => [i.id, i]));
