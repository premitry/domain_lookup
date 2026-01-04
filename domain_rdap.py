import os, re, time, random, json, sys
from datetime import datetime
from pathlib import Path
import requests
import telebot

def load_config(cfg_path: Path) -> dict:
    if cfg_path.exists():
        txt = cfg_path.read_text(encoding="utf-8", errors="ignore").strip()
        if not txt:
            return {}
        try:
            data = json.loads(txt)
            return data if isinstance(data, dict) else {}
        except Exception:
            # kalau rusak, jangan crash: anggap kosong (biar bisa input ulang)
            return {}
    return {}

def save_config(cfg_path: Path, cfg: dict):
    cfg_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    try:
        cfg_path.chmod(0o600)  # amankan permission
    except Exception:
        pass

def get_api_token() -> str:
    cfg_path = Path(__file__).with_name("config.json")
    cfg = load_config(cfg_path)

    # prioritas: env BOT_TOKEN > config.json
    token = (os.getenv("BOT_TOKEN") or cfg.get("bot_token") or "").strip()
    if token:
        return token

    # kalau config kosong, coba minta input (hanya kalau interaktif)
    if sys.stdin.isatty():
        try:
            import getpass
            token = getpass.getpass("Masukkan BOT TOKEN: ").strip()
        except Exception:
            token = ""

        if token:
            cfg["bot_token"] = token
            save_config(cfg_path, cfg)
            print("✅ Token tersimpan ke config.json")
            return token

    raise SystemExit("Token kosong. Isi config.json (bot_token) atau jalankan interaktif untuk input token.")

API_TOKEN = get_api_token()

bot = telebot.TeleBot(API_TOKEN)
session = requests.Session()

DOMAIN_RE = re.compile(r"""(?ix)
(?:https?://)?(?:www\.)?
([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)
""")

def extract_domains(text: str):
    found = [m.group(1).lower().strip(".") for m in DOMAIN_RE.finditer(text or "")]
    seen=set(); out=[]
    for d in found:
        if d not in seen:
            seen.add(d); out.append(d)
    return out

def is_valid_domain(domain: str) -> bool:
    return bool(domain and "." in domain and len(domain) <= 253 and DOMAIN_RE.search(domain))

def format_rdap_date(date_str: str) -> str:
    try:
        if not date_str:
            return "-"
        dt = datetime.strptime(date_str.split('.')[0], "%Y-%m-%dT%H:%M:%S")
        return dt.strftime("%d %b %Y, %H:%M UTC")
    except Exception:
        return date_str or "-"

def rdap_url(domain: str) -> str:
    d = domain.lower()
    if d.endswith(".id"):
        return f"https://rdap.pandi.id/rdap/domain/{d}"
    return f"https://rdap.org/domain/{d}"

def rdap_get(domain: str, max_retries: int = 6):
    url = rdap_url(domain)
    headers = {
        "accept": "application/rdap+json, application/json;q=0.9, */*;q=0.8",
        "user-agent": "Mozilla/5.0"
    }

    for attempt in range(max_retries):
        try:
            r = session.get(url, headers=headers, timeout=20)
        except Exception:
            time.sleep(min(60, (2 ** attempt) + random.uniform(0.5, 1.5)))
            continue

        if r.status_code == 200:
            return 200, r.json(), None
        if r.status_code in (404,):
            return 404, None, None
        if r.status_code in (400,):
            return 400, None, None
        if r.status_code == 429:
            ra = r.headers.get("Retry-After")
            wait = int(ra) if (ra and str(ra).isdigit()) else min(60, (2 ** attempt) + random.uniform(0.5, 1.5))
            time.sleep(wait)
            continue
        if 500 <= r.status_code <= 599:
            time.sleep(min(60, (2 ** attempt) + random.uniform(0.5, 1.5)))
            continue

        return r.status_code, None, f"HTTP {r.status_code}"

    return 429, None, "HTTP 429 (rate limited) setelah retry"

def parse_rdap_details(data: dict):
    registrar = "Tidak diketahui"
    for ent in (data.get("entities") or []):
        if "registrar" in (ent.get("roles") or []):
            vcard = ent.get("vcardArray", [])
            if len(vcard) > 1:
                for item in vcard[1]:
                    if item and item[0] == "fn":
                        registrar = item[3]
                        break

    events = {e.get("eventAction"): e.get("eventDate") for e in (data.get("events") or [])}
    dates = {
        "created": format_rdap_date(events.get("registration")),
        "expired": format_rdap_date(events.get("expiration")),
        "updated": format_rdap_date(events.get("last changed") or events.get("last update of RDAP database")),
    }

    ns_list = [ns.get("ldhName") for ns in (data.get("nameservers") or []) if ns.get("ldhName")]
    ns_str = "\n".join([f"• `{ns}`" for ns in ns_list]) if ns_list else "-"

    status_list = data.get("status") or []
    status_str = ", ".join(status_list[:6]) if status_list else "-"

    return {
        "registrar": registrar,
        "dates": dates,
        "ns": ns_str,
        "status": status_str,
        "handle": data.get("handle", "-")
    }

