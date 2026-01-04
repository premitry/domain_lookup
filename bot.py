import os, re, time, random, json, sys
from datetime import datetime
from pathlib import Path
import requests
import telebot=
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton


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

# --- BROADCAST / ADMIN ---
CFG_PATH = Path(__file__).with_name("config.json")

def _cfg():
    # reload setiap kali supaya perubahan config langsung kebaca
    return load_config(CFG_PATH) if 'load_config' in globals() else {}

def _save(cfg: dict):
    if 'save_config' in globals():
        save_config(CFG_PATH, cfg)
    else:
        CFG_PATH.write_text(__import__("json").dumps(cfg, indent=2) + "\n", encoding="utf-8")

def get_admin_ids():
    cfg = _cfg()
    admins = cfg.get("admin_ids") or cfg.get("admins") or []
    out = []
    for x in admins:
        try:
            out.append(int(x))
        except Exception:
            pass
    # simpan balik normalisasi key "admin_ids"
    if cfg.get("admin_ids") != out:
        cfg["admin_ids"] = out
        _save(cfg)
    return out

def is_admin(user_id: int) -> bool:
    return int(user_id) in set(get_admin_ids())

def register_user(chat_id: int):
    cfg = _cfg()
    users = cfg.get("users") or []
    try:
        chat_id = int(chat_id)
    except Exception:
        return
    if chat_id not in users:
        users.append(chat_id)
        cfg["users"] = users
        _save(cfg)

def add_admin_id(user_id: int):
    cfg = _cfg()
    admins = cfg.get("admin_ids") or []
    uid = int(user_id)
    if uid not in admins:
        admins.append(uid)
    cfg["admin_ids"] = admins
    _save(cfg)

def del_admin_id(user_id: int):
    cfg = _cfg()
    admins = cfg.get("admin_ids") or []
    uid = int(user_id)
    if uid in admins:
        admins.remove(uid)
    cfg["admin_ids"] = admins
    _save(cfg)

def remove_user(chat_id: int):
    cfg = _cfg()
    users = cfg.get("users") or []
    try:
        chat_id = int(chat_id)
    except Exception:
        return
    if chat_id in users:
        users.remove(chat_id)
        cfg["users"] = users
        _save(cfg)

PENDING_BROADCAST = {}


>>>>>>> 9d4966e (Add admin broadcast features and update README)
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

<<<<<<< HEAD
@bot.message_handler(func=lambda message: True)
def handle(message):
    domains = extract_domains((message.text or "").strip())
=======


# --- ADMIN COMMANDS ---
@bot.message_handler(commands=["myid"])
def cmd_myid(message):
    bot.reply_to(
        message,
        f"🆔 ID kamu: `{message.from_user.id}`\n💬 Chat ID: `{message.chat.id}`",
        parse_mode="Markdown"
    )

@bot.message_handler(commands=["admins"])
def cmd_admins(message):
    if not is_admin(message.from_user.id):
        bot.reply_to(message, "❌ Kamu bukan admin.")
        return
    admins = get_admin_ids()
    bot.reply_to(message, "👑 Admin IDs:\n" + "\n".join([f"- {a}" for a in admins]))

@bot.message_handler(commands=["setadmin"])
def cmd_setadmin(message):
    # bootstrap: kalau admin_ids kosong, siapa pun boleh set admin pertama
    admins = get_admin_ids()
    if admins:
        bot.reply_to(message, "Admin sudah ada. Gunakan /addadmin <id> (admin only).")
        return
    add_admin_id(message.from_user.id)
    bot.reply_to(message, f"✅ Kamu jadi admin pertama.\nID: `{message.from_user.id}`", parse_mode="Markdown")

@bot.message_handler(commands=["addadmin"])
def cmd_addadmin(message):
    if not is_admin(message.from_user.id):
        bot.reply_to(message, "❌ Kamu bukan admin.")
        return
    parts = (message.text or "").split(maxsplit=1)
    if len(parts) < 2 or not parts[1].strip().lstrip("-").isdigit():
        bot.reply_to(message, "Format: /addadmin <id>\nContoh: /addadmin 12345678")
        return
    uid = int(parts[1].strip())
    add_admin_id(uid)
    bot.reply_to(message, f"✅ Admin ditambahkan: `{uid}`", parse_mode="Markdown")

