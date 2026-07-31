# Quy tắc Git — MangaTranslator

Repo này quản lý theo **version branch**: mỗi vòng phát triển lớn nằm trên một nhánh `feat/vN`,
làm xong thì mở PR gộp vào `main`. `main` luôn là bản đã nghiệm thu.

## Sơ đồ nhánh

```
main        ──●────────────────●────────────────●──────────>   (chỉ nhận merge từ PR)
               ╲              ╱ ╲              ╱
feat/v1         ●──●──●──●───╱   │             │              (đã đóng)
feat/v2                       ╲──●──●──●──●───╱               (đã đóng)
feat/v3                                        ●──●──●──>     (đang mở)
```

| Nhánh | Vai trò |
|---|---|
| `main` | Bản ổn định. **Không commit trực tiếp.** Chỉ thay đổi qua PR merge. |
| `feat/vN` | Nhánh phát triển của version N. Toàn bộ commit hằng ngày nằm ở đây. |
| `feat/<tên-việc>` | Nhánh phụ ngắn hạn cho một việc rủi ro cao, merge ngược về `feat/vN` rồi xoá. |
| `master` | Di sản, không dùng. |

**Chỉ có đúng một `feat/vN` đang mở tại một thời điểm.**

## Vòng đời một version

1. **Mở version mới** — tạo từ `main` ngay sau khi version trước đã merge:
   ```bash
   git checkout main && git pull
   git checkout -b feat/v3
   git push -u origin feat/v3
   ```
2. **Làm việc** — commit thẳng lên `feat/vN`. Việc lớn/rủi ro thì tách nhánh phụ, xong merge ngược về `feat/vN`.
3. **Đồng bộ** — nếu `main` có commit mới (hotfix), kéo về bằng `git rebase origin/main`
   khi nhánh **chưa** push, hoặc `git merge origin/main` khi **đã** push. Không force-push nhánh đã chia sẻ.
4. **Đóng version** — mở PR `feat/vN → main`, merge, rồi mở `feat/v(N+1)` từ `main`.
5. **Giữ lại nhánh cũ** sau khi merge — đó là mốc lịch sử của version, không xoá.

## Commit

Theo Conventional Commits, subject ngắn ở thể mệnh lệnh:

```
<type>: <mô tả ngắn>
```

Type dùng trong repo này: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`.

- Một commit = một thay đổi logic. Không gộp "sửa bug + đổi format + thêm doc".
- Commit code phải build/test được — không commit trạng thái hỏng giữa chừng.
- Tài liệu (`docs:`) tách khỏi commit code.

## Pull Request

- Tiêu đề: `feat/vN: <tóm tắt version>`.
- Mô tả nêu rõ: đã làm gì, đã đo/kiểm gì, còn treo gì.
- Không tự merge PR khi chưa được duyệt.
- Merge bằng **merge commit** (giữ nguyên lịch sử commit của version), không squash —
  vì lịch sử từng commit chính là giá trị của mô hình version branch này.

## Không bao giờ commit

Đã chặn trong `.gitignore`, đừng dùng `git add -f` để vượt qua:

- Bí mật: `.env`, `*.pem`, `*.crx`, key, token.
- Model và weight: `server/models/`, `server/vendor/`, `*.pt`, `*.onnx`.
- State/cache của tool: `.claude/`, `.codegraph/`, `.codex/`, `.tokensave/`, `graphify-out/`, `.superpowers/sdd/`.
- Log và thư mục tạm: `log.txt`, `.tmp-task10-browser/`, `.worktrees/`.
- UI state của Obsidian: `MangaTranslatorBrowser/.obsidian/workspace.json`.

Nội dung vault Obsidian (các file `.md`) **có** được track — đó là tài liệu dự án.

## Lệnh hay dùng

```bash
# Xem nhánh hiện tại lệch main bao nhiêu
git rev-list --left-right --count origin/main...HEAD

# Xem các commit của version hiện tại
git log --oneline origin/main..HEAD

# Kiểm tra sắp commit nhầm gì không
git status --short
```
