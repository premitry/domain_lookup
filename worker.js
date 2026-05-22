const DOMAIN_RE = /(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)/gi;
const MAX_BULK = 25;

function tgUrl(env, method) {
  return `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
}

async function tg(env, method, payload) {
  const res = await fetch(tgUrl(env, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

async function sendMessage(env, chatId, text, extra = {}) {
  return tg(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...extra,
  });
}

async function reply(env, message, text, extra = {}) {
  return sendMessage(env, message.chat.id, text, { reply_to_message_id: message.message_id, ...extra });
}

async function editMessage(env, chatId, messageId, text, extra = {}) {
  return tg(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...extra,
  });
}

async function answerCallback(env, id, text) {
  try { await tg(env, 'answerCallbackQuery', { callback_query_id: id, text }); } catch (_) {}
}

async function kvGetJson(env, key, fallback) {
  if (!env.BOT_KV) return fallback;
  const raw = await env.BOT_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

async function kvPutJson(env, key, value) {
  if (!env.BOT_KV) return;
  await env.BOT_KV.put(key, JSON.stringify(value));
}

function envAdminIds(env) {
  return String(env.ADMIN_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
}

async function getAdmins(env) {
  const stored = await kvGetJson(env, 'admin_ids', null);
  if (Array.isArray(stored)) return stored.map(Number).filter(Number.isFinite);
  return envAdminIds(env);
}

async function isAdmin(env, userId) {
  const admins = await getAdmins(env);
  return admins.includes(Number(userId));
}

async function getUsers(env) {
  const users = await kvGetJson(env, 'users', []);
  return Array.isArray(users) ? users.map(Number).filter(Number.isFinite) : [];
}

async function putUsers(env, users) {
  await kvPutJson(env, 'users', Array.from(new Set(users.map(Number).filter(Number.isFinite))));
}

function makeBackupPayload(users, admins, reason) {
  return {
    backup_time_utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    reason,
    users,
    admin_ids: admins,
  };
}

async function sendBackupDocument(env, chatId, reason) {
  const admins = await getAdmins(env);
  const users = await getUsers(env);
  const payload = makeBackupPayload(users, admins, reason);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', `📦 Backup data bot\nReason: \`${reason}\`\nUsers: \`${users.length}\`\nAdmins: \`${admins.length}\``);
  form.append('parse_mode', 'Markdown');
  form.append('document', new Blob([JSON.stringify(payload, null, 2) + '\n'], { type: 'application/json' }), `domain-backup-${Date.now()}.json`);
  const res = await fetch(tgUrl(env, 'sendDocument'), { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.description || 'sendDocument failed');
  return data.result;
}

async function sendBackup(env, reason) {
  if (String(env.BACKUP_TO_MAIN_ADMIN || 'true').toLowerCase() === 'false') return;
  const admins = await getAdmins(env);
  if (!admins.length) return;
  try { await sendBackupDocument(env, admins[0], reason); } catch (_) {}
}

async function registerUser(env, chatId) {
  const cid = Number(chatId);
  if (!Number.isFinite(cid)) return;
  const users = await getUsers(env);
  if (!users.includes(cid)) {
    users.push(cid);
    await putUsers(env, users);
    await sendBackup(env, 'new_user');
  }
}

async function setAdmins(env, admins, reason) {
  const clean = Array.from(new Set(admins.map(Number).filter(Number.isFinite)));
  await kvPutJson(env, 'admin_ids', clean);
  if (reason) await sendBackup(env, reason);
}

