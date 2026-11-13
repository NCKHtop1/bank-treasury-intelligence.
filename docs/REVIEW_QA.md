# TreasuryIQ v1.2 — Checklist kiểm thử định lượng, hệ thống và rủi ro

Ngày thực hiện: 13/11/2026. Đây là checklist kỹ thuật và kết quả test tự động, **không phải chữ ký nghiệm thu của chuyên gia hay bộ phận kiểm soát nội bộ**.

## 1. Quant / Treasury data

| Hạng mục | Tiêu chí | Kết quả |
| --- | --- | --- |
| Số dư tổng | Loan = GTCG + RESO + secured + unsecured + swap residual (đơn vị tỷ VND) | PASS — dữ liệu demo 224 ngày, sai số làm tròn < 0.051 tỷ |
| Quy mô L&D | `ld_scale_bn = secured_bn + unsecured_bn` | PASS — dữ liệu demo 224 ngày, sai số làm tròn < 0.051 tỷ |
| Tỷ giá | Bid ≤ Mid ≤ Ask trên từng quan sát demo | PASS |
| Mapping trade finance | Không dùng trường FI để tạo Trade Finance | PASS — `null` chưa xác nhận |
| Lãi suất | ON, 1W, 2W, 1M, 3M, 6M, 9M là các chuỗi độc lập | PASS — 70 bản ghi public có nguồn/quality |
| Chênh lệch lãi suất | Chỉ tính delta giữa hai phiên có cùng `source_type` | PASS — bản tin 12/11 không nhận delta từ nguồn NHNN 11/11 |
| Kỳ hạn | Benchmark công khai và quote nội bộ được đặt tên riêng | PASS |
| Giá trị thị trường dự phòng | FX central, SOFR, UST10, đường cong TPCP có quan sát/nguồn công bố | PASS — test khi API lỗi vẫn trả giá trị cuối có nguồn |
| Excel thực tế | Chốt đối chiếu từng ô với workbook gốc | **PENDING** — chưa có workbook gốc trong môi trường này |

## 2. Software engineering / UI

| Hạng mục | Tiêu chí | Kết quả |
| --- | --- | --- |
| JavaScript | `node --check` các tệp frontend/backend | PASS |
| Automated tests | `npm test` | PASS — 7/7 |
| Dashboard | 7 quick-rate cards, 7 rate rows, 3 news cards, 2 chart SVG | PASS — browser desktop + mobile |
| Các màn | Overview, Interbank, Market News điều hướng không lỗi | PASS |
| Responsive | Viewport 1440px/390px không tràn ngang | PASS |
| Console | Không có lỗi JS sau render cơ bản | PASS |
| Dữ liệu ngắt mạng | API không sập và hiển thị snapshot gần nhất | PASS |
| Cập nhật một giờ | Frontend dùng 60 phút + kiểm tra khi tab quay lại | PASS — code and browser wiring |
| Cron độc lập | GHA workflow 07:00–19:00 VN ngày làm việc | CONFIG READY — chưa chạy cho đến khi có private GitHub repo và secrets |
| Vercel Hobby | Không khai báo cron hourly trong `vercel.json` | PASS |

## 3. Risk / privacy / provenance

| Hạng mục | Tiêu chí | Kết quả |
| --- | --- | --- |
| Nội bộ | Workbook Excel nạp từ browser, không có upload API | PASS — code inspection |
| AI | Endpoint public-only không truy cập workbook private | PASS — code inspection |
| Provenance | Từng bản ghi public có date, source_url, quality | PASS |
| Source fallback | Snapshot dùng ngày quan sát cũ, không giả ngày hôm nay | PASS |
| Synthetic | Demo được gắn nhãn, không dùng làm số liệu thực | PASS |
| Tái tính công thức gốc | Unit test dựa trên `TongHop` từ workbook thật | **PENDING** — thiếu file gốc và xác nhận nghiệp vụ cuối |
| Site access | Vercel Authentication = All Deployments, test người lạ không vào được | **BLOCKED** — Vercel trả 403 khi tạo project; chưa phát hành |
| Backend production | Theo dõi uptime, log, RBAC & review IT | **PENDING** — cần hạ tầng được phép |

### Quy tắc dữ liệu khi thiếu

1. Ưu tiên dữ liệu thực có ngày, nguồn, đơn vị và định nghĩa chính xác.
2. Khi không lấy được số mới, UI giữ **giá trị quan sát cuối** có ngày quan sát, không đổi ngày để trông như dữ liệu mới.
3. Nếu nguồn khác định nghĩa, hiển thị thành một chuỗi riêng có nhãn, không nối nội bộ/benchmark.
4. Không tự chế lãi suất hoặc sinh giá trị trung gian để lấp khoảng không có giao dịch.
5. Trình bày cảnh báo kỹ thuật ngắn gọn tại mục Data Quality; trang tổng quan ưu tiên thông tin thị trường.

### Hạng mục cần làm trước khi ký duyệt production

- Chạy UAT trên workbook ngân hàng phiên bản mới nhất và đối chiếu ngày/đơn vị/công thức với bộ báo cáo gốc.
- Thẩm định feed NHNN / thị trường có quyền sử dụng, xác nhận SLA và lịch chốt số.
- Xác thực toàn bộ deployment và subdomain bằng tài khoản không có quyền truy cập.
- Chốt cách lưu snapshot theo thời gian trong database hoặc object storage thuộc môi trường được phê duyệt; workflow gọi URL hiện tại **không tự tạo kho lịch sử**.
- Kiểm tra CORS, CSP, cấu hình AI và chính sách xử lý dữ liệu ngân hàng trong môi trường thật.
