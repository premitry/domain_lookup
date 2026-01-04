# domain_lookup — RDAP Domain Checker Telegram Bot

Bot Telegram untuk cek domain secara **bulk** menggunakan **RDAP** (ICANN lookup).

- Domain **.id** memakai RDAP PANDI  
- Domain selain .id memakai `rdap.org`  
- Auto baca `config.json`. Kalau token kosong dan dijalankan interaktif, bot akan minta token lalu menyimpan otomatis.

## Fitur
- Kirim banyak domain dalam 1 pesan (pisah newline/spasi/koma/URL).
- Output ringkas: AVAILABLE / REGISTERED + Expired & Registrar.
- Retry & backoff saat kena rate limit.
- Token via `config.json` atau env `BOT_TOKEN`.

## Limit Bulk
- Maksimal **25 domain** per 1 pesan (lebih dari 25 akan dipotong, hanya 25 pertama yang diproses).
- Catatan: Telegram edit message ada limit karakter (~4096). Kalau hasil terlalu panjang, output bisa dipotong.

## Struktur
- `domain_rdap.py` — script bot
- `requirements.txt` — dependency
- `config.example.json` — contoh config
- `config.json` — config asli 

## Instalasi (Ubuntu/Debian)

### 1) Clone repo
```bash
cd /home
git clone https://github.com/premitry/domain_lookup.git
cd domain_lookup
```
## 2) Install Python + pip
```bash
sudo apt update
sudo apt install -y python3 python3-pip
```
## 3) Install dependencies (requirements)
```
pip3 install -r requirements.txt
```
## 5) Jalankan bot
```
python3 domain_rdap.py
