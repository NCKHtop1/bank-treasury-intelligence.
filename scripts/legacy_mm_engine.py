from __future__ import annotations

import json
import math
import os
import threading
import time
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd
import plotly
from plotly.offline.offline import get_plotlyjs
from fastapi import FastAPI, Query
from fastapi.responses import HTMLResponse, JSONResponse
import uvicorn

# =========================================================
# CONFIGURATION
# =========================================================
DEFAULT_DATA_DIR = Path(r"D:\Daily_Commodity\VBMA\Dashboard MM")
DEFAULT_FILE_NAME = "Dashboard MM.xlsm"
CONFIG_FILE = Path(__file__).with_name("mm_dashboard_config.json")

# Do NOT map Trade Finance to "Cho vay FI" unless Treasury/Risk confirms it.
# If Trade Finance exists in TongHop later, set the exact labels or explicit rows here/config file.
DEFAULT_CONFIG = {
    "data_directory": str(DEFAULT_DATA_DIR),
    "preferred_filename": DEFAULT_FILE_NAME,
    "trade_finance": {
        "vnd_label": None,
        "usd_label": None,
        "vnd_row": None,
        "usd_row": None,
    },
    "server": {"host": "127.0.0.1", "port": 8000},
}

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"
OFFICE_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if CONFIG_FILE.exists():
        try:
            user_cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            for k, v in user_cfg.items():
                if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                    cfg[k].update(v)
                else:
                    cfg[k] = v
        except Exception as exc:
            print(f"[WARN] Cannot read config: {exc}")
    return cfg


CONFIG = load_config()


def find_workbook() -> Path:
    env_file = os.getenv("MM_DASHBOARD_FILE")
    if env_file:
        p = Path(env_file)
        if p.exists():
            return p
        raise FileNotFoundError(f"MM_DASHBOARD_FILE does not exist: {p}")

    data_dir = Path(CONFIG.get("data_directory", str(DEFAULT_DATA_DIR)))
    preferred = data_dir / CONFIG.get("preferred_filename", DEFAULT_FILE_NAME)
    if preferred.exists():
        return preferred

    candidates = [p for p in data_dir.glob("*.xlsm") if not p.name.startswith("~$")]
    if not candidates:
        raise FileNotFoundError(
            f"No .xlsm found in {data_dir}. Set MM_DASHBOARD_FILE or edit mm_dashboard_config.json"
        )
    return max(candidates, key=lambda p: p.stat().st_mtime)


def excel_date(value) -> pd.Timestamp:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return pd.NaT
    if isinstance(value, (pd.Timestamp, datetime)):
        return pd.Timestamp(value)
    if isinstance(value, str):
        return pd.to_datetime(value, errors="coerce")
    try:
        return pd.Timestamp("1899-12-30") + pd.to_timedelta(float(value), unit="D")
    except Exception:
        return pd.NaT


def col_to_num(col: str) -> int:
    n = 0
    for ch in col:
        if "A" <= ch <= "Z":
            n = n * 26 + ord(ch) - 64
    return n


def split_ref(ref: str) -> Tuple[int, int]:
    i = 0
    while i < len(ref) and ref[i].isalpha():
        i += 1
    return int(ref[i:]), col_to_num(ref[:i])


class XlsmReader:
    """Read only selected sheets directly from XLSM ZIP/XML.

    This avoids loading the very large TSDB sheet into memory and is much faster
    than opening the whole workbook with Excel/openpyxl.
    """

    def __init__(self, path: Path):
        self.path = Path(path)
        self.sheet_paths: Dict[str, str] = {}
        self.shared_strings: List[str] = []
        self._init_metadata()

    def _init_metadata(self):
        with zipfile.ZipFile(self.path) as z:
            wb = ET.fromstring(z.read("xl/workbook.xml"))
            rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
            rel_map = {r.attrib["Id"]: r.attrib["Target"] for r in rels}
            sheets_node = wb.find(NS + "sheets")
            if sheets_node is None:
                raise ValueError("Workbook has no sheets")
            for s in sheets_node:
                rid = s.attrib[OFFICE_REL]
                target = rel_map[rid].lstrip("/")
                if not target.startswith("xl/"):
                    target = "xl/" + target
                self.sheet_paths[s.attrib["name"]] = target

            if "xl/sharedStrings.xml" in z.namelist():
                root = ET.fromstring(z.read("xl/sharedStrings.xml"))
                self.shared_strings = [
                    "".join((t.text or "") for t in si.iter(NS + "t"))
                    for si in root.findall(NS + "si")
                ]

    def _cell_value(self, cell: ET.Element):
        typ = cell.attrib.get("t")
        v = cell.find(NS + "v")
        if typ == "s" and v is not None:
            try:
                return self.shared_strings[int(v.text)]
            except Exception:
                return v.text
        if typ == "inlineStr":
            isel = cell.find(NS + "is")
            if isel is None:
                return None
            return "".join((t.text or "") for t in isel.iter(NS + "t"))
        if typ == "str":
            return v.text if v is not None else None
        if typ == "b":
            return bool(v is not None and v.text == "1")
        if v is None or v.text is None:
            return None
        try:
            x = float(v.text)
            return int(x) if x.is_integer() else x
        except Exception:
            return v.text

    def iter_cells(self, sheet_name: str) -> Iterable[Tuple[int, int, object, Optional[str]]]:
        path = self.sheet_paths.get(sheet_name)
        if not path:
            raise KeyError(f"Missing sheet: {sheet_name}")
        with zipfile.ZipFile(self.path) as z, z.open(path) as fh:
            for _, el in ET.iterparse(fh, events=("end",)):
                if el.tag == NS + "c":
                    ref = el.attrib.get("r")
                    if ref:
                        row, col = split_ref(ref)
                        f = el.find(NS + "f")
                        yield row, col, self._cell_value(el), f.text if f is not None else None
                    el.clear()

    def simple_table(self, sheet_name: str, max_col: Optional[int] = None) -> pd.DataFrame:
        rows: Dict[int, Dict[int, object]] = {}
        max_seen_col = 0
        for r, c, value, _ in self.iter_cells(sheet_name):
            if max_col is not None and c > max_col:
                continue
            if value is not None:
                rows.setdefault(r, {})[c] = value
                max_seen_col = max(max_seen_col, c)
        if not rows:
            return pd.DataFrame()
        header = rows.get(1, {})
        ncols = max_col or max_seen_col
        names = []
        used = set()
        for c in range(1, ncols + 1):
            name = header.get(c)
            if name is None or str(name).strip() == "":
                name = f"COL_{c}"
            name = str(name).strip()
            base = name
            i = 2
            while name in used:
                name = f"{base}_{i}"
                i += 1
            used.add(name)
            names.append(name)
        data = []
        for r in sorted(k for k in rows if k >= 2):
            data.append([rows[r].get(c) for c in range(1, ncols + 1)])
        return pd.DataFrame(data, columns=names)


@dataclass
class Bundle:
    daily: pd.DataFrame
    pnl_daily: pd.DataFrame
    warnings: List[str]
    mapping: Dict[str, int]
    source_freshness: Dict[str, Optional[str]]
    file_path: str
    modified_at: str


