# Bắn fixture vào server đang chạy, in JSON blocks
curl.exe -s -X POST http://127.0.0.1:8910/translate `
  -F "image=@server/tests/fixtures/ja_page.png" `
  -F "src_lang=ja" -F "target_lang=vi"
