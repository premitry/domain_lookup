const DOMAIN_RE = /(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)/gi;
const MAX_BULK = 25;

// Watermark/footer brand di tiap hasil. Edit satu tempat ini kalau mau ganti handle.
const WM = '\n\n➖➖➖➖➖➖➖\n🤖 @ICannDomainbot  ·  📢 @ParcivProduct';
function withWm(text) { return `${text}${WM}`; }

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
  if (!res.ok || data.ok === false) {
    // Simpan status + retry_after di error-nya: dipakai broadcast buat bedain
    // "user blokir bot" (permanen) vs error sementara (flood limit / 5xx).
    const err = new Error(data.description || `Telegram ${method} failed`);
    err.status = res.status;
    err.retryAfter = Number((data.parameters || {}).retry_after) || 0;
    throw err;
  }
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

// Kirim teks panjang: edit pesan status utk potongan pertama, sisanya jadi pesan lanjutan
// (biar nggak kepotong limit ~4096 char Telegram). Split di batas baris.
async function sendChunked(env, chatId, firstMsgId, text) {
  const LIMIT = 3900;
  if (text.length <= LIMIT) {
    return editMessage(env, chatId, firstMsgId, text).catch(() => sendMessage(env, chatId, text));
  }
  const chunks = [];
  let cur = '';
  for (const ln of text.split('\n')) {
    if (cur && (cur.length + 1 + ln.length) > LIMIT) { chunks.push(cur); cur = ln; }
    else cur = cur ? `${cur}\n${ln}` : ln;
  }
  if (cur) chunks.push(cur);
  await editMessage(env, chatId, firstMsgId, chunks[0]).catch(() => sendMessage(env, chatId, chunks[0]));
  for (let i = 1; i < chunks.length; i++) await sendMessage(env, chatId, chunks[i]);
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

const IANA_RDAP_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';

// Ambil peta TLD→server RDAP resmi dari IANA (gratis, tanpa key). Di-cache di KV 7 hari.
async function getRdapMap(env) {
  const cached = await kvGetJson(env, 'rdap_bootstrap_map', null);
  if (cached && typeof cached === 'object' && Object.keys(cached).length) return cached;
  try {
    const res = await fetch(IANA_RDAP_BOOTSTRAP, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const map = {};
    for (const svc of data.services || []) {
      const tlds = svc[0] || [];
      const urls = svc[1] || [];
      const base = (urls.find(u => u.startsWith('https://')) || urls[0] || '').replace(/\/+$/, '');
      if (!base) continue;
      for (const tld of tlds) map[String(tld).toLowerCase()] = base;
    }
    if (env.BOT_KV && Object.keys(map).length) {
      await env.BOT_KV.put('rdap_bootstrap_map', JSON.stringify(map), { expirationTtl: 604800 });
    }
    return map;
  } catch (_) {
    return null;
  }
}

// Tembak langsung ke registry resmi; fallback ke rdap.org kalau TLD tak ditemukan.
async function resolveRdapUrl(env, domain) {
  const d = domain.toLowerCase();
  if (d.endsWith('.id')) return `https://rdap.pandi.id/rdap/domain/${d}`;
  const tld = d.split('.').pop();
  const map = await getRdapMap(env);
  const base = map && map[tld];
  return base ? `${base}/domain/${d}` : `https://rdap.org/domain/${d}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Ulang request RDAP lewat proxy non-Cloudflare (Vercel) saat registry nge-WAF
// IP Worker (403/451). Aktif cuma kalau RDAP_PROXY_URL + RDAP_PROXY_KEY diset.
// Registry kayak gmoregistry (.shop) sering ngasih 429 ke IP proxy → retry backoff.
async function rdapViaProxy(env, rdapUrl, maxRetries = 3) {
  if (!env || !env.RDAP_PROXY_URL || !env.RDAP_PROXY_KEY) return null;
  const base = env.RDAP_PROXY_URL;
  const purl = `${base}${base.includes('?') ? '&' : '?'}url=${encodeURIComponent(rdapUrl)}`;
  let lastCode = 0;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let res;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      res = await fetch(purl, { headers: { accept: 'application/rdap+json, application/json', 'x-proxy-key': env.RDAP_PROXY_KEY }, signal: ctrl.signal });
      clearTimeout(timer);
    } catch (_) {
      await sleep(Math.min(6000, (2 ** attempt) * 1000 + 500));
      continue;
    }
    lastCode = res.status;
    if (res.status === 200) return { code: 200, data: await res.json().catch(() => null), err: null };
    if ([400, 404].includes(res.status)) return { code: res.status, data: null, err: null };
    // Upstream registry rate-limit (429) / sesaat (5xx) → backoff & ulang.
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      await sleep(Math.min(4000, (2 ** attempt) * 1000 + 800));
      continue;
    }
    return null; // proxy ikut gagal (blok lain) → caller lanjut ke fallback WHOIS
  }
  return null; // habis retry tetap 429/5xx → fallback WHOIS
}

async function rdapGet(env, domain, maxRetries = 3) {
  // UA browser lengkap: 'Mozilla/5.0' polos sering dianggap bot oleh WAF registry (403).
  const headers = {
    accept: 'application/rdap+json, application/json;q=0.9, */*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
  const url = await resolveRdapUrl(env, domain);
  let lastCode = 0;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let res;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(timer);
    } catch (_) {
      await sleep(Math.min(8000, (2 ** attempt) * 1000 + 500));
      continue;
    }
    lastCode = res.status;
    if (res.status === 200) return { code: 200, data: await res.json().catch(() => null), err: null };
    if ([400, 404].includes(res.status)) return { code: res.status, data: null, err: null };
    // 403/451: registry blokir range IP CF Worker (WAF). RDAP-nya sendiri 200 dari
    // IP biasa → coba ulang lewat proxy non-CF (Vercel) kalau dikonfigurasi.
    if (res.status === 403 || res.status === 451) {
      const viaProxy = await rdapViaProxy(env, url);
      if (viaProxy) return viaProxy;
      return { code: res.status, data: null, err: `HTTP ${res.status} — registry memblokir request` };
    }
    // 429/5xx: rate-limit/sesaat → retry dgn backoff.
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 3000) : Math.min(3000, (2 ** attempt) * 1000 + 500));
      continue;
    }
    return { code: res.status, data: null, err: `HTTP ${res.status}` };
  }
  if (lastCode === 403 || lastCode === 451) {
    return { code: lastCode, data: null, err: `HTTP ${lastCode} — registry memblokir request (kemungkinan WAF / IP Worker), coba lagi nanti` };
  }
  return { code: lastCode || 429, data: null, err: `HTTP ${lastCode || 429} / rate limited setelah retry` };
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

// ── Fallback IP2WHOIS (dipakai hanya saat RDAP diblokir registry 403/451) ──
function ip2whoisUrl(domain, key) {
  return `https://api.ip2whois.com/v2?key=${encodeURIComponent(key)}&domain=${encodeURIComponent(domain)}`;
}

async function ip2whoisGet(domain, key, maxRetries = 3) {
  let lastCode = 0;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let res;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      res = await fetch(ip2whoisUrl(domain, key), { headers: { accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(timer);
    } catch (_) {
      await sleep(Math.min(6000, (2 ** attempt) * 1000 + 500));
      continue;
    }
    lastCode = res.status;
    const data = await res.json().catch(() => null);
    // IP2WHOIS kadang balikin error dalam body walau HTTP 200 (key salah / kuota habis)
    if (data && data.error) {
      return { code: 400, data: null, err: data.error.error_message || `IP2WHOIS err ${data.error.error_code || ''}`.trim() };
    }
    if (res.status === 200 && data) return { code: 200, data, err: null };
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      await sleep(Math.min(6000, (2 ** attempt) * 1000 + 500));
      continue;
    }
    return { code: res.status, data: null, err: `IP2WHOIS HTTP ${res.status}` };
  }
  return { code: lastCode || 429, data: null, err: `IP2WHOIS gagal (HTTP ${lastCode || 429})` };
}

function ip2whoisIsAvailable(data) {
  return !data.create_date && !data.expire_date && !(data.registrar && data.registrar.name);
}

function parseIp2whoisDetails(data) {
  const nsRaw = data.nameservers;
  const nsList = Array.isArray(nsRaw) ? nsRaw : String(nsRaw || '').split(',').map(s => s.trim());
  const ns = nsList.filter(Boolean).map(n => `• \`${n}\``).join('\n') || '-';
  return {
    registrar: (data.registrar && data.registrar.name) || 'Tidak diketahui',
    dates: {
      created: formatRdapDate(data.create_date),
      expired: formatRdapDate(data.expire_date),
      updated: formatRdapDate(data.update_date),
    },
    ns,
    status: (Array.isArray(data.status) ? data.status.join(', ') : data.status) || '-',
    handle: data.domain_id || '-',
  };
}

// ── IP geolocation via IP2Location.io (command /ip) ──
function isValidIp(ip) {
  const s = String(ip || '').trim();
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) return m.slice(1).every(o => Number(o) <= 255);
  return s.includes(':') && /^[0-9a-f:]+$/i.test(s) && s.length <= 45; // IPv6 (cek longgar)
}

function ip2locationUrl(ip, key) {
  return `https://api.ip2location.io/?key=${encodeURIComponent(key)}&ip=${encodeURIComponent(ip)}`;
}

async function ip2locationGet(ip, key, maxRetries = 3) {
  let lastCode = 0;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let res;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      res = await fetch(ip2locationUrl(ip, key), { headers: { accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(timer);
    } catch (_) {
      await sleep(Math.min(6000, (2 ** attempt) * 1000 + 500));
      continue;
    }
    lastCode = res.status;
    const data = await res.json().catch(() => null);
    if (data && data.error) {
      return { code: 400, data: null, err: data.error.error_message || `IP2Location err ${data.error.error_code || ''}`.trim() };
    }
    if (res.status === 200 && data) return { code: 200, data, err: null };
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      await sleep(Math.min(6000, (2 ** attempt) * 1000 + 500));
      continue;
    }
    return { code: res.status, data: null, err: `IP2Location HTTP ${res.status}` };
  }
  return { code: lastCode || 429, data: null, err: `IP2Location gagal (HTTP ${lastCode || 429})` };
}

function formatIpInfo(ip, d) {
  const loc = [d.city_name, d.region_name, d.country_name].filter(Boolean).join(', ') || '-';
  const isp = d.isp || d.as || (d.asn ? `AS${d.asn}` : '-');
  const coords = (d.latitude != null && d.longitude != null) ? `${d.latitude}, ${d.longitude}` : '-';
  const flag = d.country_code ? ` (${d.country_code})` : '';
  const proxy = d.is_proxy ? '⚠️ Ya' : 'Tidak';
  return `🌍 **IP LOOKUP**\n━━━━━━━━━━━━━━━━━━\n📡 **IP:** \`${ip}\`\n\n📍 **Lokasi:** ${loc}${flag}\n🏢 **ISP / AS:** ${isp}\n🕒 **Zona Waktu:** ${d.time_zone || '-'}\n📮 **Kode Pos:** ${d.zip_code || '-'}\n🧭 **Koordinat:** \`${coords}\`\n🕵️ **Proxy/VPN:** ${proxy}`;
}

// ── Fallback #2: WhoisJSON (whoisjson.com, ~1000/bln, punya boolean `registered`) ──
async function whoisjsonGet(domain, key, maxRetries = 3) {
  let lastCode = 0;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let res;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      res = await fetch(`https://whoisjson.com/api/v1/whois?domain=${encodeURIComponent(domain)}`, {
        headers: { accept: 'application/json', authorization: `Token=${key}` },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
    } catch (_) {
      await sleep(Math.min(6000, (2 ** attempt) * 1000 + 500));
      continue;
    }
    lastCode = res.status;
    const data = await res.json().catch(() => null);
    if (data && (data.error || data.message) && typeof data.registered !== 'boolean') {
      return { code: 400, data: null, err: data.error || data.message };
    }
    if (res.status === 200 && data) return { code: 200, data, err: null };
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      await sleep(Math.min(6000, (2 ** attempt) * 1000 + 500));
      continue;
    }
    return { code: res.status, data: null, err: `WhoisJSON HTTP ${res.status}` };
  }
  return { code: lastCode || 429, data: null, err: `WhoisJSON gagal (HTTP ${lastCode || 429})` };
}