class MMModel:
    def __init__(self, path: Path):
        self.path = path
        self.reader = XlsmReader(path)
        self.warnings: List[str] = []
        self.mapping: Dict[str, int] = {}

    def _tonghop_labels_dates(self):
        labels: Dict[int, str] = {}
        dates: Dict[int, pd.Timestamp] = {}
        for r, c, value, _ in self.reader.iter_cells("TongHop"):
            if c == 1 and r > 1 and isinstance(value, str):
                labels[r] = value.strip()
            elif r == 1 and c >= 2 and value is not None:
                d = excel_date(value)
                if not pd.isna(d):
                    dates[c] = d.normalize()
        return labels, dates

    @staticmethod
    def _block_ranges(labels: Dict[int, str]) -> Dict[str, Tuple[int, int]]:
        starts = []
        for r, label in labels.items():
            s = label.strip()
            if s.startswith("--[") and s.endswith("]--"):
                name = s[3:-3].strip().upper()
                starts.append((r, name))
        starts.sort()
        ranges = {}
        max_r = max(labels) if labels else 999999
        for i, (r, name) in enumerate(starts):
            end = starts[i + 1][0] - 1 if i + 1 < len(starts) else max_r
            ranges[name] = (r, end)
        return ranges

    def _find_row(self, labels: Dict[int, str], label: str, block: Optional[str] = None, required=True):
        candidates = []
        if block:
            ranges = self._block_ranges(labels)
            if block.upper() not in ranges:
                if required:
                    raise KeyError(f"Block {block} not found")
                return None
            lo, hi = ranges[block.upper()]
            candidates = [r for r, x in labels.items() if lo < r <= hi and x.strip() == label.strip()]
        else:
            candidates = [r for r, x in labels.items() if x.strip() == label.strip()]
        if not candidates:
            if required:
                raise KeyError(f"Metric label not found: {block or ''} / {label}")
            return None
        if len(candidates) > 1 and not block:
            raise KeyError(f"Ambiguous label '{label}', rows={candidates}; specify block")
        return candidates[0]

    def _row_series(self, selected_rows: Dict[str, int], dates: Dict[int, pd.Timestamp]) -> pd.DataFrame:
        wanted = set(selected_rows.values())
        reverse = {v: k for k, v in selected_rows.items()}
        values = {k: {} for k in selected_rows}
        for r, c, value, _ in self.reader.iter_cells("TongHop"):
            if r in wanted and c in dates:
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    values[reverse[r]][dates[c]] = float(value)
        idx = sorted(set().union(*(set(v.keys()) for v in values.values())))
        df = pd.DataFrame(index=pd.DatetimeIndex(idx, name="date"))
        for key, vals in values.items():
            df[key] = pd.Series(vals)
        return df.sort_index()

    def _market_sources(self) -> pd.DataFrame:
        # FX
        fx = self.reader.simple_table("Ty gia", max_col=6)
        if not fx.empty:
            fx["date"] = fx.iloc[:, 0].map(excel_date)
            fx = fx.rename(columns={fx.columns[3]: "fx_ask", fx.columns[4]: "fx_bid", fx.columns[5]: "fx_mid"})
            fx = fx[["date", "fx_ask", "fx_bid", "fx_mid"]].dropna(subset=["date"]).set_index("date")

        # Interbank rates
        itb = self.reader.simple_table("LS ITB", max_col=10)
        if not itb.empty:
            itb["date"] = itb.iloc[:, 0].map(excel_date)
            itb_cols = {
                "MMONVND": "itb_on", "MMSWVND": "itb_sw", "MM2WVND": "itb_2w",
                "MM1MVND": "itb_1m", "MM2MVND": "itb_2m", "MM3MVND": "itb_3m",
                "MM6MVND": "itb_6m", "MM9MVND": "itb_9m", "MM1YVND": "itb_1y",
            }
            itb = itb.rename(columns=itb_cols)
            keep = ["date"] + [x for x in itb_cols.values() if x in itb.columns]
            itb = itb[keep].dropna(subset=["date"]).set_index("date")

        # LS GTCG
        gtcg = self.reader.simple_table("LS GTCG", max_col=3)
        if not gtcg.empty:
            gtcg["date"] = gtcg.iloc[:, 1].map(excel_date)
            gtcg["gtcg_lsbq_pct"] = pd.to_numeric(gtcg.iloc[:, 2], errors="coerce")
            gtcg = gtcg[["date", "gtcg_lsbq_pct"]].dropna(subset=["date"]).set_index("date")

        # VBMA contains two time blocks: A:K for G-bond curve and M:Q for swap/ITB.
        vb = self.reader.simple_table("VBMA", max_col=17)
        vb_yield = pd.DataFrame()
        vb_market = pd.DataFrame()
        if not vb.empty:
            # column positions are stable in the source workbook
            vb_yield = pd.DataFrame({
                "date": vb.iloc[:, 0].map(excel_date),
                "vbma_1y": pd.to_numeric(vb.iloc[:, 1], errors="coerce"),
                "vbma_2y": pd.to_numeric(vb.iloc[:, 2], errors="coerce"),
                "vbma_3y": pd.to_numeric(vb.iloc[:, 3], errors="coerce"),
                "vbma_4y": pd.to_numeric(vb.iloc[:, 4], errors="coerce"),
                "vbma_5y": pd.to_numeric(vb.iloc[:, 5], errors="coerce"),
                "vbma_7y": pd.to_numeric(vb.iloc[:, 6], errors="coerce"),
                "vbma_10y": pd.to_numeric(vb.iloc[:, 7], errors="coerce"),
                "vbma_15y": pd.to_numeric(vb.iloc[:, 8], errors="coerce"),
                "vbma_20y": pd.to_numeric(vb.iloc[:, 9], errors="coerce"),
                "vbma_30y": pd.to_numeric(vb.iloc[:, 10], errors="coerce"),
            }).dropna(subset=["date"]).set_index("date")
            vb_market = pd.DataFrame({
                "date": vb.iloc[:, 12].map(excel_date),
                "vbma_swap_on": pd.to_numeric(vb.iloc[:, 13], errors="coerce"),
                "vbma_swap_1m": pd.to_numeric(vb.iloc[:, 14], errors="coerce"),
                "vbma_swap_3m": pd.to_numeric(vb.iloc[:, 15], errors="coerce"),
                "vbma_itb_on": pd.to_numeric(vb.iloc[:, 16], errors="coerce"),
            }).dropna(subset=["date"]).set_index("date")

        frames = [x for x in [fx, itb, gtcg, vb_yield, vb_market] if not x.empty]
        out = pd.concat(frames, axis=1).sort_index() if frames else pd.DataFrame()
        out = out[~out.index.duplicated(keep="last")]
        return out

    def build(self) -> Bundle:
        labels, dates = self._tonghop_labels_dates()
        tf_cfg = CONFIG.get("trade_finance", {})

        def r(key, label, block=None, required=True):
            row = self._find_row(labels, label, block, required)
            if row:
                self.mapping[key] = row
            return row

        rows = {
            "interbank_vnd_loan": r("interbank_vnd_loan", "[VND] - Cho Vay", "INTERBANK"),
            "interbank_usd_loan": r("interbank_usd_loan", "[USD] - Cho Vay", "INTERBANK"),
            "reso_vnd": r("reso_vnd", "[VND] - RESO", "REPO AND RESO"),
            "bond_pap": r("bond_pap", "Du No Thoi Diem BOND PAP"),
            "bond_trading": r("bond_trading", "Du No Thoi Diem BOND TRADING"),
            "bond_afs": r("bond_afs", "Du No Thoi Diem BOND AFS"),
            "secured_vnd": r("secured_vnd", "Cho vay TSDB VND"),
            "secured_usd": r("secured_usd", "Cho vay TSDB USD"),
            "unsecured_vnd": r("unsecured_vnd", "Cho vay tin chap vnd"),
            "unsecured_usd": r("unsecured_usd", "Cho vay tin chap USD"),
            "cd_maturity_vnd": r("cd_maturity_vnd", "[VND] - CD Đáo Hạn"),
            "ld_vnd_balance": r("ld_vnd_balance", "[VND] - Cho Vay", "LOAN AND DEPOSIT"),
            "ld_vnd_rate": r("ld_vnd_rate", "[VND] - LS cho vay BQ", "LOAN AND DEPOSIT"),
            "mm_funding_vnd_rate": r("mm_funding_vnd_rate", "[VND] - LS di vay BQ (Đầu Vào)"),
            "pnl_total": r("pnl_total", "PnL hàng ngày"),
        }

        # Optional Trade Finance mapping; deliberately not guessed.
        tf_vnd_row = tf_cfg.get("vnd_row")
        tf_usd_row = tf_cfg.get("usd_row")
        if not tf_vnd_row and tf_cfg.get("vnd_label"):
            tf_vnd_row = self._find_row(labels, tf_cfg["vnd_label"], required=False)
        if not tf_usd_row and tf_cfg.get("usd_label"):
            tf_usd_row = self._find_row(labels, tf_cfg["usd_label"], required=False)
        if tf_vnd_row:
            rows["trade_finance_vnd"] = int(tf_vnd_row)
            self.mapping["trade_finance_vnd"] = int(tf_vnd_row)
        if tf_usd_row:
            rows["trade_finance_usd"] = int(tf_usd_row)
            self.mapping["trade_finance_usd"] = int(tf_usd_row)
        if not tf_vnd_row and not tf_usd_row:
            self.warnings.append(
                "Trade Finance chưa có nguồn được xác nhận trong TongHop. Dashboard để giá trị 0 và không tự gán 'Cho vay FI' vào Trade Finance."
            )

        raw = self._row_series(rows, dates)
        market = self._market_sources()
        df = raw.join(market, how="outer").sort_index()
        df = df.loc[df.index.notna()]

        # Use FX mid from the market source. Do not rely on cached TongHop formula.
        fx = pd.to_numeric(df.get("fx_mid"), errors="coerce")
        # For occasional gaps, carry the last known rate for conversion only.
        fx_conv = fx.ffill()

        # User-approved formulas for Chart 1 (VND equivalent)
        df["loan_bn"] = (
            pd.to_numeric(df["interbank_vnd_loan"], errors="coerce")
            + pd.to_numeric(df["interbank_usd_loan"], errors="coerce") * fx_conv
        ) / 1e9
        df["invest_gtcg_bn"] = (
            pd.to_numeric(df["bond_pap"], errors="coerce")
            + pd.to_numeric(df["bond_trading"], errors="coerce")
            + pd.to_numeric(df["bond_afs"], errors="coerce")
        ) / 1e9
        df["reso_bn"] = pd.to_numeric(df["reso_vnd"], errors="coerce") / 1e9
        df["secured_bn"] = (
            pd.to_numeric(df["secured_vnd"], errors="coerce")
            + pd.to_numeric(df["secured_usd"], errors="coerce") * fx_conv
        ) / 1e9
        df["unsecured_bn"] = (
            pd.to_numeric(df["unsecured_vnd"], errors="coerce")
            + pd.to_numeric(df["unsecured_usd"], errors="coerce") * fx_conv
        ) / 1e9

        tf_vnd = pd.to_numeric(df.get("trade_finance_vnd", 0.0), errors="coerce").fillna(0.0) if isinstance(df.get("trade_finance_vnd", 0.0), pd.Series) else 0.0
        tf_usd = pd.to_numeric(df.get("trade_finance_usd", 0.0), errors="coerce").fillna(0.0) if isinstance(df.get("trade_finance_usd", 0.0), pd.Series) else 0.0
        df["trade_finance_bn"] = (tf_vnd + tf_usd * fx_conv) / 1e9 if isinstance(tf_vnd, pd.Series) else 0.0

        # Keep the Swap formula exactly as supplied by the user.
        df["swap_bn"] = (
            df["loan_bn"]
            - df["invest_gtcg_bn"]
            - df["reso_bn"]
            - df["secured_bn"]
            - df["unsecured_bn"]
        )

        # Authoritative size for this instrument decomposition is Loan.
        df["total_mm_bn"] = df["loan_bn"]
        df["instrument_sum_bn"] = (
            df["invest_gtcg_bn"] + df["reso_bn"] + df["secured_bn"]
            + df["swap_bn"] + df["unsecured_bn"] + df["trade_finance_bn"]
        )
        df["instrument_recon_gap_bn"] = df["total_mm_bn"] - df["instrument_sum_bn"]

        # Existing workbook logic for Chart 2: Quy mo GTCG = Bond Trading + Bond PAP - CD maturity.
        # This intentionally remains distinct from "Đầu tư GTCG" used in Chart 1.
        df["gtcg_scale_bn"] = (
            pd.to_numeric(df["bond_trading"], errors="coerce")
            + pd.to_numeric(df["bond_pap"], errors="coerce")
            - pd.to_numeric(df["cd_maturity_vnd"], errors="coerce")
        ) / 1e9

        # Existing workbook logic for Chart 3.
        df["ld_scale_bn"] = df["secured_bn"] + df["unsecured_bn"]
        ld_bal = pd.to_numeric(df["ld_vnd_balance"], errors="coerce")
        ld_rate = pd.to_numeric(df["ld_vnd_rate"], errors="coerce")
        funding_rate = pd.to_numeric(df["mm_funding_vnd_rate"], errors="coerce")
        df["ld_nim_pct"] = np.where(ld_bal.abs() > 0, ld_rate - funding_rate, np.nan)

        pnl_cols = ["pnl_total"]
        pnl_daily = df[pnl_cols].copy()
        pnl_daily = pnl_daily.apply(pd.to_numeric, errors="coerce") / 1e9  # bn VND

        # QC: Trade Finance + supplied Swap formula cannot reconcile if Trade Finance is non-zero.
        if df["trade_finance_bn"].abs().max(skipna=True) > 1e-9:
            self.warnings.append(
                "Trade Finance đã có dữ liệu nhưng công thức Swap hiện tại chưa trừ Trade Finance; tổng cơ cấu sẽ không khớp Loan. Cần Treasury/Risk xác nhận lại công thức residual."
            )

        # QC: compare recomputed formulas with cached rows if present, without using them as source.
        qc_pairs = [
            ("Dư nợ MM theo instrument (quy đổi VND) - Loan", "loan_bn"),
            ("Đầu tư GTCG", "invest_gtcg_bn"),
            ("Mua bán GTCG có kỳ hạn", "reso_bn"),
            ("Có TSĐB", "secured_bn"),
            ("Swap", "swap_bn"),
            ("Tín chấp", "unsecured_bn"),
        ]
        for label, calc_col in qc_pairs:
            # The workbook contains duplicate display/helper labels. For QC, use the derived source row 112-120.
            candidates = [rr for rr, txt in labels.items() if txt.strip() == label and 112 <= rr <= 120]
            row = candidates[0] if candidates else None
            if row:
                tmp = self._row_series({"cached": row}, dates)
                aligned = df[[calc_col]].join(tmp, how="inner").dropna()
                if not aligned.empty:
                    cached_bn = aligned["cached"] / 1e9
                    max_diff = (aligned[calc_col] - cached_bn).abs().max()
                    if pd.notna(max_diff) and max_diff > 0.01:  # > 10 million VND
                        self.warnings.append(f"QC {label}: chênh tối đa {max_diff:,.2f} tỷ so với cached TongHop.")

        # Restrict to dates for which TongHop has source data.
        if dates:
            min_d, max_d = min(dates.values()), max(dates.values())
            df = df.loc[(df.index >= min_d) & (df.index <= max_d)]
            pnl_daily = pnl_daily.loc[(pnl_daily.index >= min_d) & (pnl_daily.index <= max_d)]

        def max_nonnull_date(cols):
            cols = [c for c in cols if c in df.columns]
            if not cols:
                return None
            mask = df[cols].notna().any(axis=1)
            return df.index[mask].max() if mask.any() else None

        source_dates = {
            "TongHop": max(dates.values()) if dates else None,
            "Ty gia": max_nonnull_date(["fx_mid", "fx_ask", "fx_bid"]),
            "LS ITB": max_nonnull_date(["itb_on", "itb_1m", "itb_3m"]),
            "LS GTCG": max_nonnull_date(["gtcg_lsbq_pct"]),
            "VBMA TPCP": max_nonnull_date(["vbma_1y", "vbma_5y", "vbma_10y", "vbma_30y"]),
            "VBMA Swap/ITB": max_nonnull_date(["vbma_swap_on", "vbma_swap_1m", "vbma_swap_3m", "vbma_itb_on"]),
        }
        source_freshness = {k: (v.strftime("%Y-%m-%d") if v is not None and pd.notna(v) else None) for k, v in source_dates.items()}
        tonghop_max = source_dates.get("TongHop")
        if tonghop_max is not None:
            for src, dt in source_dates.items():
                if src == "TongHop" or dt is None:
                    continue
                if (tonghop_max - dt).days > 7:
                    self.warnings.append(f"Nguồn {src} đang cũ hơn TongHop: {dt:%d/%m/%Y} so với {tonghop_max:%d/%m/%Y}.")

        return Bundle(
            daily=df,
            pnl_daily=pnl_daily,
            warnings=self.warnings,
            mapping=self.mapping,
            source_freshness=source_freshness,
            file_path=str(self.path),
            modified_at=datetime.fromtimestamp(self.path.stat().st_mtime).isoformat(timespec="seconds"),
        )