function extractDomains(text) {
  const seen = new Set();
  const out = [];
  for (const match of String(text || '').matchAll(DOMAIN_RE)) {
    const d = match[1].toLowerCase().replace(/\.+$/, '');
    if (!seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
}

function isValidDomain(domain) {
  return Boolean(domain && domain.includes('.') && domain.length <= 253 && new RegExp(`^${DOMAIN_RE.source}$`, 'i').test(domain));
}

function rdapUrl(domain) {
  const d = domain.toLowerCase();
  return d.endsWith('.id') ? `https://rdap.pandi.id/rdap/domain/${d}` : `https://rdap.org/domain/${d}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function rdapGet(domain, maxRetries = 4) {
  const headers = {
    accept: 'application/rdap+json, application/json;q=0.9, */*;q=0.8',
    'user-agent': 'Mozilla/5.0',
  };
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let res;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      res = await fetch(rdapUrl(domain), { headers, signal: ctrl.signal });
      clearTimeout(timer);
    } catch (_) {
      await sleep(Math.min(8000, (2 ** attempt) * 1000 + 500));
      continue;
    }
    if (res.status === 200) return { code: 200, data: await res.json().catch(() => null), err: null };
    if ([400, 404].includes(res.status)) return { code: res.status, data: null, err: null };
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 8000) : Math.min(8000, (2 ** attempt) * 1000 + 500));
      continue;
    }
    return { code: res.status, data: null, err: `HTTP ${res.status}` };
  }
  return { code: 429, data: null, err: 'HTTP 429 / rate limited setelah retry' };
}

function formatRdapDate(s) {
  if (!s) return '-';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false }).replace(',', '') + ' UTC';
}

function parseRdapDetails(data) {
  let registrar = 'Tidak diketahui';
  for (const ent of data.entities || []) {
    if ((ent.roles || []).includes('registrar') && Array.isArray(ent.vcardArray) && ent.vcardArray.length > 1) {
      for (const item of ent.vcardArray[1]) if (item && item[0] === 'fn') { registrar = item[3]; break; }
    }
  }
  const events = {};
  for (const e of data.events || []) events[e.eventAction] = e.eventDate;
  const ns = (data.nameservers || []).map(n => n.ldhName).filter(Boolean).map(n => `• \`${n}\``).join('\n') || '-';
  return {
    registrar,
    dates: {
      created: formatRdapDate(events.registration),
      expired: formatRdapDate(events.expiration),
      updated: formatRdapDate(events['last changed'] || events['last update of RDAP database']),
    },
    ns,
    status: (data.status || []).slice(0, 6).join(', ') || '-',
    handle: data.handle || '-',
  };
}

async function checkOneDomain(domain, detailed = true) {
  const { code, data, err } = await rdapGet(domain);
  if (code === 404) {
    return detailed
      ? [`✅ **DOMAIN TERSEDIA!**\n\n🌐 Domain: \`${domain}\`\nStatus: Available (RDAP 404)\nGas checkout bang! 🚀`, false]
      : [`✅ \`${domain}\` — AVAILABLE`, false];
  }
  if (code === 400) return [`⚠️ \`${domain}\` — INVALID / BAD REQUEST`, true];
  if (code !== 200 || !data) return [`⚠️ \`${domain}\`\nRDAP error: ${err || `HTTP ${code}`}`, true];
  const x = parseRdapDetails(data);
  if (detailed) {
    return [`❌ **DOMAIN SUDAH TERDAFTAR**\n━━━━━━━━━━━━━━━━━━\n🌐 **Domain:** \`${domain}\`\n🆔 **Handle:** \`${x.handle}\`\n\n🏢 **Registrar:**\n${x.registrar}\n\n📅 **Tanggal:**\nRegister: \`${x.dates.created}\`\nExpired : \`${x.dates.expired}\`\nUpdated : \`${x.dates.updated}\`\n\n🔒 **Status:**\n${x.status}\n\n📡 **Name Servers:**\n${x.ns}`, false];
  }
  return [`❌ \`${domain}\` — REGISTERED | Exp: \`${x.dates.expired}\` | Registrar: ${x.registrar}`, false];
}

async function beginRestore(env, message) {
  await kvPutJson(env, `restore_wait:${message.from.id}`, { chat_id: message.chat.id, at: Date.now() });
  return reply(env, message, '📤 Kirim file backup `.json` sekarang.\n\nFormat harus berisi `users` dan `admin_ids`.');
}

async function downloadTelegramFile(env, fileId) {
  const info = await tg(env, 'getFile', { file_id: fileId });
  if (!info || !info.file_path) throw new Error('file_path tidak ditemukan');
  const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.file_path}`);
  if (!res.ok) throw new Error(`download gagal: HTTP ${res.status}`);
  return res.text();
}

async function handleRestoreDocument(env, message) {
  if (!(await isAdmin(env, message.from.id))) return reply(env, message, '❌ Kamu bukan admin.');
  const waitKey = `restore_wait:${message.from.id}`;
  const waiting = await kvGetJson(env, waitKey, null);
  if (!waiting) return null;
  if (!message.document) return reply(env, message, '📎 Kirim file backup `.json`, bukan teks/foto.');
  const name = String(message.document.file_name || '').toLowerCase();
  if (name && !name.endsWith('.json')) return reply(env, message, '❌ File harus format `.json`.');
  try {
    const text = await downloadTelegramFile(env, message.document.file_id);
    const backup = JSON.parse(text);
    const users = Array.isArray(backup.users) ? backup.users.map(Number).filter(Number.isFinite) : [];
    const admins = Array.isArray(backup.admin_ids) ? backup.admin_ids.map(Number).filter(Number.isFinite) : [];
    if (!users.length) throw new Error('users kosong / tidak valid');
    if (!admins.length) throw new Error('admin_ids kosong / tidak valid');
    await putUsers(env, users);
    await setAdmins(env, admins, null);
    if (env.BOT_KV) await env.BOT_KV.delete(waitKey);
    await sendBackup(env, 'restore');
    return reply(env, message, `✅ Restore berhasil!\n\n👥 Users: ${users.length}\n👑 Admin: ${admins.length}`);
  } catch (err) {
    return reply(env, message, `❌ Gagal restore: ${err.message}`);
  }
}

async function handleCommand(env, message, text) {
  const cmd = text.split(/\s+/, 1)[0].toLowerCase();
  if (cmd === '/start' || cmd === '/help') {
    return reply(env, message, 'Kirim domain untuk cek via RDAP (ICANN-style).\nBisa bulk (pisah spasi/enter/koma).\n\nContoh:\n`google.com\nopenai.com, example.net\nbadras.biz.id`');
  }
  if (cmd === '/myid') return reply(env, message, `🆔 ID kamu: \`${message.from.id}\`\n💬 Chat ID: \`${message.chat.id}\``);
  if (cmd === '/setadmin') {
    const admins = await getAdmins(env);
    if (admins.length) return reply(env, message, 'Admin sudah ada. Gunakan /addadmin <id> (admin only).');
    await setAdmins(env, [message.from.id], 'add_admin');
    await registerUser(env, message.chat.id);
    return reply(env, message, `✅ Kamu jadi admin pertama.\nID: \`${message.from.id}\``);
  }
  if (!(await isAdmin(env, message.from.id))) return reply(env, message, '❌ Kamu bukan admin.');
  if (cmd === '/admins') {
    const admins = await getAdmins(env);
    return reply(env, message, '👑 Admin IDs:\n' + admins.map(a => `- ${a}`).join('\n'));
  }
  if (cmd === '/addadmin') {
    const uid = Number(text.split(/\s+/, 2)[1]);
    if (!Number.isFinite(uid)) return reply(env, message, 'Format: /addadmin <id>\nContoh: /addadmin 12345678');
    const admins = await getAdmins(env);
    if (!admins.includes(uid)) admins.push(uid);
    await setAdmins(env, admins, 'add_admin');
    return reply(env, message, `✅ Admin ditambahkan: \`${uid}\``);
  }
  if (cmd === '/deladmin') {
    const uid = Number(text.split(/\s+/, 2)[1]);
    const admins = await getAdmins(env);
    if (!Number.isFinite(uid)) return reply(env, message, 'Format: /deladmin <id>');
    if (!admins.includes(uid)) return reply(env, message, `⚠️ ID \`${uid}\` bukan admin.`);
    if (admins.length <= 1) return reply(env, message, '⚠️ Tidak bisa hapus admin terakhir.');
    await setAdmins(env, admins.filter(a => a !== uid), 'del_admin');
    return reply(env, message, `✅ Admin dihapus: \`${uid}\``);
  }
  if (cmd === '/backup') {
    try {
      await sendBackupDocument(env, message.chat.id, 'manual_backup');
      return;
    } catch (err) {
      return reply(env, message, `❌ Gagal membuat backup: ${err.message}`);
    }
  }
  if (cmd === '/restore') return beginRestore(env, message);
  if (cmd === '/stats') {
    const users = await getUsers(env), admins = await getAdmins(env);
    return reply(env, message, `📊 Stats\n\n👥 Users tersimpan: ${users.length}\n👑 Admin: ${admins.length}`);
  }
  if (cmd === '/bc') {
    const msg = text.replace(/^\/bc\s*/i, '').trim();
    if (!msg) return reply(env, message, 'Format: /bc <pesan>\nContoh: /bc Halo semua!');
    const users = await getUsers(env);
    if (!users.length) return reply(env, message, 'Belum ada user tersimpan.');
    const key = `${message.from.id}:${message.chat.id}:${message.message_id}`;
    await kvPutJson(env, `pending:${key}`, { msg, users });
    return reply(env, message, `📣 Konfirmasi broadcast ke **${users.length}** chat:\n\n${msg.slice(0, 800)}`, {
      reply_markup: { inline_keyboard: [[
        { text: '✅ Kirim', callback_data: `bc_send|${key}` },
        { text: '❌ Batal', callback_data: `bc_cancel|${key}` },
      ]] },
    });
  }
}

