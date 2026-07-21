# YÊU CẦU THIẾT KẾ KIẾN TRÚC: HỆ THỐNG DỊCH & OVERLAY TRUYỆN TRANH TRÊN BROWSER

## 1. MỤC TIÊU CỐT LÕI
Tôi đang lên ý tưởng xây dựng một hệ thống dịch tự động hình ảnh (truyện tranh, manga, manhua, webtoon) trực tiếp trên trình duyệt. Khi người dùng xem một trang truyện, hệ thống sẽ dịch các đoạn hội thoại gốc và **ghi đè (overlay) trực tiếp văn bản dịch** lên đúng vị trí bóng thoại trên trang web đó.

**Hướng tiếp cận (Cách 1): Mô hình Client - Local Server**
*   **Client (Browser Extension):** Đóng vai trò là UI/UX. Bắt sự kiện người dùng (scroll, click, tự động phát hiện ảnh), trích xuất hình ảnh cần dịch từ DOM và gửi đi. Nhận kết quả và vẽ đè văn bản/khung dịch lên giao diện trang web.
*   **Local Server (Phần mềm cài trên máy cá nhân):** Đóng vai trò Backend/Engine chạy ngầm ở localhost. Nhận ảnh từ Extension, thực thi pipeline xử lý nặng (Text Detection, OCR, Inpainting/Xóa nền, Dịch thuật), và trả kết quả (text, tọa độ, gợi ý font/màu) lại cho Extension.

## 2. NHIỆM VỤ CỦA BẠN
Tôi không muốn chốt cứng bất kỳ công nghệ hay framework nào lúc này. Hãy đóng vai trò là một **Lead Software Architect**, đánh giá ý tưởng trên và cùng tôi brainstorming. Cụ thể, tôi cần bạn:

### A. Phân tích & So sánh các luồng giao tiếp (Communication Flow)
Làm thế nào để Extension nói chuyện với Local Server mượt nhất, ít độ trễ nhất và an toàn nhất? Hãy phân tích ưu/nhược điểm của:
1.  RESTful API truyền thống (gọi localhost từ extension).
2.  WebSocket (giữ kết nối liên tục, đẩy dữ liệu real-time).
3.  Chrome Native Messaging (sử dụng cơ chế giao tiếp tiến trình native của Chrome).
*Có phương án nào khác không? Đâu là rào cản (ví dụ: CORS, bảo mật của trình duyệt) và cách khắc phục?*

### B. Brainstorming Pipeline Xử lý & Stack Công nghệ
Local Server sẽ phải xử lý nhiều tác vụ nặng nề. Hãy liệt kê 2-3 lựa chọn công nghệ/thư viện mã nguồn mở cho từng bước sau, so sánh chúng về **Độ chính xác vs. Hiệu năng (Tốc độ)**:
1.  **Text Detection & OCR:** (Đặc biệt lưu ý đặc thù truyện tranh: chữ dọc/ngang, chữ nằm ngoài bóng thoại, font viết tay).
2.  **Inpainting / Cleaning:** (Xóa chữ gốc trong bóng thoại và tái tạo nền trắng/hoa văn sao cho tự nhiên trước khi chèn chữ dịch).
3.  **Translation Engine:** (Kết hợp API dịch ngoài hay chạy LLM/Translation Model hoàn toàn offline ở local?).
4.  **Backend Framework:** Dùng ngôn ngữ/framework nào để gom các module trên thành một server local ổn định và dễ đóng gói (đóng gói thành `.exe` hoặc script cài đặt đơn giản cho người dùng cuối)?

### C. Giải pháp Ghi đè (Overlay Solutions) trên Extension
Làm sao để chèn chữ dịch lên ảnh một cách tự nhiên nhất trên trình duyệt? Phân tích các hướng:
1.  Vẽ đè bằng thẻ HTML/CSS (`div` overlay với absolute position) ngay trên DOM gốc.
2.  Sử dụng `<canvas>` để vẽ lại ảnh gốc và chèn chữ, sau đó thay thế thẻ `<img>` gốc trên web.
*Cái nào ít phá vỡ layout của các trang web đọc truyện khác nhau nhất?*

## 3. FORMAT ĐẦU RA MONG MUỐN
*   Trình bày dạng bullet points, bảng so sánh hoặc ma trận (Trade-off matrix) để dễ nhìn.
*   Đưa ra các **câu hỏi phản biện (Follow-up questions)** cho tôi để khoanh vùng lại scope nếu ý tưởng đang quá rộng.
*   **Đề xuất cá nhân (Recommendation):** Nếu bạn là người quyết định, bạn sẽ chọn "Stack công nghệ + Luồng giao tiếp" nào cho phiên bản MVP (Minimum Viable Product) để chứng minh tính khả thi nhanh nhất?