class Cache:
    def __init__(self):
        self.lock = threading.Lock()
        self.path: Optional[Path] = None
        self.mtime: Optional[float] = None
        self.bundle: Optional[Bundle] = None

    def get(self, force=False) -> Bundle:
        with self.lock:
            path = find_workbook()
            mtime = path.stat().st_mtime
            if force or self.bundle is None or self.path != path or self.mtime != mtime:
                print(f"[INFO] Loading MM source: {path}")
                self.bundle = MMModel(path).build()
                self.path = path
                self.mtime = mtime
            return self.bundle


CACHE = Cache()
app = FastAPI(title="MM Risk Dashboard", docs_url=None, redoc_url=None)


SERIES_LABELS = {
    "itb_on": "ITB - ON", "itb_sw": "ITB - SW", "itb_2w": "ITB - 2W",
    "itb_1m": "ITB - 1M", "itb_2m": "ITB - 2M", "itb_3m": "ITB - 3M",
    "itb_6m": "ITB - 6M", "itb_9m": "ITB - 9M", "itb_1y": "ITB - 1Y",
    "vbma_1y": "VBMA TPCP - 1Y", "vbma_2y": "VBMA TPCP - 2Y", "vbma_3y": "VBMA TPCP - 3Y",
    "vbma_4y": "VBMA TPCP - 4Y", "vbma_5y": "VBMA TPCP - 5Y", "vbma_7y": "VBMA TPCP - 7Y",
    "vbma_10y": "VBMA TPCP - 10Y", "vbma_15y": "VBMA TPCP - 15Y", "vbma_20y": "VBMA TPCP - 20Y",
    "vbma_30y": "VBMA TPCP - 30Y", "vbma_swap_on": "VBMA Swap - ON", "vbma_swap_1m": "VBMA Swap - 1M",
    "vbma_swap_3m": "VBMA Swap - 3M", "vbma_itb_on": "VBMA - ON ITB",
}


