import json, math, random
from datetime import date,timedelta
from pathlib import Path
r=random.Random(20261113)
rows=[]
date_cursor=date(2026,1,2)
while date_cursor<=date(2026,11,11):
    if date_cursor.weekday()<5:
        i=len(rows)
        total=125800+11000*math.sin(i/48)+i*27+r.uniform(-1000,1000)
        invested=total*(0.47+0.015*math.sin(i/26))
        secured=total*(0.26+0.01*math.sin(i/30))
        unsecured=total*(0.15+0.006*math.cos(i/21))
        reso=total*(0.02+0.003*math.cos(i/20))
        swap=total-invested-secured-unsecured-reso
        on=3.85+0.63*math.sin(i/15)+0.45*math.sin(i/6)+r.uniform(-.13,.13)
        fx=25700+220*math.sin(i/40)+0.52*i+r.uniform(-22,22)
        nim=2.15+0.31*math.sin(i/36)+r.uniform(-.08,.08)
        val={
            'date':str(date_cursor),
            'loan_bn':round(total,2),'total_mm_bn':round(total,2),
            'invest_gtcg_bn':round(invested,2),'secured_bn':round(secured,2),
            'unsecured_bn':round(unsecured,2),'reso_bn':round(reso,2),
            'swap_bn':round(swap,2),'trade_finance_bn':None,
            'instrument_recon_gap_bn':0,
            'gtcg_scale_bn':round(invested*.89,2),
            'gtcg_lsbq_pct':round(7.75+0.21*math.sin(i/45),3),
            'ld_scale_bn':round(secured+unsecured,2),
            'ld_nim_pct':round(nim,3),
            'pnl_bn':round(115+20*math.sin(i/15)+r.uniform(-12,12),2),
            'itb_on':round(on,3),'itb_1w':round(on+.26,3),
            'itb_2w':round(on+.43,3),'itb_1m':round(on+.91,3),
            'itb_3m':round(on+1.44,3),'itb_6m':round(on+1.83,3),
            'vbma_swap_on':round(on+.11,3),'vbma_swap_1m':round(on+.47,3),
            'vbma_swap_3m':round(on+.83,3),
            'vbma_1y':round(3.18+0.19*math.sin(i/54),3),
            'vbma_2y':round(3.41+0.20*math.sin(i/48),3),
            'vbma_5y':round(3.73+0.15*math.cos(i/37),3),
            'vbma_10y':round(4.02+0.16*math.sin(i/41),3),
            'fx_mid':round(fx,2),'fx_bid':round(fx-50,2),'fx_ask':round(fx+50,2),
        }
        rows.append(val)
    date_cursor+=timedelta(days=1)
json.dump({'meta':{'kind':'synthetic','label':'DỮ LIỆU MÔ PHỎNG','asOf':rows[-1]['date'],'createdAt':'2026-11-13','warning':'Toàn bộ số liệu nghiệp vụ trong chế độ Demo là giả lập để thử chức năng. Không dùng làm báo cáo ngân hàng.'},'series':rows,'source_freshness':{'TongHop':rows[-1]['date'],'LS ITB':rows[-1]['date'],'Ty gia':rows[-1]['date'],'LS GTCG':rows[-1]['date'],'VBMA TPCP':rows[-1]['date'],'VBMA Swap/ITB':rows[-1]['date']},'warnings':[]},open('/mnt/data/bank-treasury-intelligence/data/demo.json','w',encoding='utf8'),ensure_ascii=False,separators=(',',':'))
print('Created demo observations',len(rows))