@bot.message_handler(commands=["deladmin"])
def cmd_deladmin(message):
    if not is_admin(message.from_user.id):
        bot.reply_to(message, "❌ Kamu bukan admin.")
        return
    parts = (message.text or "").split(maxsplit=1)
    if len(parts) < 2 or not parts[1].strip().lstrip("-").isdigit():
        bot.reply_to(message, "Format: /deladmin <id>\nContoh: /deladmin 12345678")
        return
    uid = int(parts[1].strip())
    admins = get_admin_ids()
    if uid not in admins:
        bot.reply_to(message, f"⚠️ ID `{uid}` bukan admin.", parse_mode="Markdown")
        return
    if len(admins) <= 1:
        bot.reply_to(message, "⚠️ Tidak bisa hapus admin terakhir.")
        return
    del_admin_id(uid)
    bot.reply_to(message, f"✅ Admin dihapus: `{uid}`", parse_mode="Markdown")

@bot.message_handler(commands=["stats"])
def cmd_stats(message):
    if not is_admin(message.from_user.id):
        bot.reply_to(message, "❌ Kamu bukan admin.")
        return
    cfg = _cfg()
    users = cfg.get("users") or []
    admins = get_admin_ids()
    bot.reply_to(
        message,
        f"📊 Stats\n\n👥 Users tersimpan: {len(users)}\n👑 Admin: {len(admins)}",
    )

@bot.message_handler(commands=["bc"])
def cmd_broadcast(message):
    if not is_admin(message.from_user.id):
        bot.reply_to(message, "❌ Kamu bukan admin.")
        return

    parts = (message.text or "").split(maxsplit=1)
    if len(parts) < 2 or not parts[1].strip():
        bot.reply_to(message, "Format: /bc <pesan>\nContoh: /bc Halo semua!")
        return

    msg = parts[1].strip()
    cfg = _cfg()
    users = cfg.get("users") or []
    if not users:
        bot.reply_to(message, "Belum ada user tersimpan (belum ada yang chat bot).")
        return

    # tombol konfirmasi
    key = f"{message.from_user.id}:{message.chat.id}:{message.message_id}"
    PENDING_BROADCAST[key] = {"msg": msg, "users": list(users)}

    kb = InlineKeyboardMarkup()
    kb.add(
        InlineKeyboardButton("✅ Kirim", callback_data=f"bc_send|{key}"),
        InlineKeyboardButton("❌ Batal", callback_data=f"bc_cancel|{key}")
    )

    preview = msg if len(msg) <= 800 else (msg[:800] + "…")
    bot.reply_to(
        message,
        f"📣 Konfirmasi broadcast ke **{len(users)}** chat:\n\n{preview}",
        parse_mode="Markdown",
        reply_markup=kb
    )

@bot.callback_query_handler(func=lambda call: bool(call.data) and call.data.startswith("bc_"))
def cb_broadcast(call):
    try:
        action, key = call.data.split("|", 1)
    except Exception:
        bot.answer_callback_query(call.id, "Invalid data")
        return

    # hanya admin pemilik yang bisa konfirmasi
    try:
        admin_id = int(key.split(":", 1)[0])
    except Exception:
        bot.answer_callback_query(call.id, "Invalid key")
        return

    if call.from_user.id != admin_id:
        bot.answer_callback_query(call.id, "❌ Bukan untuk kamu.")
        return

    data = PENDING_BROADCAST.get(key)
    if not data:
        bot.answer_callback_query(call.id, "⚠️ Broadcast sudah tidak aktif.")
        return

    if action == "bc_cancel":
        PENDING_BROADCAST.pop(key, None)
        try:
            bot.edit_message_text("❌ Broadcast dibatalkan.", call.message.chat.id, call.message.message_id)
        except Exception:
            pass
        bot.answer_callback_query(call.id, "Dibatalkan")
        return

    if action != "bc_send":
        bot.answer_callback_query(call.id, "Unknown action")
        return

    # kirim broadcast
    users = data.get("users") or []
    msg = data.get("msg") or ""
    ok = 0
    fail = 0

    try:
        bot.edit_message_text(f"📣 Mengirim broadcast ke {len(users)} chat...", call.message.chat.id, call.message.message_id)
    except Exception:
        pass

    for cid in list(users):
        try:
            bot.send_message(cid, msg)
            ok += 1
        except Exception:
            fail += 1
            remove_user(cid)

    PENDING_BROADCAST.pop(key, None)

    try:
        bot.edit_message_text(
            f"✅ Broadcast selesai.\nTerkirim: {ok}\nGagal: {fail}",
            call.message.chat.id,
            call.message.message_id
        )
    except Exception:
        pass

    bot.answer_callback_query(call.id, "Selesai ✅")

@bot.message_handler(func=lambda message: True)
def handle(message):
    text = (message.text or "").strip()
    register_user(message.chat.id)
    if text.startswith("/"):
        return
    domains = extract_domains(text)
>>>>>>> 9d4966e (Add admin broadcast features and update README)
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

print("Bot berjalan...")
bot.infinity_polling()