function parseWhoisjsonDetails(data) {
  const nsList = Array.isArray(data.nameserver) ? data.nameserver : [];
  const ns = nsList.filter(Boolean).map(n => `• \`${n}\``).join('\n') || '-';
  const reg = data.registrar || {};
  return {
    registrar: reg.name || 'Tidak diketahui',
    dates: {
      created: formatRdapDate(data.created),
      expired: formatRdapDate(data.expires),
      updated: formatRdapDate(data.changed),
    },
    ns,
    status: (Array.isArray(data.status) ? data.status.join(', ') : data.status) || '-',
    handle: '-',
  };
}

// Query satu tipe DNS record via DoH Cloudflare (gratis, gak butuh key).
const DOH_TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28 };
async function dohQuery(domain, type) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, {
      headers: { accept: 'application/dns-json' }, signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { status: -1, records: [] };
    const data = await res.json().catch(() => null);
    if (!data) return { status: -1, records: [] };
    const want = DOH_TYPE[type];
    const records = (data.Answer || []).filter(a => a.type === want).map(a => String(a.data || '').replace(/\.$/, '')).filter(Boolean);
    return { status: data.Status, records };
  } catch (_) { return { status: -1, records: [] }; }
}

// Ambil daftar NS via DoH. Balikin [] kalau NXDOMAIN / gagal.
async function dohNameservers(domain) {
  return (await dohQuery(domain, 'NS')).records;
}

