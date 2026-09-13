# Provenance — External regime sources (Task 25, ML sentiment/macro)

Pre-registered in experiments/ml/PRE_REGISTRATION_SENTIMACRO.md §4 (commit 4c08e9f).
Raw files are NOT committed; these sha256 pins bind the bytes the pipeline used.

- **DFF**: https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF&cosd=2021-07-01&coed=2026-09-05
  - fetched 2026-09-13T04:27:11.222Z · 30309 bytes · sha256 `7dab8f7573c181c7b8c901cdc99d544f35e60039bd87cb76405d5475834b7842` → backtest/data/external/fred_DFF.csv
- **T10Y2Y**: https://fred.stlouisfed.org/graph/fredgraph.csv?id=T10Y2Y&cosd=2021-07-01&coed=2026-09-05
  - fetched 2026-09-13T04:27:11.960Z · 21969 bytes · sha256 `4ca9c7482cef6c7318ddbdaeeb1539fed091a459e4b36aefaf7aa3f2cce54c77` → backtest/data/external/fred_T10Y2Y.csv
- **FNG**: https://api.alternative.me/fng/?limit=0&format=json
  - fetched 2026-09-13T04:27:12.930Z · 230515 bytes · sha256 `8128362bbadf9d1e8747a19e644841aab58987752b286995cfb04a3c38144515` → backtest/data/external/fng_full.json

Pinning rules (enforced in features_lib.mjs, tested in leakage_sentimacro_tests.mjs):
- FRED observation dated business day D → knowable from next business day at 21:30 UTC (DFF weekend calendar-fill rows dropped; '.' rows dropped).
- F&G value stamped D → knowable from D+1 00:00 UTC.