async function handleCallback(env, call) {
  const [action, key] = String(call.data || '').split('|');
  if (!action || !key) return answerCallback(env, call.id, 'Invalid data');
  const adminId = Number(key.split(':')[0]);
  if (call.from.id !== adminId) return answerCallback(env, call.id, '❌ Bukan untuk kamu.');
  const pendingKey = `pending:${key}`;
  const data = await kvGetJson(env, pendingKey, null);
  if (!data) return answerCallback(env, call.id, '⚠️ Broadcast sudah tidak aktif.');
  if (action === 'bc_cancel') {
    if (env.BOT_KV) await env.BOT_KV.delete(pendingKey);
    await editMessage(env, call.message.chat.id, call.message.message_id, '❌ Broadcast dibatalkan.').catch(() => {});
    return answerCallback(env, call.id, 'Dibatalkan');
  }
  if (action !== 'bc_send') return answerCallback(env, call.id, 'Unknown action');
  await editMessage(env, call.message.chat.id, call.message.message_id, `📣 Mengirim broadcast ke ${data.users.length} chat...`).catch(() => {});
  let ok = 0, fail = 0;
  for (const cid of data.users || []) {
    try { await sendMessage(env, cid, data.msg, { parse_mode: undefined }); ok++; }
    catch (_) { fail++; const users = (await getUsers(env)).filter(u => u !== Number(cid)); await putUsers(env, users); }
  }
  if (fail) await sendBackup(env, 'remove_user');
  if (env.BOT_KV) await env.BOT_KV.delete(pendingKey);
  await editMessage(env, call.message.chat.id, call.message.message_id, `✅ Broadcast selesai.\nTerkirim: ${ok}\nGagal: ${fail}`).catch(() => {});
  return answerCallback(env, call.id, 'Selesai ✅');
}

