# domain_lookup Cloudflare Worker

Versi ini adalah port dari bot Python ke Cloudflare Worker. Perbedaannya:

- Cloudflare Worker tidak menjalankan Python/pyTelegramBotAPI.
- Bot memakai Telegram webhook, bukan `infinity_polling()`.
- Data `users`, `admin_ids`, dan pending broadcast disimpan di Cloudflare KV.
- `BOT_TOKEN` disimpan sebagai secret Worker, bukan file `config.json`.

## Deploy

```bash
npm install -g wrangler
wrangler login
cd domain_lookup_worker
wrangler kv namespace create BOT_KV
```

Masukkan `id` KV ke `wrangler.toml`, lalu:

```bash
wrangler secret put BOT_TOKEN
wrangler deploy
```

Set webhook Telegram, ganti URL dengan URL Worker kamu:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<worker-url>/"
```

Cek webhook:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

## Perintah

- `/start`, `/help`
- `/myid`
- `/setadmin`
- `/admins`
- `/addadmin <id>`
- `/deladmin <id>`
- `/stats`
- `/backup` (admin only, kirim file backup JSON ke admin)
- `/restore` (admin only, bot minta upload file backup JSON lalu restore users/admin)
- `/bc <pesan>`

## Backup dan Restore

- Backup otomatis tetap aktif saat ada user baru (`reason: new_user`) kalau `BACKUP_TO_MAIN_ADMIN = "true"`. File backup dikirim ke admin pertama.
- `/backup` hanya bisa admin dan akan mengirim file JSON berisi `users` dan `admin_ids`.
- `/restore` hanya bisa admin. Setelah command ini, upload file `.json` backup ke chat bot.

## Catatan

Worker request punya batas durasi. Untuk broadcast ke user yang sangat banyak, lebih aman memakai Queues/Durable Objects. Untuk jumlah user kecil sampai sedang, versi ini biasanya cukup.