// Lookup beberapa tipe record sekaligus (paralel) buat command /dns.
async function dnsLookup(domain) {
  const types = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'CAA', 'SOA'];
  const res = await Promise.all(types.map(t => dohQuery(domain, t)));
  const map = {};
  types.forEach((t, i) => { map[t] = res[i]; });
  return map;
}

function formatDnsResult(domain, map) {
  const nx = Object.values(map).every(r => !r.records.length) && (map.A.status === 3 || map.NS.status === 3);
  if (nx) return `🔎 **DNS LOOKUP**\n━━━━━━━━━━━━━━━━━━\n🌐 \`${domain}\`\n\n⚠️ Nggak ke-resolve (NXDOMAIN) — kemungkinan belum kedaftar / tanpa DNS aktif.`;
  const line = (label, arr, max = 20) => {
    if (!arr.length) return '';
    const shown = arr.slice(0, max).map(v => `• \`${v.length > 120 ? v.slice(0, 120) + '…' : v}\``).join('\n');
    const more = arr.length > max ? `\n_…+${arr.length - max} lagi_` : '';
    return `\n**${label}:**\n${shown}${more}\n`;
  };
  let body = '';
  body += line('A (IPv4)', map.A.records);
  body += line('AAAA (IPv6)', map.AAAA.records);
  body += line('CNAME', map.CNAME.records);
  body += line('MX (mail)', map.MX.records);
  body += line('NS (nameserver)', map.NS.records);
  body += line('TXT', map.TXT.records);
  body += line('CAA', map.CAA.records);
  body += line('SOA', map.SOA.records, 1);
  if (!body.trim()) body = '\n_(nggak ada record yang kebaca)_';
  const empties = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'CAA'].filter(t => !map[t].records.length);
  const foot = empties.length ? `\n_Kosong (disembunyiin): ${empties.join(', ')}_` : '';
  return `🔎 **DNS LOOKUP**\n━━━━━━━━━━━━━━━━━━\n🌐 \`${domain}\`\n${body}${foot}`;
}

