# Data contract and governance

## Sources
- Private bank workbook (NEVER publish): `TongHop`, `Ty gia`, `LS ITB`, `LS GTCG`, `VBMA`.
- Provider benchmarks (public, not equivalent to private book quotes): State Bank of Vietnam interbank average as republished by approved feed (`DLPL_API_KEY`, optional), FRED SOFR/DGS10, SBV FX publication mirrored by AllRatesToday. Each value must carry source, observed date, fetched date, and data quality.
- Public rates from a different source can never silently replace internal `Kplus` / internal deal execution quote. They render as a separate *benchmark*.

## Required fields and units
- `date` = ISO YYYY-MM-DD in Asia/Ho_Chi_Minh context.
- `loan_bn`, `invest_gtcg_bn`, `ld_scale_bn`, `gtcg_scale_bn`, `pnl_bn`: billion VND.
- `itb_*`, `vbma_*`, `ld_nim_pct`, `gtcg_lsbq_pct`: % per annum.
- `fx_mid`, `fx_bid`, `fx_ask`: VND per USD.
- `trade_finance_bn`: null until Treasury/Risk confirms mapping. Do not assign `Cho vay FI` to Trade Finance.

## Audited formulas carried forward
- Loan = ([VND] Cho Vay in INTERBANK + [USD] Cho Vay * FX mid) / 1e9.
- GTCG investment = (BOND PAP + BOND TRADING + BOND AFS) / 1e9.
- Secured = (Cho vay TSDB VND + Cho vay TSDB USD * FX mid) / 1e9.
- Unsecured = (Cho vay tin chap vnd + Cho vay tin chap USD * FX mid) / 1e9.
- Reso = ([VND] RESO) / 1e9.
- Swap residual = Loan - GTCG investment - Reso - Secured - Unsecured.
- L&D size = Secured + Unsecured.
- L&D NIM = LS cho vay BQ VND - LS di vay BQ VND, where loan balance > 0.
- GTCG size = (BOND TRADING + BOND PAP - CD maturity VND) / 1e9. This is NOT the same as the GTCG investment decomposition.
- Recon gap = Loan - (GTCG investment + Reso + Secured + Unsecured + Swap + Trade Finance). When Trade Finance is nonzero, the current residual formula must be reviewed.

## Missing interest rates
1. Show actual source points only if rate, tenor, date, provider and unit are known.
2. A same-semantic source, same benchmark and same date may fill an internal missing reference point if source is explicitly displayed and provenance preserved.
3. A *different-semantic* official SBV interbank average is displayed as a separate reference line, not spliced into internal Kplus, VBMA swap or proprietary transaction quotes.
4. Optional display-only forward carry for at most three calendar days is marked `CARRIED / CHỈ ĐỂ VẼ` and never used to calculate KPIs, NIM, realized revenue or risk.
5. If no valid quote is available, return `null`. Never invent rates or interpolate for official reports.
6. Freshness warnings at >7 days; avoid carrying VBMA TPCP 26/05/2025 into 2026 as if observed.

## Security
- Public Vercel deployment must use synthetic demo data and public market data only.
- Browser imports are processed only client-side, not posted to the server. No localStorage/sessionStorage for private data.
- AI API receives user question and public-source metadata only; bank holdings or imported rows are NOT transmitted.
- For production with bank data, use approved internal platform, authentication, permission checks, audit logs and licensed data agreements.
