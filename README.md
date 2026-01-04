# domain_lookup — RDAP Domain Checker Telegram Bot

Bot Telegram untuk cek domain secara **bulk** menggunakan **RDAP** (gaya ICANN lookup).

- Domain **.id** memakai RDAP PANDI
- Domain selain .id memakai `rdap.org`
- Mode bulk: bot **edit 1 pesan** (tidak spam chat) + ada jarak 1 baris antar hasil
- Auto baca `config.json`. Kalau token kosong dan dijalankan interaktif, bot akan minta token lalu menyimpan otomatis.

## Fitur
- Kirim banyak domain dalam 1 pesan (pisah newline/spasi/koma/URL).
- Output ringkas: AVAILABLE / REGISTERED + Expired & Registrar.
- Retry & backoff saat kena rate limit.
- Token via `config.json` atau env `BOT_TOKEN`.

## Struktur
- `domain_rdap.py` — script bot
- `requirements.txt` — dependency
- `config.example.json` — contoh config
- `config.json` — config asli (JANGAN di-commit)

## Instalasi (Ubuntu/Debian)
```bash
sudo apt update
sudo apt install -y python3-pip
pip3 install -r requirements.txt