def _safe(v):
    if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))):
        return None
    if isinstance(v, (np.floating, np.integer)):
        return v.item()
    return v


def _records(df: pd.DataFrame) -> List[dict]:
    out = df.copy()
    out.insert(0, "date", out.index.strftime("%Y-%m-%d"))
    recs = out.replace({np.nan: None, np.inf: None, -np.inf: None}).to_dict("records")
    return [{k: _safe(v) for k, v in r.items()} for r in recs]


def aggregate(df: pd.DataFrame, freq: str) -> pd.DataFrame:
    if freq == "daily":
        return df
    if df.empty:
        return df
    if freq == "monthly_avg":
        out = df.resample("ME").mean(numeric_only=True)
    elif freq == "monthly_eop":
        out = df.resample("ME").last()
    else:
        raise ValueError("freq must be daily, monthly_avg or monthly_eop")
    return out.dropna(how="all")


def period_compare(as_of: pd.Timestamp, mode: str) -> Tuple[pd.Timestamp, pd.Timestamp]:
    if mode == "prev_full":
        prev_end = as_of.replace(day=1) - pd.Timedelta(days=1)
        prev_start = prev_end.replace(day=1)
        return prev_start, prev_end
    if mode == "yoy_mtd":
        start = (as_of - pd.DateOffset(years=1)).replace(day=1)
        try:
            end = as_of - pd.DateOffset(years=1)
        except Exception:
            end = start + pd.offsets.MonthEnd(0)
        return start, end
    # prev_mtd: same day number in previous month, capped at month end
    prev_end_full = as_of.replace(day=1) - pd.Timedelta(days=1)
    prev_start = prev_end_full.replace(day=1)
    day = min(as_of.day, prev_end_full.day)
    return prev_start, prev_start.replace(day=day)