// Saran domain (AI) via domscan /v1/suggest + cek availability sekalian.
async function domscanSuggest(keywords, key, tlds = 'com,net,io,co,id', limit = 15) {
  try {
    const q = `keywords=${encodeURIComponent(keywords)}&tlds=${encodeURIComponent(tlds)}&limit=${limit}&check=true`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    const res = await fetch(`https://domscan.net/v1/suggest?${q}`, {
      headers: { accept: 'application/json', 'x-api-key': key }, signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => null);
    if (res.status !== 200 || !data) return { ok: false, err: (data && data.error && data.error.message) || `HTTP ${res.status}`, list: [] };
    return { ok: true, err: null, list: Array.isArray(data.suggestions) ? data.suggestions : [] };
  } catch (e) { return { ok: false, err: String((e && e.message) || e), list: [] }; }
}

function formatSuggest(keywords, list) {
  if (!list.length) return `✨ **SARAN DOMAIN**\n━━━━━━━━━━━━━━━━━━\nKata kunci: \`${keywords}\`\n\n⚠️ Nggak ada saran yang muncul. Coba kata lain.`;
  const avail = list.filter(s => s.available === true);
  const taken = list.filter(s => s.available === false);
  const fmt = arr => arr.slice(0, 15).map(s => `\`${s.domain}\`${s.score ? ` _(skor ${s.score})_` : ''}`).join('\n');
  let out = `✨ **SARAN DOMAIN**\n━━━━━━━━━━━━━━━━━━\n🔑 Kata kunci: \`${keywords}\`\n`;
  if (avail.length) out += `\n✅ **Tersedia (bisa dibeli):**\n${fmt(avail)}\n`;
  if (taken.length) out += `\n❌ **Udah kepake:**\n${taken.slice(0, 8).map(s => `\`${s.domain}\``).join(', ')}\n`;
  return out;
}

// ── Fallback #3: combo DomScan /v1/status (verdict) + DoH (nameserver) ──

async function domscanStatus(domain, key, maxRetries = 2) {
  let lastCode = 0;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let res;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      res = await fetch(`https://domscan.net/v1/status?domain=${encodeURIComponent(domain)}`, {
        headers: { accept: 'application/json', 'x-api-key': key }, signal: ctrl.signal,
      });
      clearTimeout(timer);
    } catch (_) {
      await sleep(Math.min(4000, (2 ** attempt) * 1000 + 500));
      continue;
    }
    lastCode = res.status;
    const data = await res.json().catch(() => null);
    if (res.status === 200 && data && Array.isArray(data.results) && data.results[0]) {
      return { code: 200, data: data.results[0], err: null };
    }
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      await sleep(Math.min(4000, (2 ** attempt) * 1000 + 500));
      continue;
    }
    return { code: res.status, data: null, err: `DomScan HTTP ${res.status}` };
  }
  return { code: lastCode || 429, data: null, err: `DomScan gagal (HTTP ${lastCode || 429})` };
}

// Tebak registrar dari link RDAP registrar di proof.links (mis. rdap.markmonitor.com → Markmonitor).
function registrarFromDomscanProof(proof) {
  for (const l of (proof && proof.links) || []) {
    if ((l.rel === 'about' || l.rel === 'related') && l.href) {
      try {
        const name = new URL(l.href).hostname.replace(/^rdap\./, '').split('.')[0];
        if (name && name !== 'gmoregistry') return name.charAt(0).toUpperCase() + name.slice(1);
      } catch (_) {}
    }
  }
  return 'Tidak diketahui';
}

// `data` = hasil results[0] domscan + properti _ns (daftar NS dari DoH) yang ditempel di fallbackLookup.
function parseDomscanDetails(data) {
  const events = {};
  for (const e of data.rdap_events || []) events[e.eventAction] = e.eventDate;
  const ns = (data._ns || []).filter(Boolean).map(n => `• \`${n}\``).join('\n') || '-';
  const status = (Array.isArray(data.registry_status) && data.registry_status.length)
    ? data.registry_status.slice(0, 6).join(', ')
    : (data.status || '-');
  return {
    registrar: registrarFromDomscanProof(data.proof),
    dates: {
      created: formatRdapDate(events.registration),
      expired: formatRdapDate(events.expiration),
      updated: formatRdapDate(events['last changed'] || events['last update of RDAP database']),
    },
    ns,
    status,
    handle: (data.proof && data.proof.handle) || '-',
  };
}