def check_one_domain(domain: str, detailed: bool = True):
    code, data, err = rdap_get(domain)

    if code == 404:
        return (f"✅ **DOMAIN TERSEDIA!**\n\n🌐 Domain: `{domain}`\nStatus: Available (RDAP 404)\nGas checkout bang! 🚀", False) if detailed else (f"✅ `{domain}` — AVAILABLE", False)
    if code == 400:
        return (f"⚠️ `{domain}` — INVALID / BAD REQUEST", True)
    if code != 200 or not data:
        return (f"⚠️ `{domain}`\nRDAP error: {err or ('HTTP '+str(code))}", True)

    details = parse_rdap_details(data)
    if detailed:
        reply = (
            f"❌ **DOMAIN SUDAH TERDAFTAR**\n"
            f"━━━━━━━━━━━━━━━━━━\n"
            f"🌐 **Domain:** `{domain}`\n"
            f"🆔 **Handle:** `{details['handle']}`\n\n"
            f"🏢 **Registrar:**\n{details['registrar']}\n\n"
            f"📅 **Tanggal:**\n"
            f"Register: `{details['dates']['created']}`\n"
            f"Expired : `{details['dates']['expired']}`\n"
            f"Updated : `{details['dates']['updated']}`\n\n"
            f"🔒 **Status:**\n{details['status']}\n\n"
            f"📡 **Name Servers:**\n{details['ns']}"
        )
        return reply, False

    exp = details["dates"].get("expired", "-")
    reg = details.get("registrar", "Unknown")
    return f"❌ `{domain}` — REGISTERED | Exp: `{exp}` | Registrar: {reg}", False

def send_long_message(chat_id: int, text: str, parse_mode="Markdown", reply_to_message_id=None):
    MAX_LEN = 3500
    text = (text or "").strip()
    if len(text) <= MAX_LEN:
        bot.send_message(chat_id, text, parse_mode=parse_mode, reply_to_message_id=reply_to_message_id)
        return
    lines = text.splitlines(True)
    buf = ""
    first = True
    for ln in lines:
        if len(buf) + len(ln) > MAX_LEN:
            bot.send_message(chat_id, buf, parse_mode=parse_mode, reply_to_message_id=reply_to_message_id if first else None)
            first = False
            buf = ""
        buf += ln
    if buf.strip():
        bot.send_message(chat_id, buf, parse_mode=parse_mode, reply_to_message_id=reply_to_message_id if first else None)

@bot.message_handler(commands=["start","help"])
def send_welcome(message):
    bot.reply_to(
        message,
        "Kirim domain untuk cek via RDAP (ICANN-style).\n"
        "Bisa bulk (pisah spasi/enter/koma).\n\n"
        "Contoh:\n"
        "`google.com\nopenai.com, example.net\nbadras.biz.id`",
        parse_mode="Markdown"
    )

@bot.message_handler(func=lambda message: True)
def handle(message):
    domains = extract_domains((message.text or "").strip())
    if not domains:
        bot.reply_to(message, "Format domain salah. Contoh: `interhost.ltd`", parse_mode="Markdown")
        return

    MAX_BULK = 25
    if len(domains) > MAX_BULK:
        domains = domains[:MAX_BULK]
        bot.reply_to(message, f"⚠️ Kebanyakan domain. Aku proses {MAX_BULK} domain pertama dulu ya.", parse_mode="Markdown")

    if len(domains) == 1:
        d = domains[0]
        if not is_valid_domain(d):
            bot.reply_to(message, "Format domain salah.", parse_mode="Markdown")
            return
        msg = bot.reply_to(message, "🔍 Checking via RDAP...", parse_mode="Markdown")
        out, _ = check_one_domain(d, detailed=True)
        bot.edit_message_text(out, message.chat.id, msg.message_id, parse_mode="Markdown")
        return

    status_msg = bot.reply_to(message, f"🔍 Memproses **{len(domains)}** domain via RDAP...", parse_mode="Markdown")
    results, errc = [], 0
    for i, d in enumerate(domains, start=1):
        if not is_valid_domain(d):
            results.append(f"⚠️ `{d}` — INVALID FORMAT")
            errc += 1
            continue

        if i == 1 or i % 4 == 0 or i == len(domains):
            try:
                bot.edit_message_text(f"🔍 Memproses {i}/{len(domains)} ...", message.chat.id, status_msg.message_id, parse_mode="Markdown")
            except Exception:
                pass

        line, is_err = check_one_domain(d, detailed=False)
        if is_err:
            errc += 1
        results.append(line)

        # delay per-domain (SEMULA)
        time.sleep(0.4 + random.random() * 0.6)

    header = f"✅ **Selesai** — Total: **{len(domains)}** | Error: **{errc}**\n\n"

    # EDIT pesan yang sama (tanpa kirim pesan baru)
    final_text = header + "\n\n".join(results)

    # Telegram edit message limit ~4096 char, jadi dipotong kalau kepanjangan
    MAX_EDIT = 3900
    if len(final_text) > MAX_EDIT:
        keep = []
        cur = len(header)
        for line in results:
            if cur + len(line) + 1 > MAX_EDIT - 120:
                break
            keep.append(line)
            cur += len(line) + 1
        final_text = header + "\n".join(keep) + f"\n\n…(dipotong limit Telegram: {len(keep)}/{len(results)} baris)"

    try:
        bot.edit_message_text(final_text, message.chat.id, status_msg.message_id, parse_mode="Markdown")
    except Exception:
        pass

print("Bot berjalan (RDAP / ICANN-style, tanpa Digger)...")
bot.infinity_polling()
