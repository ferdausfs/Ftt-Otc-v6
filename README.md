# FTT Signal Worker v6.9.1

Cloudflare Workers-based multi-timeframe binary options signal engine.
Supports Forex, Crypto, and OTC (Olymp Trade) pairs.

## Repo Structure

```
src/
├── index.js                  ← Main entry point (router + scheduled)
├── config.js                 ← All constants & configuration
│
├── utils/
│   ├── helpers.js            ← safeLastValue, fmt, r2, jsonResponse, etc.
│   ├── cors.js               ← CORS headers & applyCors
│   ├── pairs.js              ← sanitizePair, getAssetType, isExoticPair
│   └── session.js            ← detectTradingSession, checkNewsBlackout
│
├── indicators/
│   ├── math.js               ← EMA, RSI, MACD, ATR, BB, Stoch, ADX, CCI, MFI, Pivots, Camarilla
│   ├── patterns.js           ← Candlestick pattern detection
│   ├── divergence.js         ← RSI & MACD divergence
│   ├── sr.js                 ← Support/Resistance + FVG detection
│   ├── regime.js             ← Market regime detection (TRENDING/RANGING/BREAKOUT/VOLATILE)
│   └── index.js              ← calculateAllIndicators (aggregator)
│
├── analysis/
│   ├── filters.js            ← Volume spike, candle consistency, session weight, correlation
│   ├── grade.js              ← Signal grade (A+/A/B/C/D/F) + tie resolution
│   ├── duration.js           ← ATR-based expiry calculation (Forex & OTC)
│   └── otc.js                ← OTC-specific patterns (consecutive candles, wick rejection, round numbers)
│
├── ai/
│   ├── cerebras.js           ← Cerebras AI validation (Forex + OTC)
│   ├── groq.js               ← Groq AI validation (Forex)
│   └── combine.js            ← Dual-AI result combiner + indicator snapshot builder
│
├── fetch/
│   ├── keys.js               ← API key extraction (JSON array / individual vars)
│   └── candles.js            ← TwelveData candle fetch with KV cache
│
├── signal/
│   ├── timeframe.js          ← analyzeTimeframe (all 11 categories)
│   ├── engine.js             ← buildMultiTimeframeSignal (Forex/Crypto)
│   └── otcEngine.js          ← buildMultiTimeframeSignalOTC
│
├── history/
│   └── stats.js              ← Save signals, WIN/LOSS tracking, pair stats, dynamic confidence
│
├── middleware/
│   └── rateLimit.js          ← Rate limiting (RATE_LIMITER binding or KV fallback)
│
└── handlers/
    ├── signal.js             ← handleSignal, handleSignalRaw, handleBatch, handleSignalRawOTC
    └── health.js             ← handleHealth, handlePairs, handleHistory, handleStats, handleReport
```

## Secrets Required

In Cloudflare dashboard → Workers → fttotcv6 → Settings → Variables:

| Secret | Required | Description |
|--------|----------|-------------|
| `TWELVEDATA_API_KEY` | ✅ | Single key **or** JSON array `["key1","key2"]` |
| `TWELVEDATA_API_KEYS` | optional | JSON array of keys (takes priority) |
| `CEREBRAS_API_KEY` | ✅ | AI validation layer |
| `GROQ_API_KEY` | optional | Second AI validation (Forex only) |

## KV Namespace

Binding: `SIGNAL_CACHE`  
ID: `f553a3f10915478fa1b8165dd58ff6ea`

## GitHub Secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Health check |
| `GET /api/signal?pair=EUR/USD` | Forex/Crypto signal |
| `GET /api/signal?pair=EURUSD-OTC` | OTC signal |
| `GET /api/batch?pairs=EUR/USD,GBP/JPY` | Batch signals (max 3) |
| `GET /api/pairs` | List supported pairs |
| `GET /api/history?pair=EUR/USD&limit=20` | Signal history |
| `GET /api/stats?pair=EUR/USD` | Win rate stats |
| `GET /api/report?id=ID&result=WIN` | Manual result report |

## Edge feature layer

Standard FOREX/CRYPTO signals include additive `edgeContext` / `timeContext`
(hour/day, RSI-direction state, BB volatility state, ATR percentile,
session-range position, recent form, and adaptive factors). Raw history
instrumentation remains under `signalIndicators`. Thresholds are centralized in
`EDGE_FEATURE_CONFIG`; the weekly 14-day/3-day-holdout refresh is fail-open to
static values. See [`EDGE_FEATURES.md`](EDGE_FEATURES.md) and reproduce the
train→holdout table with `python3 scripts/feature_validation.py --data <root>`.

## Deploy

Push to `main` branch → GitHub Actions deploys automatically via `wrangler-action@v3`.