// Rantai fallback saat RDAP diblokir: WhoisJSON → combo DomScan+DoH → IP2WHOIS.
async function fallbackLookup(env, domain) {
  if (env && env.WHOISJSON_KEY) {
    const w = await whoisjsonGet(domain, env.WHOISJSON_KEY);
    if (w.code === 200 && w.data && typeof w.data.registered === 'boolean') {
      return { available: !w.data.registered, data: w.data, source: 'WHOISJSON' };
    }
  }
  if (env && env.DOMSCAN_KEY) {
    const s = await domscanStatus(domain, env.DOMSCAN_KEY);
    if (s.code === 200 && s.data && typeof s.data.available === 'boolean') {
      if (s.data.available) return { available: true, data: null, source: 'DOMSCAN' };
      const ns = await dohNameservers(domain); // NS gratis via DoH, gak lewat registry
      return { available: false, data: { ...s.data, _ns: ns }, source: 'DOMSCAN' };
    }
  }
  if (env && env.IP2WHOIS_KEY) {
    const fb = await ip2whoisGet(domain, env.IP2WHOIS_KEY);
    if (fb.code === 200 && fb.data) {
      return { available: ip2whoisIsAvailable(fb.data), data: fb.data, source: 'IP2WHOIS' };
    }
  }
  return null;
}

