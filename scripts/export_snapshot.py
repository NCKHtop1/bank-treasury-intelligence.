#!/usr/bin/env python3
"""Export a local MM/Treasury Excel workbook to a browser-importable JSON file.

SECURITY: Runs on the user's machine. Nothing is uploaded; DO NOT commit output.
The formulas and source mapping are carried forward from the audited legacy MM model.
"""
import argparse
import json
import math
import sys
from pathlib import Path
from datetime import datetime, timezone

from legacy_mm_engine import MMModel

FIELDS = [
    'loan_bn', 'total_mm_bn', 'invest_gtcg_bn', 'reso_bn', 'secured_bn',
    'unsecured_bn', 'swap_bn', 'trade_finance_bn', 'instrument_recon_gap_bn',
    'gtcg_scale_bn','gtcg_lsbq_pct','ld_scale_bn','ld_nim_pct','pnl_total',
    'itb_on','itb_sw','itb_2w','itb_1m','itb_2m','itb_3m','itb_6m','itb_9m','itb_1y',
    'vbma_swap_on','vbma_swap_1m','vbma_swap_3m','vbma_itb_on',
    'vbma_1y','vbma_2y','vbma_3y','vbma_4y','vbma_5y','vbma_7y',
    'vbma_10y','vbma_15y','vbma_20y','vbma_30y',
    'fx_bid','fx_ask','fx_mid'
]

def num(v):
    if v is None:
        return None
    try:
        q=float(v)
        if math.isfinite(q):
            return round(q, 8)
    except (TypeError, ValueError):
        pass
    return None

def export(path, out):
    b=MMModel(Path(path)).build()
    df=b.daily.sort_index()
    if df.empty:
        raise ValueError('TongHop has no valid dates')
    output=[]
    for idx,row in df.iterrows():
        item={'date':idx.strftime('%Y-%m-%d')}
        for col in FIELDS:
            if col in df:
                item[col]=num(row.get(col))
        # MMSWVND is the 1-week ITB tenor; legacy model calls it itb_sw.
        if item.get('itb_sw') is not None:
            item['itb_1w']=item['itb_sw']
        if item.get('pnl_total') is not None:
            item['pnl_bn']=round(item.pop('pnl_total') / 1e9, 8)
        output.append(item)
    result={
        'meta':{
            'kind':'private-local','label':'DỮ LIỆU NỘI BỘ - XỬ LÝ TRÊN MÁY',
            'asOf':output[-1]['date'],'exportedAt':datetime.now(timezone.utc).isoformat(),
            'source_file':Path(path).name,
            'warning':'KHÔNG COMMIT FILE NÀY LÊN GITHUB. Chỉ import trực tiếp qua trình duyệt hoặc đặt trên máy chủ nội bộ đã phê duyệt.'
        },
        'series':output,
        'source_freshness':b.source_freshness,
        'warnings':b.warnings,
        'mapping':b.mapping
    }
    Path(out).parent.mkdir(parents=True,exist_ok=True)
    Path(out).write_text(json.dumps(result,ensure_ascii=False,allow_nan=False,separators=(',',':')),encoding='utf8')
    print(f'Exported {len(output)} observations: {output[0]["date"]} -> {output[-1]["date"]}')
    print('Warnings:',len(b.warnings))
    print('Saved locally:',Path(out).resolve())

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('workbook',help='Path to source Dashboard MM.xlsm or a compatible .xlsx')
    p.add_argument('--output',default='private_snapshot.json',help='Local output; do not push to GitHub')
    a=p.parse_args()
    try:
        export(a.workbook,a.output)
    except Exception as exc:
        print('ERROR:',exc,file=sys.stderr)
        sys.exit(2)