def metric_summary(series: pd.Series, cur_start, cur_end, cmp_start, cmp_end, rate=False):
    cur = series.loc[(series.index >= cur_start) & (series.index <= cur_end)].dropna()
    cmp = series.loc[(series.index >= cmp_start) & (series.index <= cmp_end)].dropna()
    cur_avg = cur.mean() if not cur.empty else np.nan
    cur_eop = cur.iloc[-1] if not cur.empty else np.nan
    cmp_avg = cmp.mean() if not cmp.empty else np.nan
    cmp_eop = cmp.iloc[-1] if not cmp.empty else np.nan
    if rate:
        avg_delta = cur_avg - cmp_avg if pd.notna(cur_avg) and pd.notna(cmp_avg) else np.nan
        eop_delta = cur_eop - cmp_eop if pd.notna(cur_eop) and pd.notna(cmp_eop) else np.nan
    else:
        avg_delta = cur_avg / cmp_avg - 1 if pd.notna(cur_avg) and pd.notna(cmp_avg) and cmp_avg != 0 else np.nan
        eop_delta = cur_eop / cmp_eop - 1 if pd.notna(cur_eop) and pd.notna(cmp_eop) and cmp_eop != 0 else np.nan
    return {
        "avg": _safe(cur_avg), "eop": _safe(cur_eop), "cmp_avg": _safe(cmp_avg), "cmp_eop": _safe(cmp_eop),
        "avg_delta": _safe(avg_delta), "eop_delta": _safe(eop_delta), "rate_delta": rate,
    }


def build_summary(bundle: Bundle, as_of: pd.Timestamp, compare: str):
    df = bundle.daily.loc[bundle.daily.index <= as_of]
    if df.empty:
        return {}
    as_of = min(as_of, df.index.max())
    cur_start = as_of.replace(day=1)
    cmp_start, cmp_end = period_compare(as_of, compare)

    metrics = {
        "total_mm": metric_summary(df["total_mm_bn"], cur_start, as_of, cmp_start, cmp_end, rate=False),
        "ld_scale": metric_summary(df["ld_scale_bn"], cur_start, as_of, cmp_start, cmp_end, rate=False),
        "gtcg_scale": metric_summary(df["gtcg_scale_bn"], cur_start, as_of, cmp_start, cmp_end, rate=False),
        "nim": metric_summary(df["ld_nim_pct"], cur_start, as_of, cmp_start, cmp_end, rate=True),
        "fx": metric_summary(df["fx_mid"], cur_start, as_of, cmp_start, cmp_end, rate=False),
        "itb_on": metric_summary(df["itb_on"], cur_start, as_of, cmp_start, cmp_end, rate=True),
    }

    pnl = bundle.pnl_daily.loc[(bundle.pnl_daily.index >= cur_start) & (bundle.pnl_daily.index <= as_of)]
    pnl_cmp = bundle.pnl_daily.loc[(bundle.pnl_daily.index >= cmp_start) & (bundle.pnl_daily.index <= cmp_end)]
    pnl_sum = pnl.sum(min_count=1) if not pnl.empty else pd.Series(dtype=float)
    pnl_cmp_sum = pnl_cmp.sum(min_count=1) if not pnl_cmp.empty else pd.Series(dtype=float)
    pnl_total = _safe(pnl_sum.get("pnl_total", np.nan))
    pnl_cmp_total = _safe(pnl_cmp_sum.get("pnl_total", np.nan))

    latest = df.loc[df.index <= as_of].iloc[-1]
    structure = {
        "Đầu tư GTCG": _safe(latest.get("invest_gtcg_bn")),
        "Mua bán GTCG có kỳ hạn": _safe(latest.get("reso_bn")),
        "Có TSĐB": _safe(latest.get("secured_bn")),
        "Swap": _safe(latest.get("swap_bn")),
        "Tín chấp": _safe(latest.get("unsecured_bn")),
        "Trade Finance": _safe(latest.get("trade_finance_bn")),
    }

    return {
        "as_of": as_of.strftime("%Y-%m-%d"),
        "current_period": [cur_start.strftime("%Y-%m-%d"), as_of.strftime("%Y-%m-%d")],
        "compare_period": [cmp_start.strftime("%Y-%m-%d"), cmp_end.strftime("%Y-%m-%d")],
        "metrics": metrics,
        "pnl_mtd_bn": pnl_total,
        "pnl_compare_bn": pnl_cmp_total,
        "structure_bn": structure,
        "recon_gap_bn": _safe(latest.get("instrument_recon_gap_bn")),
    }


ANOMALY_SPECS = {
    "total_mm_bn": ("Quy mô MM", "pct", 0.10),
    "gtcg_scale_bn": ("Quy mô GTCG", "pct", 0.10),
    "ld_scale_bn": ("Quy mô L&D", "pct", 0.10),
    "ld_nim_pct": ("NIM L&D", "point", 0.50),
    "fx_mid": ("USD/VND Mid", "pct", 0.01),
    "itb_on": ("LS ITB ON", "point", 1.00),
    "vbma_10y": ("Yield TPCP 10Y", "point", 0.25),
}