async function checkOneDomain(env, domain, detailed = true) {
  let { code, data, err } = await rdapGet(env, domain);
  let source = 'RDAP';

  // RDAP diblokir/di-rate-limit registry (403/451/429/5xx) → rantai fallback WhoisJSON → IP2WHOIS
  if (code === 403 || code === 451 || code === 429 || (code >= 500 && code <= 599)) {
    const fb = await fallbackLookup(env, domain);
    if (fb) {
      if (fb.available) { code = 404; data = null; }
      else { code = 200; data = fb.data; source = fb.source; }
    } else {
      err = `${err} | fallback: data tidak tersedia`;
    }
  }

  if (code === 404) {
    return detailed
      ? [`✅ **DOMAIN TERSEDIA!**\n\n🌐 Domain: \`${domain}\`\nStatus: Available\nGas checkout bang! 🚀`, false]
      : [`✅ \`${domain}\` — AVAILABLE`, false];
  }
  if (code === 400) return [`⚠️ \`${domain}\` — INVALID / BAD REQUEST`, true];
  if (code !== 200 || !data) return [`⚠️ \`${domain}\`\nRDAP error: ${err || `HTTP ${code}`}`, true];
  const x = source === 'IP2WHOIS' ? parseIp2whoisDetails(data)
    : source === 'WHOISJSON' ? parseWhoisjsonDetails(data)
    : source === 'DOMSCAN' ? parseDomscanDetails(data)
    : parseRdapDetails(data);
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

const MENU_BTN = '📋 Command';
function mainKeyboard() {
  return {
    keyboard: [[MENU_BTN]],
    resize_keyboard: true,
    input_field_placeholder: 'Ketik domain / tap Command…',
  };
}

const HELP_TEXT = [
  '🤖 **Domain Lookup Bot**',
  '━━━━━━━━━━━━━━━━━━',
  'Kirim **domain** langsung buat cek terdaftar/available (RDAP).',
  'Bisa bulk — pisah pakai spasi / enter / koma (maks 25).',
  '',
  '📋 **Perintah:**',
  '• `<domain>` — cek status domain',
  '• `/dns <domain>` — lihat record DNS (A, MX, NS, TXT, dll)',
  '• `/suggest <kata>` — saran nama domain yang masih tersedia',
  '• `/ip <alamat_ip>` — cek lokasi IP',
  '• `/myid` — lihat ID Telegram kamu',
  '• `/menu` — munculin tombol menu',
  '',
  'Contoh: `google.com`  •  `/dns google.com`  •  `/suggest kopi kekinian`',
].join('\n');

async function handleCommand(env, message, text) {
  const cmd = text.split(/\s+/, 1)[0].toLowerCase();
  if (cmd === '/start' || cmd === '/help' || cmd === '/menu') {
    return reply(env, message, withWm(HELP_TEXT), { reply_markup: mainKeyboard() });
  }
  if (cmd === '/myid') return reply(env, message, `🆔 ID kamu: \`${message.from.id}\`\n💬 Chat ID: \`${message.chat.id}\``);
  if (cmd === '/dns') {
    const arg = (text.split(/\s+/)[1] || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!arg) return reply(env, message, 'Format: `/dns <domain>`\nContoh: `/dns google.com`');
    if (!isValidDomain(arg)) return reply(env, message, '❌ Format domain salah. Contoh: `/dns google.com`');
    const status = await reply(env, message, '🔍 Ngambil record DNS...');
    const map = await dnsLookup(arg);
    const out = withWm(formatDnsResult(arg, map));
    return sendChunked(env, message.chat.id, status.message_id, out);
  }
  if (cmd === '/suggest' || cmd === '/sugest') {
    if (!env.DOMSCAN_KEY) return reply(env, message, '⚠️ Fitur saran domain belum aktif.');
    const raw = text.replace(/^\/sugg?est\s*/i, '').trim();
    if (!raw) return reply(env, message, 'Format: `/suggest <kata kunci>`\nContoh: `/suggest kopi kekinian`');
    const keywords = raw.split(/[\s,]+/).filter(Boolean).slice(0, 10).join(',');
    const status = await reply(env, message, '✨ Nyari saran domain...');
    const { ok, err, list } = await domscanSuggest(keywords, env.DOMSCAN_KEY);
    const out = withWm(ok ? formatSuggest(keywords.replace(/,/g, ', '), list) : `⚠️ Gagal ambil saran: ${err}`);
    return editMessage(env, message.chat.id, status.message_id, out).catch(() => sendMessage(env, message.chat.id, out));
  }
  if (cmd === '/ip') {
    const ip = (text.split(/\s+/)[1] || '').trim();
    if (!ip) return reply(env, message, 'Format: /ip <alamat_ip>\nContoh: `/ip 8.8.8.8`');
    if (!isValidIp(ip)) return reply(env, message, '❌ Alamat IP tidak valid. Contoh: `/ip 8.8.8.8`');
    const key = env.IP2LOCATION_KEY || env.IP2WHOIS_KEY;
    if (!key) return reply(env, message, '⚠️ Fitur IP lookup belum aktif (API key belum diset).');
    const status = await reply(env, message, '🔍 Mencari lokasi IP...');
    const { code, data, err } = await ip2locationGet(ip, key);
    const out = withWm((code === 200 && data) ? formatIpInfo(ip, data) : `⚠️ Gagal lookup IP \`${ip}\`\n${err || `HTTP ${code}`}`);
    return editMessage(env, message.chat.id, status.message_id, out).catch(() => sendMessage(env, message.chat.id, out));
  }
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
    const job = await kvGetJson(env, BC_JOB_KEY, null);
    const bc = job
      ? `\n\n📣 Broadcast jalan: ${(job.ok || 0) + (job.fail || 0)}/${job.total}\n✅ ${job.ok || 0}  ❌ ${job.fail || 0}  ⏭ sisa ${(job.queue || []).length}\nStop pakai \`/bcstop\``
      : '';
    return reply(env, message, `📊 Stats\n\n👥 Users tersimpan: ${users.length}\n👑 Admin: ${admins.length}${bc}`);
  }
  if (cmd === '/bcstop') {
    const job = await kvGetJson(env, BC_JOB_KEY, null);
    if (!job) return reply(env, message, 'Nggak ada broadcast yang jalan.');
    if (env.BOT_KV) await env.BOT_KV.delete(BC_JOB_KEY);
    return reply(env, message, `🛑 Broadcast dihentikan.\n✅ Terkirim: *${job.ok || 0}*\n❌ Gagal: *${job.fail || 0}*\n⏭ Sisa dibatalkan: *${(job.queue || []).length}*`);
  }
  if (cmd === '/bc') {
    const msg = text.replace(/^\/bc\s*/i, '').trim();
    const photo = (message.photo && message.photo.length) ? message.photo[message.photo.length - 1].file_id : null;
    const replyMsg = message.reply_to_message;
    if (!msg && !photo && !replyMsg) {
      return reply(env, message, 'Format:\n• `/bc <pesan>` — broadcast teks\n• Kirim **FOTO** + caption `/bc <pesan>` — broadcast gambar\n• **Reply** ke sebuah pesan lalu ketik `/bc` — copy pesan itu (foto/teks/video, format utuh)');
    }
    const users = await getUsers(env);
    if (!users.length) return reply(env, message, 'Belum ada user tersimpan.');
    const key = `${message.from.id}:${message.chat.id}:${message.message_id}`;
    const pending = { msg, users };
    let label = '📝 teks';
    if (photo) {
      pending.photo = photo;
      // Preserve format caption (bold/emoji): geser offset entity buang prefix "/bc " (bagian depan aja).
      const afterCmd = text.replace(/^\/bc\s*/i, '');
      const prefixLen = text.length - afterCmd.length;
      const ents = (message.caption_entities || []).map(e => ({ ...e, offset: e.offset - prefixLen })).filter(e => e.offset >= 0);
      if (ents.length) pending.entities = ents;
      label = '🖼 foto + caption';
    } else if (replyMsg && !msg) {
      pending.copyFrom = { chat_id: message.chat.id, message_id: replyMsg.message_id };
      label = '📋 copy pesan (reply)';
    }
    await kvPutJson(env, `pending:${key}`, pending);
    return reply(env, message, `📣 Konfirmasi broadcast (${label}) ke **${users.length}** chat:\n\n${(msg || '(pesan yang di-reply)').slice(0, 800)}`, {
      reply_markup: { inline_keyboard: [[
        { text: '✅ Kirim', callback_data: `bc_send|${key}` },
        { text: '❌ Batal', callback_data: `bc_cancel|${key}` },
      ]] },
    });
  }
}