async function handleMessage(env, message) {
  const text = String(message.text || '').trim();
  await registerUser(env, message.chat.id);
  if (message.document) {
    const restored = await handleRestoreDocument(env, message);
    if (restored) return restored;
  }
  if (text.startsWith('/')) return handleCommand(env, message, text);
  if (!text) return;
  let domains = extractDomains(text);
  if (!domains.length) return reply(env, message, 'Format domain salah. Contoh: `interhost.ltd`');
  if (domains.length > MAX_BULK) {
    domains = domains.slice(0, MAX_BULK);
    await reply(env, message, `⚠️ Kebanyakan domain. Aku proses ${MAX_BULK} domain pertama dulu ya.`);
  }
  if (domains.length === 1) {
    const d = domains[0];
    if (!isValidDomain(d)) return reply(env, message, 'Format domain salah.');
    const status = await reply(env, message, '🔍 Checking via RDAP...');
    const [out] = await checkOneDomain(d, true);
    return editMessage(env, message.chat.id, status.message_id, out).catch(() => sendMessage(env, message.chat.id, out));
  }
  const status = await reply(env, message, `🔍 Memproses **${domains.length}** domain via RDAP...`);
  const results = [];
  let errc = 0;
  for (let i = 0; i < domains.length; i++) {
    const d = domains[i];
    if (!isValidDomain(d)) { results.push(`⚠️ \`${d}\` — INVALID FORMAT`); errc++; continue; }
    if (i === 0 || (i + 1) % 4 === 0 || i === domains.length - 1) await editMessage(env, message.chat.id, status.message_id, `🔍 Memproses ${i + 1}/${domains.length} ...`).catch(() => {});
    const [line, isErr] = await checkOneDomain(d, false);
    if (isErr) errc++;
    results.push(line);
    await sleep(250);
  }
  let finalText = `✅ **Selesai** — Total: **${domains.length}** | Error: **${errc}**\n\n` + results.join('\n\n');
  if (finalText.length > 3900) finalText = finalText.slice(0, 3800) + '\n\n…(dipotong limit Telegram)';
  return editMessage(env, message.chat.id, status.message_id, finalText).catch(() => sendMessage(env, message.chat.id, finalText));
}

export default {
  async fetch(request, env) {
    if (request.method === 'GET') return new Response('domain_lookup worker OK');
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    if (!env.BOT_TOKEN) return new Response('Missing BOT_TOKEN', { status: 500 });
    const update = await request.json().catch(() => null);
    if (!update) return new Response('Bad Request', { status: 400 });
    try {
      if (update.callback_query) await handleCallback(env, update.callback_query);
      else if (update.message) await handleMessage(env, update.message);
    } catch (e) {
      console.error(e);
    }
    return new Response('OK');
  },
};
