# TreasuryIQ v1.2 — Dashboard ngân hàng

Dashboard độc lập với FinQuery dành cho MM, thanh khoản L&D, lãi suất liên ngân hàng, GTCG, VBMA, FX và trợ lý phân tích. Giao diện navy/teal, bảng và biểu đồ responsive.

## Sử dụng

Trên máy có Python 3, giải nén source rồi chạy:

```bash
python -m http.server 8000
```

Mở `http://localhost:8000`. Trang khởi tạo 224 phiên **MM demo giả lập**, cùng bộ dữ liệu thị trường công khai có nguồn và ngày quan sát. Chọn `Nạp dữ liệu` để mở workbook `.xlsx/.xlsm` hoặc JSON. File riêng tư được xử lý trong tab browser, không POST lên backend. Các sheet được hỗ trợ: `TongHop`, `Ty gia`, `LS ITB`, `LS GTCG`, `VBMA`.

Nếu workbook rất lớn, xuất JSON cục bộ bằng Python:

```bash
pip install -r requirements.txt
python scripts/export_snapshot.py "D:\\Daily_Commodity\\VBMA\\Dashboard MM\\T10. Dashboard MM 2023 update daily_test.xlsm" --output private_snapshot.json
```

File JSON riêng tư phải được nạp thủ công trên web, **không commit hoặc gửi lên hosting**.

## Thị trường — dữ liệu và lịch cập nhật

- Công khai: lãi suất 7 kỳ hạn ON → 9M, tỷ giá trung tâm USD/VND, SOFR, US Treasury 10Y, lợi suất TPCP thứ cấp và tin tức chọn lọc.
- Thời điểm tham chiếu snapshot: NHNN đến 11/11/2026; bản tin liên ngân hàng ngày 12/11/2026; FX 13/11; FRED 10/11; TPCP 11/11. Mỗi số có provenance và ngày quan sát.
- API `/api/market` gọi các nguồn live được hỗ trợ theo bộ lọc/ràng buộc và dùng snapshot đã xác minh nếu lỗi hoặc thiếu kết nối. Trong local tĩnh, `data/public_snapshot.json` vẫn hiển thị giá trị đã xác minh.
- Khi mở web, dữ liệu được tải ngay. Khi tab đang mở, `refreshPublic()` chạy **mỗi 60 phút** và kiểm tra lại khi quay lại tab sau một giờ.
- `.github/workflows/public-market-hourly.yml` là **tác vụ tự động có điều kiện** chạy theo lịch `07:00–19:00` (Asia/Ho_Chi_Minh) thứ hai–sáu nếu repository private và GitHub Actions/secrets được cấu hình. Cần tạo `vars.TREASURY_PUBLIC_REFRESH_URL` (URL Vercel đã bảo vệ) và `secrets.VERCEL_AUTOMATION_BYPASS_SECRET` (bypass credential của deployment). Không được đăng secret trong source hoặc chat. Action gọi API để làm mới cache; chưa lưu lịch sử bền vững vào cơ sở dữ liệu.
- Không cấu hình Vercel Cron chạy hourly trên gói Hobby.

## Quy ước nghiệp vụ

Xem `docs/DATA_CONTRACT.md`. Các công thức chính kế thừa logic đã kiểm tra trước:

- Loan = (Cho vay VND + Cho vay USD × FX Mid) / 1e9.
- GTCG investment = (BOND PAP + Trading + AFS) / 1e9.
- Secured/Unsecured quy đổi tỷ VND; L&D = Secured + Unsecured.
- Swap residual = Loan − GTCG investment − RESO − Secured − Unsecured.
- GTCG net size = BOND Trading + PAP − CD đáo hạn.
- NIM L&D là chênh lệch lãi suất đầu ra/đầu vào theo quy tắc nguồn, không tự suy ra P&L.
- Trade Finance chưa chốt mapping, vẫn giữ `null` trong dữ liệu riêng tư.

Chuỗi giá nội bộ và benchmark có nhãn riêng; không nối hai nguồn khác định nghĩa để dựng chuỗi giả. Người dùng thấy ngày quan sát, link nguồn và lịch sử thu thập.

## Trợ lý hỏi đáp

- Phân tích local luôn hoạt động với dữ liệu trong tab.
- AI online public-only tùy chọn nếu môi trường deployment được cấp key/quyền phù hợp. API online không nhận workbook riêng tư.

## Kiểm thử

```bash
npm run check
npm test
```

`docs/REVIEW_QA.md` ghi kiểm tra Quant / Dev / Risk, 7/7 automated tests, browser desktop/mobile, cũng như các giới hạn chưa xác minh trên file `.xlsm` thật. Đây là kiểm thử code, không phải phê duyệt của nhân sự ngân hàng.

## Triển khai Vercel private

**Chỉ deploy sau khi dự án được bật Vercel Authentication `All Deployments` và đã xác minh không thể truy cập khi không đăng nhập.** Repo GitHub private nằm riêng `NCKHtop1/bank-treasury-intelligence`. Không commit workbook nội bộ, private snapshots, SQL/AI credentials. FinQuery không bị tác động.

Trạng thái thực tế 13/11/2026: kết nối Vercel trong phiên này trả HTTP 403 khi tạo project mới, nên chưa có URL live. Bản source này sẵn sàng để import nhưng deployment, authentication, scheduled GitHub Actions vẫn cần được cấu hình trên tài khoản có đủ quyền.

## Cấu trúc

```
index.html                           Giao diện
assets/app.css                       Theme responsive
assets/app.js                        Charts, filters, assistant, hourly refresh
assets/loader.js                     Đọc workbook tại trình duyệt
assets/vendor/jszip.min.js          Thư viện giải nén workbook
api/market.js                        API thị trường, nguồn live + dự phòng
api/assistant.js                     Tùy chọn AI public-only
data/public_snapshot.json            Giá công khai có nguồn, ngày quan sát
data/demo.json                       MM demo giả lập
scripts/export_snapshot.py           Xuất JSON private local
scripts/legacy_mm_engine.py          Engine nghiệp vụ kế thừa
.github/workflows/public-market-hourly.yml   Tác vụ ngoài Vercel, chưa kích hoạt
docs/DATA_CONTRACT.md                 Định nghĩa chỉ tiêu
docs/REVIEW_QA.md                     Kiểm tra Quant, Dev, Risk
```