// ── Broadcast bertahap ─────────────────────────────────────────────────────
// Worker free plan cuma boleh ~50 subrequest per invocation, jadi broadcast ke
// banyak chat nggak aman dikirim sekali jalan (mentok di tengah, dan sisanya
// dulu malah kehapus dari daftar user). Sekarang dipecah per batch: batch
// pertama jalan langsung pas tombol Kirim ditekan, sisanya digilir cron.
const BC_BATCH = 30;
const BC_JOB_KEY = 'bc:job';

// Error yang artinya chat-nya beneran mati (user blokir bot / akun dihapus),
// bukan error sementara (flood limit, 5xx, jaringan). Cuma yang beginian yang
// boleh dicopot dari daftar user.
function isDeadRecipientError(err) {
  const st = Number(err && err.status) || 0;
  const msg = String((err && err.message) || err || '');
  if (st && st !== 400 && st !== 403) return false;
  return /bot was blocked|blocked by the user|user is deactivated|user is deleted|chat not found|bot was kicked|PEER_ID_INVALID/i.test(msg);
}

// Kirim satu pesan broadcast sesuai jenis job: teks, foto+caption, atau copy pesan.
async function sendBroadcastTo(env, cid, job) {
  if (job.photo) {
    return tg(env, 'sendPhoto', {
      chat_id: cid,
      photo: job.photo,
      caption: job.msg || undefined,
      caption_entities: (job.entities && job.entities.length) ? job.entities : undefined,
    });
  }
  if (job.copyFrom) {
    return tg(env, 'copyMessage', { chat_id: cid, from_chat_id: job.copyFrom.chat_id, message_id: job.copyFrom.message_id });
  }
  return sendMessage(env, cid, job.msg, { parse_mode: undefined });
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Kirim satu batch job yang lagi jalan. Dipanggil dari tombol "Kirim" (batch
// pertama, biar broadcast kecil kelar instan) & dari cron tiap ~2 menit.
async function runBroadcastBatch(env) {
  const job = await kvGetJson(env, BC_JOB_KEY, null);
  if (!job || !Array.isArray(job.queue)) return;
  const batch = job.queue.slice(0, BC_BATCH);
  const rest = job.queue.slice(BC_BATCH);
  if (!batch.length) {
    if (env.BOT_KV) await env.BOT_KV.delete(BC_JOB_KEY);
    return finishBroadcast(env, job);
  }
  // Klaim batch DULU (tulis sisa queue sebelum ngirim) biar cron berikutnya
  // nggak ngirim ulang batch yang sama.
  await kvPutJson(env, BC_JOB_KEY, { ...job, queue: rest });
  let ok = 0, fail = 0, retryBudget = 6;
  const dead = [];
  for (const cid of batch) {
    let retried = false;
    for (;;) {
      try { await sendBroadcastTo(env, cid, job); ok++; break; }
      catch (err) {
        // Kena flood limit → tunggu sesuai saran Telegram, coba sekali lagi.
        const ra = Number(err && err.retryAfter) || 0;
        if (ra > 0 && ra <= 8 && !retried && retryBudget > 0) { retried = true; retryBudget--; await sleep((ra + 1) * 1000); continue; }
        fail++;
        if (isDeadRecipientError(err)) dead.push(Number(cid));
        break;
      }
    }
    await sleep(40); // ~25 pesan/detik, di bawah batas Telegram (30/detik)
  }
  const state = {
    ...job,
    queue: rest,
    ok: (job.ok || 0) + ok,
    fail: (job.fail || 0) + fail,
    dead: [...(job.dead || []), ...dead],
  };
  if (rest.length) {
    await kvPutJson(env, BC_JOB_KEY, state);
    await editMessage(env, job.admin, job.msgId, [
      `📣 *Broadcast jalan...* ${state.ok + state.fail}/${job.total}`,
      `✅ Terkirim: *${state.ok}*${state.fail ? `   ❌ Gagal: *${state.fail}*` : ''}`,
      '',
      `_Sisa ${rest.length} chat digilir otomatis tiap ~2 menit._`,
    ].join('\n')).catch(() => {});
    return;
  }
  if (env.BOT_KV) await env.BOT_KV.delete(BC_JOB_KEY);
  return finishBroadcast(env, state);
}

// Laporan akhir + bersihin chat yang mati.
async function finishBroadcast(env, state) {
  const deadSet = new Set((state.dead || []).map(Number));
  let removed = 0;
  if (deadSet.size) {
    const users = await getUsers(env);
    const keep = users.filter(u => !deadSet.has(Number(u)));
    removed = users.length - keep.length;
    if (removed) { await putUsers(env, keep); await sendBackup(env, 'remove_user'); }
  }
  const ok = state.ok || 0, fail = state.fail || 0;
  const out = [
    '📢 *Broadcast selesai.*',
    `✅ Terkirim: *${ok}*`,
    fail ? `❌ Gagal: *${fail}*` : '',
    deadSet.size ? `🚫 Blokir bot: *${deadSet.size}*` : '',
    removed ? `🧹 Chat mati dihapus: *${removed}*` : '',
    `👥 Target: *${state.total || ok + fail}*  ·  ⏱ ${fmtDur(Date.now() - (state.startedAt || Date.now()))}`,
  ].filter(Boolean).join('\n');
  await editMessage(env, state.admin, state.msgId, out)
    .catch(() => sendMessage(env, state.admin, out).catch(() => {}));
}

async function handleCallback(env, call, ctx) {
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
  const running = await kvGetJson(env, BC_JOB_KEY, null);
  if (running) return answerCallback(env, call.id, '⚠️ Masih ada broadcast jalan, tunggu kelar dulu.');
  // Hapus pending duluan → kalau webhook Telegram ke-retry, nggak dobel kirim.
  if (env.BOT_KV) await env.BOT_KV.delete(pendingKey);
  const queue = (data.users || []).map(Number).filter(Number.isFinite);
  await editMessage(env, call.message.chat.id, call.message.message_id, `📣 Mengirim broadcast ke ${queue.length} chat...`).catch(() => {});
  await kvPutJson(env, BC_JOB_KEY, {
    admin: call.message.chat.id,
    msgId: call.message.message_id,
    msg: data.msg,
    photo: data.photo,
    entities: data.entities,
    copyFrom: data.copyFrom,
    queue,
    total: queue.length,
    ok: 0, fail: 0, dead: [],
    startedAt: Date.now(),
  });
  await answerCallback(env, call.id, 'Broadcast dimulai 🚀');
  // Batch pertama langsung jalan biar broadcast kecil kelar instan.
  if (ctx) ctx.waitUntil(runBroadcastBatch(env));
  else await runBroadcastBatch(env);
  return;
}

async function handleMessage(env, message) {
  const text = String(message.text || '').trim();
  const caption = String(message.caption || '').trim();
  await registerUser(env, message.chat.id);
  if (message.document) {
    const restored = await handleRestoreDocument(env, message);
    if (restored) return restored;
  }
  // Command bisa dari teks biasa ATAU caption (mis. foto + "/bc ...").
  const cmdSource = text.startsWith('/') ? text : (caption.startsWith('/') ? caption : '');
  if (cmdSource) return handleCommand(env, message, cmdSource);
  if (!text) return;
  // Tombol menu "📋 Command" → tampilin daftar perintah.
  if (text === MENU_BTN) return reply(env, message, withWm(HELP_TEXT), { reply_markup: mainKeyboard() });
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
    const [out] = await checkOneDomain(env, d, true);
    const msg = withWm(out);
    return editMessage(env, message.chat.id, status.message_id, msg).catch(() => sendMessage(env, message.chat.id, msg));
  }
  const status = await reply(env, message, `🔍 Memproses **${domains.length}** domain via RDAP...`);
  const results = [];
  let errc = 0;
  for (let i = 0; i < domains.length; i++) {
    const d = domains[i];
    if (!isValidDomain(d)) { results.push(`⚠️ \`${d}\` — INVALID FORMAT`); errc++; continue; }
    if (i === 0 || (i + 1) % 4 === 0 || i === domains.length - 1) await editMessage(env, message.chat.id, status.message_id, `🔍 Memproses ${i + 1}/${domains.length} ...`).catch(() => {});
    const [line, isErr] = await checkOneDomain(env, d, false);
    if (isErr) errc++;
    results.push(line);
    await sleep(250);
  }
  let body = `✅ **Selesai** — Total: **${domains.length}** | Error: **${errc}**\n\n` + results.join('\n\n');
  if (body.length > 3800) body = body.slice(0, 3700) + '\n\n…(dipotong limit Telegram)';
  const finalText = withWm(body);
  return editMessage(env, message.chat.id, status.message_id, finalText).catch(() => sendMessage(env, message.chat.id, finalText));
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') return new Response('domain_lookup worker OK');
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    if (!env.BOT_TOKEN) return new Response('Missing BOT_TOKEN', { status: 500 });
    const update = await request.json().catch(() => null);
    if (!update) return new Response('Bad Request', { status: 400 });
    try {
      if (update.callback_query) await handleCallback(env, update.callback_query, ctx);
      else if (update.message) await handleMessage(env, update.message);
    } catch (e) {
      console.error(e);
    }
    return new Response('OK');
  },

  // Cron: gilir sisa batch broadcast. Kalau nggak ada job jalan, cuma 1 KV read
  // terus balik (nol write, jadi aman buat kuota KV free tier).
  async scheduled(event, env, ctx) {
    try { await runBroadcastBatch(env); } catch (e) { console.error(e); }
  },
};