def anomalies(bundle: Bundle, as_of: pd.Timestamp, z_threshold: float = 2.5, window: int = 60):
    df = bundle.daily.loc[bundle.daily.index <= as_of].copy()
    rows = []
    for col, (label, kind, biz_threshold) in ANOMALY_SPECS.items():
        if col not in df.columns:
            continue
        s = pd.to_numeric(df[col], errors="coerce").dropna()
        if len(s) < 3:
            continue
        delta = s.pct_change() if kind == "pct" else s.diff()
        roll_mean = delta.rolling(window, min_periods=min(20, max(5, len(delta)//3))).mean()
        roll_std = delta.rolling(window, min_periods=min(20, max(5, len(delta)//3))).std(ddof=0)
        z = (delta - roll_mean) / roll_std.replace(0, np.nan)
        last_date = s.index[-1]
        change = delta.loc[last_date]
        zval = z.loc[last_date] if last_date in z.index else np.nan
        flag = (pd.notna(change) and abs(change) >= biz_threshold) or (pd.notna(zval) and abs(zval) >= z_threshold)
        rows.append({
            "metric": label,
            "value": _safe(s.iloc[-1]),
            "change": _safe(change),
            "change_kind": kind,
            "zscore": _safe(zval),
            "business_threshold": biz_threshold,
            "flag": bool(flag),
            "date": last_date.strftime("%Y-%m-%d"),
        })
    return sorted(rows, key=lambda x: (not x["flag"], -(abs(x["zscore"]) if x["zscore"] is not None else 0)))


@app.get("/api/meta")
def api_meta(force: bool = False):
    b = CACHE.get(force=force)
    df = b.daily
    return {
        "file": b.file_path,
        "modified_at": b.modified_at,
        "min_date": df.index.min().strftime("%Y-%m-%d") if not df.empty else None,
        "max_date": df.index.max().strftime("%Y-%m-%d") if not df.empty else None,
        "warnings": b.warnings,
        "mapping": b.mapping,
        "source_freshness": b.source_freshness,
        "market_series": SERIES_LABELS,
    }


@app.get("/api/data")
def api_data(
    start: Optional[str] = None,
    end: Optional[str] = None,
    freq: str = Query("daily", pattern="^(daily|monthly_avg|monthly_eop)$"),
):
    b = CACHE.get()
    df = b.daily.copy()
    if start:
        df = df.loc[df.index >= pd.Timestamp(start)]
    if end:
        df = df.loc[df.index <= pd.Timestamp(end)]
    df = aggregate(df, freq)
    cols = [
        "total_mm_bn", "loan_bn", "invest_gtcg_bn", "reso_bn", "secured_bn", "swap_bn", "unsecured_bn", "trade_finance_bn",
        "gtcg_scale_bn", "gtcg_lsbq_pct", "ld_scale_bn", "ld_nim_pct", "fx_ask", "fx_bid", "fx_mid",
        *SERIES_LABELS.keys(),
    ]
    cols = [c for c in cols if c in df.columns]
    return {"data": _records(df[cols]), "freq": freq}


@app.get("/api/summary")
def api_summary(end: Optional[str] = None, compare: str = Query("prev_mtd", pattern="^(prev_mtd|prev_full|yoy_mtd)$")):
    b = CACHE.get()
    as_of = pd.Timestamp(end) if end else b.daily.index.max()
    return build_summary(b, as_of, compare)


@app.get("/api/anomalies")
def api_anomalies(end: Optional[str] = None, z_threshold: float = 2.5):
    b = CACHE.get()
    as_of = pd.Timestamp(end) if end else b.daily.index.max()
    return {"data": anomalies(b, as_of, z_threshold=z_threshold)}


@app.post("/api/refresh")
def api_refresh():
    b = CACHE.get(force=True)
    return {"ok": True, "modified_at": b.modified_at, "warnings": b.warnings}


PLOTLY_JS = get_plotlyjs()

HTML = r'''<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>MM Risk Dashboard</title>
<style>
:root{--navy:#0b2b4b;--blue:#145da0;--teal:#187a86;--bg:#f3f6fa;--card:#fff;--text:#17202a;--muted:#6b7785;--line:#dbe3ec;--warn:#b26a00;--bad:#b42318;--good:#067647}
*{box-sizing:border-box} body{margin:0;background:var(--bg);font-family:Segoe UI,Arial,sans-serif;color:var(--text)}
.header{background:var(--navy);color:white;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;position:sticky;top:0;z-index:10;box-shadow:0 2px 8px #0002}
.header h1{margin:0;font-size:22px;font-weight:650}.subtitle{font-size:12px;opacity:.82;margin-top:4px}.status{font-size:12px;text-align:right;line-height:1.5}
.wrap{max-width:1700px;margin:auto;padding:18px 22px 40px}.filters{background:white;border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:grid;grid-template-columns:repeat(6,minmax(140px,1fr));gap:10px;align-items:end;box-shadow:0 1px 4px #0000000a}
label{font-size:12px;color:var(--muted);font-weight:600;display:block;margin-bottom:5px}input,select,button{width:100%;height:36px;border:1px solid #cbd5df;border-radius:8px;background:#fff;padding:0 9px;font-size:13px}button{background:var(--blue);color:#fff;border:none;font-weight:600;cursor:pointer}button.secondary{background:#eef4fb;color:var(--blue);border:1px solid #bed0e4}.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:14px 0}.card,.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 4px #0000000a}.card{padding:14px 15px}.card .label{font-size:12px;color:var(--muted);font-weight:600}.card .value{font-size:24px;font-weight:700;margin:8px 0 4px;color:var(--navy)}.card .meta{font-size:12px;color:var(--muted)}.delta.up{color:var(--good)}.delta.down{color:var(--bad)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.panel{padding:13px 14px}.panel h2{font-size:15px;margin:0 0 8px;color:var(--navy)}.panel .note{font-size:11px;color:var(--muted);margin-bottom:8px}.plot{height:390px}.plot.tall{height:450px}
.market-controls{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:8px}.checks{display:flex;flex-wrap:wrap;gap:6px 12px;padding:7px;border:1px solid var(--line);border-radius:8px;max-height:92px;overflow:auto}.checks label{display:flex;gap:5px;align-items:center;margin:0;color:#334;font-weight:500}.checks input{width:auto;height:auto}
.warnbox{background:#fff7e6;border:1px solid #f3d19c;color:#6a4500;border-radius:10px;padding:10px 12px;margin:12px 0;font-size:12px}.okbox{background:#ecfdf3;border:1px solid #abefc6;color:#05603a;border-radius:10px;padding:10px 12px;margin:12px 0;font-size:12px}.table-wrap{overflow:auto;max-height:360px}table{width:100%;border-collapse:collapse;font-size:12px}th{position:sticky;top:0;background:#f7f9fb;color:#475467;text-align:left;padding:9px;border-bottom:1px solid var(--line)}td{padding:8px 9px;border-bottom:1px solid #edf1f5}.flag{font-weight:700;color:var(--bad)}.small{font-size:11px;color:var(--muted)}
@media(max-width:1100px){.filters{grid-template-columns:repeat(3,1fr)}.cards{grid-template-columns:repeat(2,1fr)}.grid2{grid-template-columns:1fr}}@media(max-width:650px){.filters{grid-template-columns:1fr}.cards{grid-template-columns:1fr}.wrap{padding:10px}.header{padding:12px}}
</style>
<script>__PLOTLY__</script>
</head>
<body>
<div class="header"><div><h1>Money Market Risk Dashboard</h1><div class="subtitle">Quy mô · Cơ cấu · Lãi suất · NIM · GTCG · Market context · Cảnh báo biến động</div></div><div class="status" id="status">Đang nạp dữ liệu...</div></div>
<div class="wrap">
  <div class="filters">
    <div><label>Từ ngày</label><input type="date" id="start"></div>
    <div><label>Đến ngày</label><input type="date" id="end"></div>
    <div><label>Tần suất biểu đồ</label><select id="freq"><option value="daily">Hằng ngày</option><option value="monthly_avg">Bình quân tháng</option><option value="monthly_eop">Cuối kỳ tháng</option></select></div>
    <div><label>So sánh KPI</label><select id="compare"><option value="prev_mtd">Tháng trước - cùng ngày</option><option value="prev_full">Tháng trước - đủ tháng</option><option value="yoy_mtd">Cùng kỳ năm trước</option></select></div>
    <div><label>Ngưỡng bất thường Z-score</label><input type="number" id="zthr" min="1" max="6" step="0.1" value="2.5"></div>
    <div style="display:flex;gap:8px"><button onclick="reloadAll()">Áp dụng</button><button class="secondary" onclick="forceRefresh()">Nạp lại file</button></div>
  </div>
  <div id="warning"></div>
  <div class="cards">
    <div class="card"><div class="label">Dư nợ MM (Loan)</div><div class="value" id="kpiTotal">-</div><div class="meta" id="kpiTotalMeta">-</div></div>
    <div class="card"><div class="label">Quy mô L&D</div><div class="value" id="kpiLD">-</div><div class="meta" id="kpiLDMeta">-</div></div>
    <div class="card"><div class="label">NIM L&D</div><div class="value" id="kpiNIM">-</div><div class="meta" id="kpiNIMMeta">-</div></div>
    <div class="card"><div class="label">Quy mô GTCG</div><div class="value" id="kpiGTCG">-</div><div class="meta" id="kpiGTCGMeta">-</div></div>
    <div class="card"><div class="label">P&L MTD</div><div class="value" id="kpiPnL">-</div><div class="meta" id="kpiPnLMeta">-</div></div>
  </div>

  <div class="grid2">
    <div class="panel"><h2>1. Dư nợ MM theo instrument (quy đổi VND)</h2><div class="note">Đầu tư GTCG · Mua bán GTCG có kỳ hạn · Có TSĐB · Swap · Tín chấp · Trade Finance</div><div id="instrumentChart" class="plot tall"></div></div>
    <div class="panel"><h2>Cơ cấu tại ngày báo cáo</h2><div class="note">Đơn vị: tỷ VND. Có kiểm tra chênh lệch với dư nợ Loan.</div><div id="structureChart" class="plot tall"></div></div>
  </div>
  <div class="grid2">
    <div class="panel"><h2>2. GTCG - Quy mô & LSBQ</h2><div class="note">Quy mô theo logic dashboard hiện hữu; LSBQ từ sheet LS GTCG.</div><div id="gtcgChart" class="plot"></div></div>
    <div class="panel"><h2>3. L&D - Quy mô & NIM</h2><div class="note">Quy mô = Có TSĐB + Tín chấp; NIM theo công thức hiện hành của workbook.</div><div id="ldChart" class="plot"></div></div>
  </div>

  <div class="panel" style="margin-top:14px"><h2>LS ITB & VBMA</h2><div class="note">Tick các đường cần hiển thị; cùng đơn vị %.</div><div class="market-controls"><div><label>LS ITB</label><div class="checks" id="itbChecks"></div></div><div><label>VBMA</label><div class="checks" id="vbmaChecks"></div></div></div><div id="marketChart" class="plot tall"></div></div>
  <div class="grid2">
    <div class="panel"><h2>Tỷ giá USD/VND</h2><div class="checks" id="fxChecks" style="margin-bottom:8px"></div><div id="fxChart" class="plot"></div></div>
    <div class="panel"><h2>So sánh quy mô bình quân & cuối kỳ</h2><div class="note">MM · L&D · GTCG giữa kỳ hiện tại và kỳ so sánh đã chọn.</div><div id="compareChart" class="plot"></div></div>
  </div>
  <div class="panel" style="margin-top:14px"><h2>Biến động vượt ngưỡng / bất thường</h2><div class="note">Kết hợp ngưỡng nghiệp vụ cố định và Z-score của biến động hằng ngày. Đây là cảnh báo sàng lọc, không phải kết luận rủi ro.</div><div class="table-wrap"><table><thead><tr><th>Chỉ tiêu</th><th>Giá trị</th><th>Biến động</th><th>Z-score</th><th>Ngưỡng</th><th>Trạng thái</th></tr></thead><tbody id="anomalyRows"></tbody></table></div></div>
</div>
<script>
let META=null, DATA=[];
const fmtNum=(x,d=1)=>x==null?'—':Number(x).toLocaleString('vi-VN',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtPct=(x,d=1)=>x==null?'—':(Number(x)*100).toLocaleString('vi-VN',{minimumFractionDigits:d,maximumFractionDigits:d})+'%';
const fmtPoint=(x,d=2)=>x==null?'—':Number(x).toLocaleString('vi-VN',{minimumFractionDigits:d,maximumFractionDigits:d})+' điểm %';
const deltaHtml=(x,rate=false)=>{if(x==null)return '—';let cls=x>=0?'up':'down';let s=rate?fmtPoint(x):fmtPct(x);return `<span class="delta ${cls}">${x>=0?'+':''}${s}</span>`}
const commonLayout={margin:{l:58,r:58,t:25,b:45},paper_bgcolor:'#fff',plot_bgcolor:'#fff',font:{family:'Segoe UI,Arial',size:11,color:'#334155'},hovermode:'x unified',legend:{orientation:'h',y:-0.18},xaxis:{gridcolor:'#eef2f6'},yaxis:{gridcolor:'#eef2f6'}};
async function jget(url){const r=await fetch(url);if(!r.ok)throw new Error(await r.text());return await r.json()}
function qs(){return `start=${start.value}&end=${end.value}&freq=${freq.value}`}

function freshnessHtml(){if(!META||!META.source_freshness)return '';let rows=Object.entries(META.source_freshness).map(([k,v])=>`${k}: ${v||'N/A'}`).join(' · ');return `<div class="small" style="margin:6px 2px 0">Data freshness: ${rows}</div>`}
function makeChecks(){
 const itb=document.getElementById('itbChecks'), vb=document.getElementById('vbmaChecks'); itb.innerHTML='';vb.innerHTML='';
 Object.entries(META.market_series).forEach(([k,v])=>{let box=document.createElement('label');let checked=['itb_on','itb_1m','itb_3m','vbma_swap_1m','vbma_swap_3m'].includes(k);box.innerHTML=`<input type="checkbox" data-series="${k}" ${checked?'checked':''} onchange="renderMarket()"> ${v}`;(k.startsWith('itb_')?itb:vb).appendChild(box)});
 const fx=document.getElementById('fxChecks');fx.innerHTML=['fx_mid','fx_ask','fx_bid'].map((k,i)=>`<label><input type="checkbox" data-fx="${k}" ${i===0?'checked':''} onchange="renderFx()"> ${k==='fx_mid'?'Mid':k==='fx_ask'?'Ask':'Bid'}</label>`).join('');
}
function plot(id,traces,layout={}){Plotly.react(id,traces,{...commonLayout,...layout},{displaylogo:false,responsive:true,modeBarButtonsToRemove:['lasso2d','select2d']})}
function renderInstrument(){let x=DATA.map(r=>r.date);let defs=[['invest_gtcg_bn','Đầu tư GTCG'],['reso_bn','Mua bán GTCG có kỳ hạn'],['secured_bn','Có TSĐB'],['swap_bn','Swap'],['unsecured_bn','Tín chấp'],['trade_finance_bn','Trade Finance']];let tr=defs.map(([k,n])=>({x,y:DATA.map(r=>r[k]),name:n,type:'scatter',mode:'lines',stackgroup:'one',connectgaps:true,line:{width:1.2}}));plot('instrumentChart',tr,{yaxis:{title:'Tỷ VND',gridcolor:'#eef2f6'}})}
function renderGtcg(){let x=DATA.map(r=>r.date);plot('gtcgChart',[{x,y:DATA.map(r=>r.gtcg_scale_bn),name:'Quy mô GTCG',type:'bar',opacity:.65,yaxis:'y'},{x,y:DATA.map(r=>r.gtcg_lsbq_pct),name:'LSBQ',type:'scatter',mode:'lines',yaxis:'y2',connectgaps:true}],{yaxis:{title:'Tỷ VND',gridcolor:'#eef2f6'},yaxis2:{title:'%',overlaying:'y',side:'right',showgrid:false}})}
function renderLD(){let x=DATA.map(r=>r.date);plot('ldChart',[{x,y:DATA.map(r=>r.ld_scale_bn),name:'Quy mô L&D',type:'bar',opacity:.65},{x,y:DATA.map(r=>r.ld_nim_pct),name:'NIM',type:'scatter',mode:'lines',yaxis:'y2',connectgaps:true}],{yaxis:{title:'Tỷ VND',gridcolor:'#eef2f6'},yaxis2:{title:'%',overlaying:'y',side:'right',showgrid:false}})}
function renderMarket(){let keys=[...document.querySelectorAll('input[data-series]:checked')].map(x=>x.dataset.series);let x=DATA.map(r=>r.date);let tr=keys.map(k=>({x,y:DATA.map(r=>r[k]),name:META.market_series[k],type:'scatter',mode:'lines',connectgaps:true}));plot('marketChart',tr,{yaxis:{title:'%',gridcolor:'#eef2f6'}})}
function renderFx(){let names={fx_mid:'Mid',fx_ask:'Ask',fx_bid:'Bid'};let keys=[...document.querySelectorAll('input[data-fx]:checked')].map(x=>x.dataset.fx);let x=DATA.map(r=>r.date);plot('fxChart',keys.map(k=>({x,y:DATA.map(r=>r[k]),name:names[k],type:'scatter',mode:'lines',connectgaps:true})),{yaxis:{title:'VND/USD',gridcolor:'#eef2f6'}})}
async function loadSummary(){let s=await jget(`/api/summary?end=${end.value}&compare=${compare.value}`);let m=s.metrics;
 function card(id,metaId,obj,rate=false){document.getElementById(id).innerHTML=rate?(obj.eop==null?'—':fmtNum(obj.eop,2)+'%'):(obj.eop==null?'—':fmtNum(obj.eop,1)+' tỷ');document.getElementById(metaId).innerHTML=`BQ: ${rate?(obj.avg==null?'—':fmtNum(obj.avg,2)+'%'):fmtNum(obj.avg,1)+' tỷ'} · So sánh CK: ${deltaHtml(obj.eop_delta,rate)}`}
 card('kpiTotal','kpiTotalMeta',m.total_mm);card('kpiLD','kpiLDMeta',m.ld_scale);card('kpiNIM','kpiNIMMeta',m.nim,true);card('kpiGTCG','kpiGTCGMeta',m.gtcg_scale);
 document.getElementById('kpiPnL').textContent=s.pnl_mtd_bn==null?'—':fmtNum(s.pnl_mtd_bn,1)+' tỷ';let d=(s.pnl_mtd_bn!=null&&s.pnl_compare_bn!=null)?s.pnl_mtd_bn-s.pnl_compare_bn:null;document.getElementById('kpiPnLMeta').innerHTML=`Kỳ so sánh: ${s.pnl_compare_bn==null?'—':fmtNum(s.pnl_compare_bn,1)+' tỷ'} · Δ ${d==null?'—':fmtNum(d,1)+' tỷ'}`;
 let labels=Object.keys(s.structure_bn), vals=Object.values(s.structure_bn);plot('structureChart',[{labels,values:vals,type:'pie',hole:.58,textinfo:'label+percent',sort:false}],{margin:{l:20,r:20,t:20,b:20},legend:{orientation:'h',y:-.08}});
 let names=['MM','L&D','GTCG'];let objs=[m.total_mm,m.ld_scale,m.gtcg_scale];
 plot('compareChart',[
   {x:names,y:objs.map(o=>o.avg),name:'BQ kỳ hiện tại',type:'bar'},
   {x:names,y:objs.map(o=>o.cmp_avg),name:'BQ kỳ so sánh',type:'bar'},
   {x:names,y:objs.map(o=>o.eop),name:'Cuối kỳ hiện tại',type:'bar'},
   {x:names,y:objs.map(o=>o.cmp_eop),name:'Cuối kỳ so sánh',type:'bar'}
 ],{barmode:'group',yaxis:{title:'Tỷ VND',gridcolor:'#eef2f6'}});
 if(Math.abs(s.recon_gap_bn||0)>.01){document.getElementById('warning').innerHTML+=`<div class="warnbox">Chênh lệch cơ cấu instrument với Loan tại ngày báo cáo: <b>${fmtNum(s.recon_gap_bn,2)} tỷ VND</b>. Kiểm tra mapping Trade Finance/công thức residual.</div>`}
}
async function loadAnomalies(){let a=await jget(`/api/anomalies?end=${end.value}&z_threshold=${zthr.value}`);let tb=document.getElementById('anomalyRows');tb.innerHTML='';a.data.forEach(r=>{let ch=r.change_kind==='pct'?fmtPct(r.change,2):fmtPoint(r.change,2);let th=r.change_kind==='pct'?fmtPct(r.business_threshold,1):fmtPoint(r.business_threshold,2);tb.innerHTML+=`<tr><td>${r.metric}</td><td>${fmtNum(r.value,2)}</td><td>${ch}</td><td>${fmtNum(r.zscore,2)}</td><td>${th}</td><td class="${r.flag?'flag':''}">${r.flag?'Cần kiểm tra':'Bình thường'}</td></tr>`})}
async function reloadAll(){document.getElementById('warning').innerHTML='';let d=await jget(`/api/data?${qs()}`);DATA=d.data;renderInstrument();renderGtcg();renderLD();renderMarket();renderFx();await loadSummary();await loadAnomalies()}
async function forceRefresh(){await fetch('/api/refresh',{method:'POST'});META=await jget('/api/meta');document.getElementById('status').innerHTML=`Nguồn: ${META.file.split('\\').pop().split('/').pop()}<br>As-of: ${META.max_date}`;document.getElementById('warning').innerHTML=(META.warnings.length?META.warnings.map(x=>`<div class="warnbox">${x}</div>`).join(''):'<div class="okbox">Không phát hiện cảnh báo cấu trúc nguồn.</div>')+freshnessHtml();end.value=META.max_date;await reloadAll()}
async function init(){try{META=await jget('/api/meta');start.min=META.min_date;start.max=META.max_date;end.min=META.min_date;end.max=META.max_date;end.value=META.max_date;let e=new Date(META.max_date+'T00:00:00');e.setMonth(e.getMonth()-6);start.value=e.toISOString().slice(0,10)<META.min_date?META.min_date:e.toISOString().slice(0,10);document.getElementById('status').innerHTML=`Nguồn: ${META.file.split('\\').pop().split('/').pop()}<br>As-of: ${META.max_date}`;document.getElementById('warning').innerHTML=(META.warnings.length?META.warnings.map(x=>`<div class="warnbox">${x}</div>`).join(''):'<div class="okbox">Không phát hiện cảnh báo cấu trúc nguồn.</div>')+freshnessHtml();makeChecks();await reloadAll()}catch(e){document.getElementById('status').textContent='Lỗi nạp dữ liệu';document.getElementById('warning').innerHTML=`<div class="warnbox"><b>${e}</b></div>`}}
init();
</script>
</body></html>'''.replace("__PLOTLY__", PLOTLY_JS)


@app.get("/", response_class=HTMLResponse)
def home():
    return HTMLResponse(HTML)


@app.get("/health")
def health():
    try:
        b = CACHE.get()
        return {"status": "ok", "file": b.file_path, "rows": int(len(b.daily))}
    except Exception as exc:
        return JSONResponse({"status": "error", "error": str(exc)}, status_code=500)


if __name__ == "__main__":
    host = CONFIG.get("server", {}).get("host", "127.0.0.1")
    port = int(CONFIG.get("server", {}).get("port", 8000))
    print(f"Open browser: http://{host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")
