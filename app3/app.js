const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const querystring = require('querystring');
const { AsyncLocalStorage } = require('async_hooks');
const { execFileSync } = require('child_process');
const QRCode = require('qrcode');

const ROOT = __dirname;
const WORK_DIR = process.env.WORK_DIR ? path.resolve(process.env.WORK_DIR) : path.join(ROOT, 'work');
const STATE_FILE = process.env.STATE_FILE ? path.resolve(process.env.STATE_FILE) : path.join(WORK_DIR, 'state.json');
const UPLOAD_DIR = path.join(WORK_DIR, 'uploads');
const TEMP_DIR = path.join(WORK_DIR, 'tmp');
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32'
  ? 'C:\\Users\\EDY\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe'
  : 'python3');
const ROSTER_PARSER_FILE = path.join(ROOT, 'tools', 'parse_roster_file.py');
const PORT = Number(process.env.PORT || 3000);
const COOKIE_PREFIX = 'checkin_participant';
const FEISHU_CONFIG_FILE = path.join(WORK_DIR, 'feishu.local.json');
const PUBLIC_BASE_URL_CONFIG = String(process.env.PUBLIC_BASE_URL || '').trim();
const requestContext = new AsyncLocalStorage();

function normalizeBasePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const pathname = raw.startsWith('http://') || raw.startsWith('https://')
      ? new URL(raw).pathname
      : new URL(`http://localhost${raw.startsWith('/') ? raw : `/${raw}`}`).pathname;
    return pathname.replace(/\/+$/, '') || '';
  } catch {
    return '';
  }
}

const PUBLIC_BASE_PATH = normalizeBasePath(
  process.env.PUBLIC_BASE_PATH || PUBLIC_BASE_URL_CONFIG
);

function loadFeishuLocalConfig() {
  try {
    if (!fs.existsSync(FEISHU_CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(FEISHU_CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const FEISHU_LOCAL_CONFIG = loadFeishuLocalConfig();
const FEISHU_APP_ID = String(process.env.FEISHU_APP_ID || FEISHU_LOCAL_CONFIG.appId || '').trim();
const FEISHU_APP_SECRET = String(process.env.FEISHU_APP_SECRET || FEISHU_LOCAL_CONFIG.appSecret || '').trim();
const FEISHU_ENABLED = Boolean(FEISHU_APP_ID && FEISHU_APP_SECRET);

const pendingFeishuProfiles = new Map();

function ensureStateDir() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function nowText() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function normalizeName(name) {
  return String(name || '')
    .replace(/\u3000/g, ' ')
    .trim()
    .replace(/\s+/g, '');
}

function normalizeRosterMatchName(name) {
  return normalizeName(name).replace(/\d+$/, '');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function splitLine(line) {
  const result = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && (ch === ',' || ch === '\t' || ch === '|')) {
      result.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  result.push(current.trim());
  return result.filter((value, index) => index > 0 || value.length > 0);
}

function parseRows(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(splitLine);
}

function decodeTextFileBuffer(buffer) {
  if (!buffer || !buffer.length) return '';
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString('utf8');
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le');
  }

  const utf8Text = buffer.toString('utf8');
  if (!utf8Text.includes('\uFFFD')) return utf8Text;

  try {
    return new TextDecoder('gb18030').decode(buffer);
  } catch {
    return utf8Text;
  }
}

function cleanupTempFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore temp cleanup failures.
  }
}

function extractRosterTextFromFile(file) {
  if (!file?.buffer?.length) {
    return { text: '', error: '空文件' };
  }

  const originalName = safeFileName(file.fileName || 'roster-file');
  const ext = fileExt(originalName);
  const tempName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext || '.bin'}`;
  const tempPath = path.join(TEMP_DIR, tempName);

  try {
    ensureStateDir();
    fs.writeFileSync(tempPath, file.buffer);

    const stdout = execFileSync(PYTHON_BIN, [ROSTER_PARSER_FILE, tempPath], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    const parsed = JSON.parse(stdout || '{}');
    if (parsed && typeof parsed.text === 'string') {
      return {
        text: parsed.text,
        error: parsed.error ? String(parsed.error) : '',
      };
    }
  } catch (error) {
    const fallbackText = decodeTextFileBuffer(file.buffer);
    if (fallbackText.trim()) {
      return { text: fallbackText, error: '' };
    }
    return {
      text: '',
      error: String(error?.message || '未识别出可用内容'),
    };
  } finally {
    cleanupTempFile(tempPath);
  }

  return { text: '', error: '未识别出可用内容' };
}

function safeFileName(name) {
  const base = path.basename(String(name || 'file'));
  return base.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
}

function fileExt(name) {
  return path.extname(String(name || '')).toLowerCase();
}

function isImageFile(fileName, mimeType = '') {
  return mimeType.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(fileExt(fileName));
}

function renderPrizeAsset(prize, compact = false) {
  const imageUrl = prize.imageUrl || '';
  const fileUrl = prize.fileUrl || '';
  const fileName = prize.fileName || prize.name || '濂栧搧鏂囦欢';
  if (imageUrl) {
    return compact
      ? `<img class="prize-thumb" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(prize.name)}" />`
      : `<img class="prize-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(prize.name)}" />`;
  }
  if (fileUrl) {
    return `<a class="prize-link" href="${escapeHtml(fileUrl)}" target="_blank">${escapeHtml(fileName)}</a>`;
  }
  return '';
}

function parseMultipartFormData(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) return { fields: {}, files: [] };
  const boundary = `--${match[1] || match[2]}`;
  const raw = buffer.toString('binary');
  const parts = raw.split(boundary).slice(1, -1);
  const fields = {};
  const files = [];

  for (const part of parts) {
    const normalized = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const headerEnd = normalized.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headerText = normalized.slice(0, headerEnd);
    let bodyBinary = normalized.slice(headerEnd + 4);
    if (bodyBinary.endsWith('\r\n')) {
      bodyBinary = bodyBinary.slice(0, -2);
    }

    const headers = headerText.split('\r\n');
    const disposition = headers.find((line) => /^content-disposition:/i.test(line)) || '';
    const nameMatch = /name="([^"]+)"/i.exec(disposition);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];
    const fileMatch = /filename="([^"]*)"/i.exec(disposition);
    const typeLine = headers.find((line) => /^content-type:/i.test(line)) || '';
    const mimeType = typeLine.split(':').slice(1).join(':').trim();

    if (fileMatch && fileMatch[1]) {
      files.push({
        fieldName,
        fileName: fileMatch[1],
        mimeType,
        buffer: Buffer.from(bodyBinary, 'binary'),
      });
    } else {
      fields[fieldName] = Buffer.from(bodyBinary, 'binary').toString('utf8');
    }
  }

  return { fields, files };
}

function saveUploadedPrizeFiles(event, files, defaultQuantity, defaultDescription, prizeNamesText = '') {
  ensureStateDir();
  const quantity = Math.max(1, Number(defaultQuantity) || 1);
  const prizeNames = String(prizeNamesText || '')
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  let count = 0;

  for (const file of files) {
    if (!file?.buffer?.length) continue;
    const originalName = safeFileName(file.fileName || 'prize');
    const storedName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${originalName}`;
    const targetPath = path.join(UPLOAD_DIR, storedName);
    fs.writeFileSync(targetPath, file.buffer);

    const publicUrl = appPath(`/uploads/${encodeURIComponent(storedName)}`);
    const prize = normalizePrize({
      id: crypto.randomUUID(),
      // The uploaded file is an attachment only; prize names are always controlled by the organizer.
      name: prizeNames[count] || `奖品 ${event.prizes.length + count + 1}`,
      imageUrl: isImageFile(originalName, file.mimeType) ? publicUrl : '',
      fileUrl: publicUrl,
      fileName: originalName,
      mimeType: file.mimeType,
      quantity,
      remaining: quantity,
      description: String(defaultDescription || '').trim(),
    });

    event.prizes.push(prize);
    count++;
  }

  return count;
}

let cachedFeishuAppToken = '';
let cachedFeishuAppTokenExpireAt = 0;

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.msg || data?.message || response.statusText || 'request failed';
    throw new Error(message);
  }
  return data;
}

async function getFeishuAppAccessToken() {
  if (!FEISHU_ENABLED) throw new Error('飞书未配置');
  if (cachedFeishuAppToken && Date.now() < cachedFeishuAppTokenExpireAt - 60_000) {
    return cachedFeishuAppToken;
  }
  const data = await fetchJson('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET,
    }),
  });
  cachedFeishuAppToken = data.app_access_token || '';
  cachedFeishuAppTokenExpireAt = Date.now() + Number(data.expire || 7200) * 1000;
  return cachedFeishuAppToken;
}

async function exchangeFeishuAuthCode(code) {
  const appToken = await getFeishuAppAccessToken();
  return fetchJson('https://open.feishu.cn/open-apis/authen/v1/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${appToken}`,
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
    }),
  });
}

async function fetchFeishuUserInfo(userAccessToken) {
  return fetchJson('https://open.feishu.cn/open-apis/authen/v1/user_info', {
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
    },
  });
}

function normalizeFeishuProfile(data) {
  const info = data?.data || data || {};
  return {
    name: String(info.name || info.user_name || info.en_name || '').trim(),
    openId: String(info.open_id || info.openId || '').trim(),
    unionId: String(info.union_id || info.unionId || '').trim(),
    userId: String(info.user_id || info.userId || '').trim(),
    email: String(info.email || '').trim(),
    avatarUrl: String(info.avatar_url || info.avatarUrl || '').trim(),
    department: String(info.department || info.department_name || '').trim(),
    employeeType: String(info.employee_type || info.employeeType || '').trim(),
  };
}

function slugify(text) {
  const ascii = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii || 'training';
}

function defaultConfig(title = '公司培训签到抽奖') {
  return {
    title,
    subtitle: '扫码签到后自动进入抽奖池，开奖结果由后台统一控制。',
    successText: '签到成功',
    pendingText: '待开奖，请留意现场通知。',
    winText: '恭喜你抽中了奖品',
    noWinText: '本次开奖未抽中，感谢参与。',
    footerText: '请保持页面开启，开奖后会自动刷新结果。',
  };
}

function normalizePrize(prize) {
  const quantity = Math.max(0, Number(prize?.quantity) || 0);
  const remaining = Math.max(0, Number(prize?.remaining ?? quantity) || 0);
  return {
    id: prize?.id || crypto.randomUUID(),
    name: String(prize?.name || '').trim(),
    imageUrl: String(prize?.imageUrl || '').trim(),
    fileUrl: String(prize?.fileUrl || '').trim(),
    fileName: String(prize?.fileName || '').trim(),
    mimeType: String(prize?.mimeType || '').trim(),
    quantity,
    remaining,
    description: String(prize?.description || '').trim(),
  };
}

function normalizeCheckin(item) {
  const drawResult = item?.drawResult === 'won' || item?.drawResult === 'not_won' ? item.drawResult : 'pending';
  return {
    id: item?.id || crypto.randomUUID(),
    name: String(item?.name || '').trim(),
    department: String(item?.department || '未匹配').trim() || '未匹配',
    employeeType: String(item?.employeeType || '未匹配').trim() || '未匹配',
    matched: Boolean(item?.matched),
    checkedInAt: String(item?.checkedInAt || nowText()),
    source: String(item?.source || 'single'),
    drawResult,
    drawId: item?.drawId || null,
    prizeId: item?.prizeId || null,
    prizeName: String(item?.prizeName || '').trim(),
    prizeImageUrl: String(item?.prizeImageUrl || '').trim(),
    prizeFileUrl: String(item?.prizeFileUrl || '').trim(),
    prizeFileName: String(item?.prizeFileName || '').trim(),
    prizeDescription: String(item?.prizeDescription || '').trim(),
    feishuOpenId: String(item?.feishuOpenId || '').trim(),
    feishuUnionId: String(item?.feishuUnionId || '').trim(),
    feishuUserId: String(item?.feishuUserId || '').trim(),
    identitySource: String(item?.identitySource || 'manual').trim(),
  };
}

function normalizeDraw(draw) {
  return {
    id: draw?.id || crypto.randomUUID(),
    drawnAt: String(draw?.drawnAt || nowText()),
    winnerCount: Math.max(0, Number(draw?.winnerCount) || 0),
    winners: Array.isArray(draw?.winners) ? draw.winners.map((item) => ({
      id: item?.id || crypto.randomUUID(),
      name: String(item?.name || '').trim(),
      prizeName: String(item?.prizeName || '').trim(),
    })) : [],
  };
}

function makeEvent(raw = {}) {
  const title = String(raw?.config?.title || raw?.title || '培训活动').trim() || '培训活动';
  return {
    id: raw?.id || crypto.randomUUID(),
    slug: String(raw?.slug || '').trim() || slugify(title),
    createdAt: String(raw?.createdAt || nowText()),
    config: {
      ...defaultConfig(title),
      ...(raw?.config || {}),
      title: String(raw?.config?.title || title).trim() || title,
    },
    roster: Array.isArray(raw?.roster) ? raw.roster.map((item) => ({
      name: String(item?.name || '').trim(),
      department: String(item?.department || '').trim(),
      employeeType: String(item?.employeeType || '').trim(),
    })) : [],
    checkins: Array.isArray(raw?.checkins) ? raw.checkins.map(normalizeCheckin) : [],
    prizes: Array.isArray(raw?.prizes) ? raw.prizes.map(normalizePrize) : [],
    draws: Array.isArray(raw?.draws) ? raw.draws.map(normalizeDraw) : [],
  };
}

function createEmptyState() {
  return {
    version: 2,
    activeEventId: '',
    events: [],
  };
}

function uniqueSlug(state, title) {
  const base = slugify(title);
  const existing = new Set((state.events || []).map((event) => event.slug));
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base}-${index}`)) {
    index++;
  }
  return `${base}-${index}`;
}

function createEvent(state, title = '新培训活动') {
  const event = makeEvent({
    id: crypto.randomUUID(),
    slug: uniqueSlug(state, title),
    createdAt: nowText(),
    config: defaultConfig(title),
  });
  state.events.push(event);
  state.activeEventId = event.id;
  return event;
}

function ensureStateShape(state) {
  if (!Array.isArray(state.events)) state.events = [];
  if (!state.events.length) {
    createEvent(state, '默认培训活动');
  }
  if (!state.events.some((event) => event.id === state.activeEventId)) {
    state.activeEventId = state.events[0].id;
  }
  state.version = 2;
  return state;
}

function mergeStateShape(parsed) {
  if (parsed && Array.isArray(parsed.events)) {
    const state = createEmptyState();
    state.events = parsed.events.map(makeEvent);
    state.activeEventId = parsed.activeEventId;
    return ensureStateShape(state);
  }

  if (parsed && (parsed.config || parsed.roster || parsed.checkins || parsed.prizes || parsed.draws)) {
    const state = createEmptyState();
    const legacyTitle = String(parsed?.config?.title || '历史培训活动').trim() || '历史培训活动';
    state.events = [
      makeEvent({
        id: crypto.randomUUID(),
        slug: 'legacy-activity',
        createdAt: nowText(),
        config: { ...defaultConfig(legacyTitle), ...(parsed.config || {}) },
        roster: parsed.roster || [],
        checkins: parsed.checkins || [],
        prizes: parsed.prizes || [],
        draws: parsed.draws || [],
      }),
    ];
    state.activeEventId = state.events[0].id;
    return ensureStateShape(state);
  }

  return ensureStateShape(createEmptyState());
}

function loadState() {
  ensureStateDir();
  if (!fs.existsSync(STATE_FILE)) return ensureStateShape(createEmptyState());
  try {
    return mergeStateShape(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch {
    return ensureStateShape(createEmptyState());
  }
}

function saveState(state) {
  ensureStateDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(ensureStateShape(state), null, 2), 'utf8');
}

function getEventById(state, eventId) {
  return (state.events || []).find((event) => event.id === eventId) || null;
}

function getCurrentEvent(state, preferredEventId) {
  return getEventById(state, preferredEventId) || getEventById(state, state.activeEventId) || state.events[0];
}

function resolveEventId(url, body, state) {
  return String(body?.eventId || url.searchParams.get('event') || state.activeEventId || '').trim();
}

function eventQuery(pathValue, eventId) {
  const sep = pathValue.includes('?') ? '&' : '?';
  return `${currentBasePath()}${pathValue}${sep}event=${encodeURIComponent(eventId)}`;
}

function eventCookieName(event) {
  return `${COOKIE_PREFIX}_${event.slug}`;
}

function pendingFeishuCookieName(event) {
  return `feishu_pending_${event.slug}`;
}

function rosterMap(event) {
  const map = new Map();
  for (const item of event.roster) {
    const key = normalizeName(item.name);
    if (!key) continue;
    const list = map.get(key) || [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}

function matchRoster(event, name) {
  const exactKey = normalizeName(name);
  const exactList = rosterMap(event).get(exactKey) || [];
  if (exactList.length === 1) {
    return {
      matched: true,
      department: exactList[0].department,
      employeeType: exactList[0].employeeType,
    };
  }

  const baseKey = normalizeRosterMatchName(name);
  const baseList = event.roster.filter((item) => normalizeRosterMatchName(item.name) === baseKey);
  if (baseList.length === 1) {
    return {
      matched: true,
      department: baseList[0].department,
      employeeType: baseList[0].employeeType,
    };
  }
  if (exactList.length > 1 || baseList.length > 1) {
    return {
      matched: false,
      department: '同名待确认',
      employeeType: '同名待确认',
    };
  }
  return {
    matched: false,
    department: '未匹配',
    employeeType: '未匹配',
  };
}

function enrichFeishuProfile(event, profile) {
  const name = String(profile?.name || '').trim();
  const normalizedBase = normalizeRosterMatchName(name);
  const candidates = event.roster.filter((item) => normalizeRosterMatchName(item.name) === normalizedBase);
  const profileDepartment = normalizeName(profile?.department || '');
  const departmentMatches = profileDepartment
    ? candidates.filter((item) => normalizeName(item.department) === profileDepartment)
    : [];
  const matchedRoster = departmentMatches.length === 1
    ? departmentMatches[0]
    : candidates.length === 1
      ? candidates[0]
      : null;

  return {
    ...profile,
    department: matchedRoster?.department || profile.department || (candidates.length > 1 ? '同名待确认' : '未匹配'),
    employeeType: matchedRoster?.employeeType || profile.employeeType || (candidates.length > 1 ? '同名待确认' : '未匹配'),
    rosterMatched: Boolean(matchedRoster),
  };
}

function addRosterFromText(event, text) {
  const rows = parseRows(text);
  const existing = new Set(event.roster.map((item) => normalizeName(item.name)));
  let count = 0;

  for (const row of rows) {
    if (row.length < 2) continue;
    const [name, department, employeeType] = row;
    const normalized = normalizeName(name);
    const combined = row.join('');
    if (!normalized || combined.includes('姓名') || combined.includes('部门')) continue;

    const nextItem = {
      name: name.trim(),
      department: (department || '未提供').trim() || '未提供',
      employeeType: (employeeType || '未提供').trim() || '未提供',
    };

    if (!existing.has(normalized)) {
      event.roster.push(nextItem);
      existing.add(normalized);
      count++;
    } else {
      const index = event.roster.findIndex((item) => normalizeName(item.name) === normalized);
      if (index >= 0) event.roster[index] = nextItem;
    }
  }

  return count;
}

function addRosterFromFiles(event, files) {
  let count = 0;
  const unreadable = [];

  for (const file of files) {
    const result = extractRosterTextFromFile(file);
    if (!result.text.trim()) {
      unreadable.push(result.error ? `${file.fileName}（${result.error}）` : file.fileName);
      continue;
    }
    count += addRosterFromText(event, result.text);
  }

  return { count, unreadable };
}

function refreshCheckinMatches(event) {
  let updated = 0;
  for (const checkin of event.checkins) {
    const match = matchRoster(event, checkin.name);
    if (!match.matched) continue;
    const beforeDepartment = checkin.department;
    const beforeEmployeeType = checkin.employeeType;
    checkin.department = match.department;
    checkin.employeeType = match.employeeType;
    checkin.matched = true;
    if (checkin.department !== beforeDepartment || checkin.employeeType !== beforeEmployeeType) {
      updated++;
    }
  }
  return updated;
}

function replacePrizesFromText(event, text) {
  const rows = parseRows(text);
  const nextPrizes = [];

  for (const row of rows) {
    if (row.length < 3) continue;
    const [name, imageUrl, quantity, description] = row;
    if (!name || name.includes('濂栧搧')) continue;
    const total = Math.max(0, Number(quantity) || 0);
    if (!total) continue;
    nextPrizes.push(normalizePrize({
      id: crypto.randomUUID(),
      name: name.trim(),
      imageUrl: (imageUrl || '').trim(),
      quantity: total,
      remaining: total,
      description: (description || '').trim(),
    }));
  }

  event.prizes = nextPrizes;
  return nextPrizes.length;
}

function deletePrize(event, prizeId) {
  const index = event.prizes.findIndex((prize) => prize.id === prizeId);
  if (index < 0) return { ok: false, message: '没有找到要删除的奖品。' };

  const [prize] = event.prizes.splice(index, 1);
  return { ok: true, name: prize.name };
}

function updateConfig(event, body) {
  event.config = {
    ...event.config,
    title: String(body.title || '').trim() || defaultConfig().title,
    subtitle: String(body.subtitle || '').trim() || defaultConfig().subtitle,
    successText: String(body.successText || '').trim() || defaultConfig().successText,
    pendingText: String(body.pendingText || '').trim() || defaultConfig().pendingText,
    winText: String(body.winText || '').trim() || defaultConfig().winText,
    noWinText: String(body.noWinText || '').trim() || defaultConfig().noWinText,
    footerText: String(body.footerText || '').trim() || defaultConfig().footerText,
  };
}

function clearEventData(event) {
  event.roster = [];
  event.checkins = [];
  event.prizes = [];
  event.draws = [];
}

function deleteEvent(state, eventId) {
  if ((state.events || []).length <= 1) {
    return { ok: false, message: '至少保留一场活动，不能全部删除。' };
  }

  const index = state.events.findIndex((event) => event.id === eventId);
  if (index < 0) {
    return { ok: false, message: '没有找到要删除的活动。' };
  }

  const [removed] = state.events.splice(index, 1);
  const nextActive = state.events[Math.max(0, index - 1)] || state.events[0] || null;
  state.activeEventId = nextActive ? nextActive.id : '';
  return { ok: true, removed, nextActive };
}

function findCheckinByName(event, name) {
  const key = normalizeName(name);
  return event.checkins.find((item) => normalizeName(item.name) === key) || null;
}

function findCheckinByFeishuIdentity(event, profile) {
  return event.checkins.find((item) => {
    if (profile.userId && item.feishuUserId === profile.userId) return true;
    if (profile.openId && item.feishuOpenId === profile.openId) return true;
    if (profile.unionId && item.feishuUnionId === profile.unionId) return true;
    return false;
  }) || null;
}

function findCheckinById(event, id) {
  return event.checkins.find((item) => item.id === id) || null;
}

function registerCheckin(event, name, source = 'single', checkedInAt = nowText()) {
  const normalized = normalizeName(name);
  if (!normalized) return { ok: false, message: '濮撳悕涓嶈兘涓虹┖' };

  const existing = findCheckinByName(event, normalized);
  if (existing) return { ok: true, already: true, record: existing };

  const match = matchRoster(event, name);
  const record = normalizeCheckin({
    id: crypto.randomUUID(),
    name: String(name).trim(),
    department: match.department,
    employeeType: match.employeeType,
    matched: match.matched,
    checkedInAt,
    source,
    drawResult: 'pending',
  });

  event.checkins.push(record);
  return { ok: true, already: false, record };
}

function registerCheckinByProfile(event, profile, source = 'feishu', checkedInAt = nowText()) {
  const name = String(profile?.name || '').trim();
  if (!name) return { ok: false, message: '飞书账号未返回姓名' };

  const existingByIdentity = findCheckinByFeishuIdentity(event, profile);
  if (existingByIdentity) return { ok: true, already: true, record: existingByIdentity };

  const sameNameRecords = event.checkins.filter((item) => normalizeRosterMatchName(item.name) === normalizeRosterMatchName(name));
  const mergeCandidate = sameNameRecords.length === 1 &&
    !sameNameRecords[0].feishuOpenId &&
    !sameNameRecords[0].feishuUnionId &&
    !sameNameRecords[0].feishuUserId
      ? sameNameRecords[0]
      : null;

  const match = matchRoster(event, name);
  const resolvedDepartment = match.matched ? match.department : (profile.department || match.department || '未匹配');
  const resolvedEmployeeType = match.matched ? match.employeeType : (profile.employeeType || match.employeeType || '未匹配');

  if (mergeCandidate) {
    mergeCandidate.name = name;
    mergeCandidate.department = resolvedDepartment;
    mergeCandidate.employeeType = resolvedEmployeeType;
    mergeCandidate.matched = match.matched;
    mergeCandidate.source = source;
    mergeCandidate.feishuOpenId = profile.openId;
    mergeCandidate.feishuUnionId = profile.unionId;
    mergeCandidate.feishuUserId = profile.userId;
    mergeCandidate.identitySource = 'feishu';
    return { ok: true, already: true, record: mergeCandidate };
  }

  const record = normalizeCheckin({
    id: crypto.randomUUID(),
    name,
    department: resolvedDepartment,
    employeeType: resolvedEmployeeType,
    matched: match.matched,
    checkedInAt,
    source,
    drawResult: 'pending',
    feishuOpenId: profile.openId,
    feishuUnionId: profile.unionId,
    feishuUserId: profile.userId,
    identitySource: 'feishu',
  });

  event.checkins.push(record);
  return { ok: true, already: false, record };
}

function availablePrizeUnits(event) {
  const units = [];
  for (const prize of event.prizes) {
    const remaining = Math.max(0, Number(prize.remaining) || 0);
    for (let i = 0; i < remaining; i++) {
      units.push(prize);
    }
  }
  return units;
}

function drawWinners(event, requestedCount) {
  const candidates = event.checkins.filter((item) => item.drawResult === 'pending');
  const prizeUnits = availablePrizeUnits(event);
  const count = Math.max(0, Math.min(Number(requestedCount) || 0, candidates.length, prizeUnits.length));
  const drawId = crypto.randomUUID();

  const selected = candidates
    .map((item) => ({ item, sort: crypto.randomBytes(16).toString('hex') }))
    .sort((a, b) => a.sort.localeCompare(b.sort))
    .slice(0, count)
    .map((entry) => entry.item);

  const winners = [];
  for (let i = 0; i < selected.length; i++) {
    const winner = selected[i];
    const prize = prizeUnits[i];
    winner.drawResult = 'won';
    winner.drawId = drawId;
    winner.prizeId = prize.id;
    winner.prizeName = prize.name;
    winner.prizeImageUrl = prize.imageUrl;
    winner.prizeFileUrl = prize.fileUrl;
    winner.prizeFileName = prize.fileName;
    winner.prizeDescription = prize.description;
    prize.remaining = Math.max(0, prize.remaining - 1);
    winners.push(winner);
  }

  if (availablePrizeUnits(event).length === 0) {
    for (const item of event.checkins) {
      if (item.drawResult === 'pending') {
        item.drawResult = 'not_won';
        item.drawId = drawId;
      }
    }
  }

  const draw = normalizeDraw({
    id: drawId,
    drawnAt: nowText(),
    winnerCount: winners.length,
    winners: winners.map((item) => ({
      id: item.id,
      name: item.name,
      prizeName: item.prizeName,
    })),
  });

  event.draws.push(draw);
  return { draw, winners };
}

function exportSigninsCsv(event) {
  const rows = [
    ['姓名', '部门', '员工类型', '签到时间'],
    ...event.checkins.map((item) => [
      item.name,
      item.department || '未匹配',
      item.employeeType || '未匹配',
      item.checkedInAt,
    ]),
  ];
  return '\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

function exportLotteryCsv(event) {
  const rows = [
    ['姓名', '部门', '员工类型', '签到时间', '开奖状态', '奖品名称'],
    ...event.checkins.map((item) => [
      item.name,
      item.department || '未匹配',
      item.employeeType || '未匹配',
      item.checkedInAt,
      item.drawResult === 'won' ? '已中奖' : item.drawResult === 'not_won' ? '未中奖' : '待开奖',
      item.prizeName || '',
    ]),
  ];
  return '\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readRequestBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseRequestBody(raw, contentType = '') {
  if (!raw) return {};
  if (contentType.includes('application/json')) return JSON.parse(raw);
  if (contentType.includes('application/x-www-form-urlencoded')) return querystring.parse(raw);
  try {
    return JSON.parse(raw);
  } catch {
    return querystring.parse(raw);
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const result = {};
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (!key) continue;
    result[key] = decodeURIComponent(rest.join('=') || '');
  }
  return result;
}

function setCookie(headers, name, value) {
  const next = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
  if (headers['Set-Cookie']) {
    headers['Set-Cookie'] = [].concat(headers['Set-Cookie'], next);
  } else {
    headers['Set-Cookie'] = next;
  }
}

function clearCookie(headers, name) {
  const next = `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  if (headers['Set-Cookie']) {
    headers['Set-Cookie'] = [].concat(headers['Set-Cookie'], next);
  } else {
    headers['Set-Cookie'] = next;
  }
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

function sendText(res, statusCode, body, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(statusCode, { 'Content-Type': type, ...headers });
  res.end(body);
}

function getBaseUrl(req) {
  if (PUBLIC_BASE_URL_CONFIG) {
    try {
      const configured = new URL(PUBLIC_BASE_URL_CONFIG);
      return `${configured.origin}${currentBasePath()}`;
    } catch {
      // Fall through to the request host when the optional public URL is invalid.
    }
  }
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  // Public HTTPS tunnels may not forward x-forwarded-proto to the local app.
  const isPublicHttpsHost = /(?:\.lhr\.life|\.loca\.lt)$/i.test(host.split(':')[0]);
  const protocol = forwardedProto || (isPublicHttpsHost ? 'https' : 'http');
  return `${protocol}://${host}${currentBasePath()}`;
}

function publicUrl(baseUrl, pathValue) {
  const basePath = currentBasePath();
  if (basePath && pathValue.startsWith(basePath)) {
    return `${baseUrl}${pathValue.slice(basePath.length)}`;
  }
  return `${baseUrl}${pathValue}`;
}

function appPath(pathValue) {
  return `${currentBasePath()}${pathValue}`;
}

function currentBasePath() {
  return requestContext.getStore()?.basePath || PUBLIC_BASE_PATH;
}

function stripPublicBasePath(pathname, basePath = currentBasePath()) {
  if (!basePath) return pathname;
  if (pathname === basePath) return '/';
  if (pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length) || '/';
  }
  return pathname;
}

function inferBasePath(req, pathname) {
  if (PUBLIC_BASE_PATH) return PUBLIC_BASE_PATH;
  const forwardedPrefix = String(req.headers['x-forwarded-prefix'] || '').split(',')[0].trim();
  if (forwardedPrefix) return normalizeBasePath(forwardedPrefix);
  const suffixes = [
    '/health', '/checkin', '/result', '/auth/feishu/start', '/auth/feishu/callback',
    '/api/qrcode', '/api/checkin', '/api/checkin/confirm', '/api/export/signins.csv',
    '/api/export/lottery.csv', '/api/events/create', '/api/events/clear',
    '/api/events/delete', '/api/config', '/api/roster/import', '/api/roster/upload',
    '/api/prizes/import', '/api/prizes/upload', '/api/prizes/delete', '/api/draw/start',
  ];
  for (const suffix of suffixes) {
    if (pathname.endsWith(suffix)) return pathname.slice(0, -suffix.length).replace(/\/$/, '');
  }
  if (pathname !== '/' && pathname.endsWith('/')) return pathname.replace(/\/$/, '');
  return '';
}

function participantStatusBlock(event, participant) {
  if (!participant) {
    return '';
  }

  if (participant.drawResult === 'won') {
    return `
      <div class="notice win">
        <div class="notice-title">${escapeHtml(event.config.winText)}</div>
        <div class="notice-text">${escapeHtml(participant.prizeName || '已中奖')}</div>
        ${participant.prizeDescription ? `<div class="notice-sub">${escapeHtml(participant.prizeDescription)}</div>` : ''}
        ${renderPrizeAsset({
          name: participant.prizeName,
          imageUrl: participant.prizeImageUrl,
          fileUrl: participant.prizeFileUrl,
          fileName: participant.prizeFileName,
        })}
      </div>
    `;
  }

  if (participant.drawResult === 'not_won') {
    return `
      <div class="notice lose">
        <div class="notice-title">${escapeHtml(event.config.noWinText)}</div>
        <div class="notice-time">签到时间：${escapeHtml(participant.checkedInAt)}</div>
      </div>
    `;
  }

  return `
    <div class="notice pending" data-pending="1">
      <div class="notice-title">${escapeHtml(event.config.successText)}</div>
      <div class="notice-text">${escapeHtml(event.config.pendingText)}</div>
      <div class="notice-time">签到时间：${escapeHtml(participant.checkedInAt)}</div>
    </div>
  `;
}

function pendingProfileBlock(event, profile) {
  if (!profile) return '';
  return `
      <div class="notice neutral identity-confirm">
      <div class="notice-title">请确认你的身份</div>
      <div class="identity-grid">
        <div><span>姓名</span><strong>${escapeHtml(profile.name || '未识别')}</strong></div>
        <div><span>部门</span><strong>${escapeHtml(profile.department || '未匹配')}</strong></div>
        <div><span>员工类型</span><strong>${escapeHtml(profile.employeeType || '未匹配')}</strong></div>
      </div>
      <div class="notice-sub">信息确认无误后，再点击下方“确认签到”。</div>
      <form method="post" action="${eventQuery('/api/checkin/confirm', event.id)}">
        <button type="submit">确认签到</button>
      </form>
      <a class="text-link" href="${eventQuery('/checkin', event.id)}">注意：若上方信息有误，点击返回重新识别</a>
    </div>
  `;
}

function feishuAuthorizeUrl(event, baseUrl) {
  return `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=${encodeURIComponent(FEISHU_APP_ID)}&redirect_uri=${encodeURIComponent(`${baseUrl}/auth/feishu/callback`)}&state=${encodeURIComponent(event.id)}`;
}

function pageShell(title, body, extraHead = '') {
  return `<!doctype html>
  <html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        --bg1:#08112b;
        --bg2:#13244e;
        --panel:rgba(10, 18, 36, .9);
        --line:rgba(148, 163, 184, .18);
        --text:#edf4ff;
        --muted:#9cb1cc;
        --accent:#7dd3fc;
        --accent2:#fbbf24;
        --danger:#fb7185;
      }
      * { box-sizing:border-box; }
      body {
        margin:0;
        font-family:"Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;
        color:var(--text);
        background:
          radial-gradient(circle at top left, rgba(56, 189, 248, .2), transparent 28%),
          radial-gradient(circle at right center, rgba(251, 191, 36, .12), transparent 26%),
          linear-gradient(135deg, var(--bg1), var(--bg2) 58%, #0b1328);
      }
      .wrap { max-width:1260px; margin:0 auto; padding:24px; }
      .card {
        background:var(--panel);
        border:1px solid var(--line);
        border-radius:24px;
        padding:20px;
        box-shadow:0 28px 80px rgba(2, 6, 23, .34);
        backdrop-filter: blur(14px);
      }
      .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:16px; }
      .hero { display:flex; justify-content:space-between; align-items:flex-end; gap:16px; flex-wrap:wrap; margin-bottom:18px; }
      h1,h2,h3,p { margin:0; }
      h1 { font-size:30px; }
      h2 { font-size:18px; margin-bottom:12px; }
      p.sub { color:var(--muted); margin-top:8px; }
      .stat { display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; }
      .top-pair { display:grid; grid-template-columns:1.4fr 1fr; gap:16px; margin-top:16px; }
      .box { background:rgba(255,255,255,.04); border:1px solid rgba(148,163,184,.14); border-radius:16px; padding:14px; }
      .box strong { display:block; margin-top:6px; font-size:24px; }
      textarea, input, select {
        width:100%;
        padding:12px;
        border-radius:14px;
        border:1px solid rgba(148,163,184,.18);
        background:rgba(2,6,23,.5);
        color:var(--text);
        font:inherit;
      }
      textarea { min-height:140px; resize:vertical; }
      .row { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; align-items:center; }
      button, .btn {
        border:0;
        border-radius:14px;
        padding:11px 16px;
        background:linear-gradient(135deg, var(--accent), #60a5fa);
        color:#08111f;
        font-weight:700;
        text-decoration:none;
        cursor:pointer;
      }
      .btn.secondary { background:linear-gradient(135deg, #fbbf24, #fb923c); }
      .btn.ghost {
        background:rgba(255,255,255,.06);
        color:var(--text);
        border:1px solid rgba(148,163,184,.18);
      }
      .btn.danger, button.danger {
        background:linear-gradient(135deg, var(--danger), #f97316);
        color:#fff5f5;
      }
      table { width:100%; border-collapse:collapse; }
      th, td {
        text-align:left;
        padding:10px 8px;
        border-bottom:1px solid rgba(148,163,184,.12);
        font-size:14px;
        vertical-align:top;
      }
      .muted { color:var(--muted); }
      .center { text-align:center; }
      .qr-box { display:grid; place-items:center; gap:12px; }
      .qr-box img { width:220px; height:220px; border-radius:18px; background:#fff; padding:12px; }
      .link { color:#7dd3fc; word-break:break-all; }
      .notice {
        border-radius:18px;
        padding:16px;
        border:1px solid rgba(255,255,255,.16);
        margin:14px 0 18px;
      }
      .notice.pending { background:rgba(56,189,248,.12); }
      .notice.win { background:rgba(34,197,94,.12); }
      .notice.lose { background:rgba(251,191,36,.12); }
      .notice.neutral { background:rgba(148,163,184,.10); }
      .notice-title { font-size:22px; font-weight:800; }
      .notice-text { margin-top:8px; font-size:16px; }
      .notice-sub { margin-top:8px; color:var(--muted); }
      .identity-confirm { margin-top:16px; }
      .identity-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:16px; text-align:left; }
      .identity-grid div { padding:12px; border-radius:12px; background:rgba(148,163,184,.10); }
      .identity-grid span { display:block; color:var(--muted); font-size:12px; }
      .identity-grid strong { display:block; margin-top:5px; font-size:16px; }
      .identity-confirm form { margin-top:16px; }
      .identity-confirm form button { width:100%; min-height:52px; font-size:18px; font-weight:800; }
      .text-link { display:inline-block; margin-top:12px; color:#7dd3fc; text-decoration:none; }
      @media (max-width:640px) { .identity-grid { grid-template-columns:1fr; } }
      .prize-image {
        display:block;
        width:100%;
        max-width:320px;
        margin:16px auto 0;
        border-radius:18px;
        border:1px solid rgba(148,163,184,.2);
        background:rgba(255,255,255,.06);
      }
      .prize-thumb {
        width:64px;
        height:64px;
        object-fit:cover;
        border-radius:12px;
        border:1px solid rgba(148,163,184,.18);
        background:rgba(255,255,255,.06);
      }
      .prize-link {
        color:#7dd3fc;
        text-decoration:none;
      }
      .dropzone {
        border:2px dashed rgba(125,211,252,.4);
        border-radius:18px;
        padding:24px 18px;
        text-align:center;
        background:rgba(125,211,252,.06);
      }
      .dropzone strong {
        display:block;
        font-size:18px;
      }
      .dropzone.active {
        border-color:rgba(251,191,36,.8);
        background:rgba(251,191,36,.12);
      }
      .dropzone input[type="file"] {
        margin-top:12px;
        background:transparent;
        border:none;
        padding:0;
      }
      .checkin-card {
        max-width:680px;
        margin:0 auto;
        min-height:100vh;
        display:grid;
        place-items:center;
        padding:20px 0;
      }
      .checkin-card .card { width:100%; }
      .checkin-form {
        margin-top:12px;
        display:grid;
        gap:16px;
      }
      .checkin-actions {
        display:grid;
        grid-template-columns:repeat(2, minmax(0, 1fr));
        gap:16px;
        width:100%;
        align-items:stretch;
      }
      .checkin-actions.single {
        grid-template-columns:1fr;
      }
      .checkin-actions > * {
        min-width:0;
      }
      .checkin-actions .btn,
      .checkin-actions button {
        display:flex;
        align-items:center;
        justify-content:center;
        width:100%;
        min-height:96px;
        font-size:24px;
        padding:18px 24px;
        border-radius:18px;
        text-align:center;
      }
      .activity-list { display:grid; gap:10px; }
      .activity-item {
        display:flex;
        justify-content:space-between;
        gap:12px;
        align-items:center;
        padding:14px;
        border-radius:18px;
        border:1px solid rgba(148,163,184,.14);
        background:rgba(255,255,255,.04);
      }
      .activity-item.active {
        border-color:rgba(125,211,252,.5);
        box-shadow:inset 0 0 0 1px rgba(125,211,252,.18);
      }
      .hero-actions {
        display:flex;
        gap:10px;
        flex-wrap:wrap;
        justify-content:flex-end;
        align-items:center;
      }
      .inline-form { display:inline-block; margin:0; }
      .inline-form button { margin:0; }
      .action-center {
        text-align:center;
      }
      .action-center .row {
        justify-content:center;
      }
      .action-center .btn,
      .action-center button {
        min-width:220px;
      }
      .feishu-btn {
        background:linear-gradient(135deg, #14b8a6, #2dd4bf);
      }
      .spacer { height:8px; }
      @media (max-width: 720px) {
        .wrap { padding:14px; }
        .stat { grid-template-columns:repeat(2, 1fr); }
        .top-pair { grid-template-columns:1fr; }
        h1 { font-size:24px; }
        .checkin-actions { grid-template-columns:1fr 1fr; }
        .activity-item { flex-direction:column; align-items:flex-start; }
        .hero-actions { justify-content:flex-start; }
      }
      /* Activity studio visual system: calm canvas, clear actions, warm energy. */
      :root {
        --canvas:#f5f1e9;
        --canvas-deep:#e9e2d7;
        --surface:#fffdf8;
        --surface-soft:#f8f4ed;
        --ink:#172026;
        --muted-ink:#687177;
        --line-soft:#ded8ce;
        --coral:#e85d4a;
        --coral-dark:#b83e32;
        --teal:#087f78;
        --teal-soft:#dff2ed;
        --gold:#e4a72c;
        --danger-ink:#9f302c;
      }
      html { background:var(--canvas); }
      ::selection { background:var(--coral); color:#fffdf8; }
      ::-webkit-scrollbar { width:10px; height:10px; }
      ::-webkit-scrollbar-track { background:var(--canvas-deep); }
      ::-webkit-scrollbar-thumb { background:#b8afa2; border:3px solid var(--canvas-deep); border-radius:999px; }
      body {
        min-height:100vh;
        font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei UI",sans-serif;
        color:var(--ink);
        background:
          radial-gradient(circle at 8% 4%, rgba(232,93,74,.14), transparent 24rem),
          radial-gradient(circle at 96% 10%, rgba(8,127,120,.12), transparent 25rem),
          linear-gradient(135deg, var(--canvas) 0%, #fbf8f2 54%, var(--canvas-deep) 100%);
      }
      body::before {
        content:"";
        position:fixed;
        inset:0;
        pointer-events:none;
        opacity:.28;
        background-image:radial-gradient(rgba(23,32,38,.09) .65px, transparent .65px);
        background-size:7px 7px;
        mix-blend-mode:multiply;
      }
      .wrap { max-width:1320px; padding:34px 28px 60px; position:relative; }
      .card {
        background:rgba(255,253,248,.91);
        border:1px solid rgba(222,216,206,.95);
        border-radius:22px;
        padding:22px;
        box-shadow:0 18px 45px rgba(75,61,45,.10), 0 2px 7px rgba(75,61,45,.05);
        backdrop-filter:blur(10px);
      }
      .hero { align-items:center; margin-bottom:24px; }
      .hero h1, .checkin-card h1 { letter-spacing:-.035em; line-height:1.12; font-weight:850; }
      .hero h1 { font-size:36px; }
      h2 { color:var(--ink); font-size:18px; letter-spacing:-.015em; }
      p.sub, .muted, .notice-sub { color:var(--muted-ink); }
      .sub { line-height:1.65; }
      .hero-actions { gap:8px; }
      button, .btn {
        min-height:44px;
        border-radius:12px;
        padding:11px 17px;
        background:var(--coral);
        color:#fffdf8;
        box-shadow:0 7px 15px rgba(232,93,74,.18);
        transition:transform .18s ease, box-shadow .18s ease, background .18s ease;
      }
      button:hover, .btn:hover { background:var(--coral-dark); box-shadow:0 10px 20px rgba(184,62,50,.22); transform:translateY(-1px); }
      button:active, .btn:active { transform:translateY(1px); box-shadow:none; }
      button:focus-visible, .btn:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible {
        outline:3px solid rgba(8,127,120,.35);
        outline-offset:3px;
      }
      .btn.secondary { background:var(--gold); color:#3b2a0d; box-shadow:0 7px 15px rgba(228,167,44,.18); }
      .btn.secondary:hover { background:#c78c19; }
      .btn.ghost {
        background:var(--surface-soft);
        color:var(--ink);
        border:1px solid var(--line-soft);
        box-shadow:none;
      }
      .btn.ghost:hover { background:#eee8dd; border-color:#c9c0b4; }
      .btn.danger, button.danger { background:#fff0ed; color:var(--danger-ink); border:1px solid #f0c5be; box-shadow:none; }
      .btn.danger:hover, button.danger:hover { background:#f9d8d2; }
      input, textarea, select {
        border:1px solid var(--line-soft);
        background:#fffefa;
        color:var(--ink);
        border-radius:12px;
        box-shadow:inset 0 1px 2px rgba(75,61,45,.04);
      }
      input::placeholder, textarea::placeholder { color:#8b918f; }
      textarea { min-height:130px; }
      .grid { gap:18px; }
      .top-pair { gap:18px; margin-top:18px; }
      .box { background:var(--surface-soft); border:1px solid var(--line-soft); border-radius:16px; }
      .box strong { color:var(--teal); font-size:28px; }
      .stat { gap:12px; }
      .activity-list { gap:12px; }
      .activity-item { background:var(--surface-soft); border:1px solid var(--line-soft); border-radius:16px; padding:16px; }
      .activity-item.active { border-color:rgba(8,127,120,.52); box-shadow:inset 0 0 0 1px rgba(8,127,120,.18); background:var(--teal-soft); }
      .qr-box { padding:6px 0 2px; }
      .qr-box img { width:238px; height:238px; padding:14px; border-radius:18px; border:8px solid #fff; box-shadow:0 12px 26px rgba(23,32,38,.12); }
      .link { color:var(--teal); font-size:13px; line-height:1.6; max-width:360px; }
      .notice { border-radius:16px; border:1px solid var(--line-soft); padding:18px; }
      .notice.pending { background:var(--teal-soft); border-color:#b9dfd6; }
      .notice.win { background:#fff4d9; border-color:#edd18a; }
      .notice.lose { background:#fff0ed; border-color:#f0c5be; }
      .notice.neutral { background:var(--surface-soft); }
      .notice-title { color:var(--ink); font-size:22px; letter-spacing:-.02em; }
      .identity-grid div { background:#fffefa; border:1px solid var(--line-soft); }
      .identity-grid span { color:var(--muted-ink); }
      .identity-grid strong { color:var(--ink); }
      .identity-confirm form button { background:var(--teal); box-shadow:0 10px 20px rgba(8,127,120,.2); }
      .identity-confirm form button:hover { background:#05635e; }
      .text-link, .prize-link { color:var(--teal); }
      .dropzone { border:2px dashed #b7d4cc; background:#f0f8f5; border-radius:16px; padding:28px 18px; }
      .dropzone strong { color:var(--teal); }
      .dropzone.active { border-color:var(--coral); background:#fff3ed; }
      table { overflow:hidden; border:1px solid var(--line-soft); border-radius:14px; }
      th { color:var(--muted-ink); background:var(--surface-soft); font-size:12px; letter-spacing:.04em; text-transform:none; }
      th, td { border-bottom:1px solid var(--line-soft); }
      tr:last-child td { border-bottom:0; }
      .action-center { background:#173f3d; border-color:#173f3d; color:#f7fbf8; }
      .action-center h2, .action-center .sub { color:#f7fbf8; }
      .action-center input { max-width:120px; margin:0 auto; background:#fffefa; }
      .action-center button { background:#f2b541; color:#3b2a0d; box-shadow:none; min-height:50px; }
      .action-center button:hover { background:#ffd06b; }
      .checkin-card { max-width:720px; padding:26px 14px; }
      .checkin-card .card { padding:34px; }
      .checkin-card h1 { font-size:32px; }
      .checkin-card .card > .sub:first-of-type { font-size:15px; margin-top:10px; }
      .checkin-card .card > .sub:last-child { margin-top:22px; padding-top:16px; border-top:1px solid var(--line-soft); font-size:13px; }
      .checkin-card .notice { margin-top:24px; }
      body:has(.checkin-card) { background:linear-gradient(145deg,#eaf5f0 0%,#f9f5ed 58%,#f0e7dc 100%); }
      body:has(.checkin-card)::before { opacity:.18; }
      body:has(.checkin-card) .checkin-card .card { border-top:5px solid var(--teal); animation:checkin-rise .45s ease-out both; }
      @keyframes checkin-rise { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:none; } }
      @media (max-width:720px) {
        .wrap { padding:20px 14px 42px; }
        .hero h1 { font-size:28px; }
        .hero-actions { width:100%; }
        .hero-actions > *, .hero-actions form { flex:1 1 auto; }
        .hero-actions .btn, .hero-actions button { width:100%; }
        .checkin-card .card { padding:24px 18px; }
        .checkin-card h1 { font-size:27px; }
        .qr-box img { width:210px; height:210px; }
      }
      /* HEYTEA-inspired direction: editorial monochrome with acid-green action. */
      :root {
        --canvas:#f4f4ef;
        --canvas-deep:#e7e7df;
        --surface:#fffefa;
        --surface-soft:#f0f0e9;
        --ink:#111311;
        --muted-ink:#6d716d;
        --line-soft:#191b19;
        --coral:#dfff00;
        --coral-dark:#b8d400;
        --teal:#111311;
        --teal-soft:#e9ff76;
        --gold:#dfff00;
        --danger-ink:#111311;
      }
      body {
        font-family:"Bahnschrift SemiCondensed","Noto Sans SC","PingFang SC","Microsoft YaHei UI",sans-serif;
        letter-spacing:-.012em;
        background:
          linear-gradient(90deg, transparent 0 92%, rgba(17,19,17,.07) 92% 92.2%, transparent 92.2%),
          linear-gradient(180deg, #f8f8f3 0%, var(--canvas) 62%, #e9e9e1 100%);
      }
      body::before {
        opacity:.2;
        background-image:radial-gradient(#111311 1px, transparent 1px);
        background-size:13px 13px;
        mix-blend-mode:multiply;
      }
      .wrap { max-width:1360px; padding:30px 28px 64px; }
      .hero { border-bottom:2px solid var(--ink); padding-bottom:18px; }
      .hero h1, .checkin-card h1 { font-weight:950; letter-spacing:-.075em; text-transform:none; }
      .hero h1 { font-size:42px; }
      h2 { font-size:17px; font-weight:900; letter-spacing:-.04em; }
      .card {
        border:2px solid var(--ink);
        border-radius:7px;
        background:rgba(255,254,250,.96);
        box-shadow:6px 6px 0 rgba(17,19,17,.10);
        backdrop-filter:none;
      }
      button, .btn {
        border:2px solid var(--ink);
        border-radius:3px;
        background:var(--coral);
        color:var(--ink);
        box-shadow:none;
        font-weight:900;
        letter-spacing:-.025em;
      }
      button:hover, .btn:hover { background:var(--coral-dark); color:var(--ink); box-shadow:3px 3px 0 var(--ink); transform:none; }
      button:active, .btn:active { transform:translate(2px,2px); box-shadow:none; }
      .btn.secondary { background:var(--ink); color:var(--coral); border-color:var(--ink); box-shadow:none; }
      .btn.secondary:hover { background:#303330; color:var(--coral); }
      .btn.ghost { border:2px solid var(--ink); background:var(--surface); color:var(--ink); border-radius:3px; }
      .btn.ghost:hover { background:var(--ink); color:var(--coral); border-color:var(--ink); }
      .btn.danger, button.danger { border:2px solid var(--ink); background:#ff8b7d; color:var(--ink); }
      .btn.danger:hover, button.danger:hover { background:#ff6558; }
      input, textarea, select { border:2px solid var(--ink); border-radius:3px; background:#fffefa; color:var(--ink); box-shadow:none; }
      input:focus-visible, textarea:focus-visible, select:focus-visible { outline:3px solid var(--coral); outline-offset:2px; }
      .box { border:2px solid var(--ink); border-radius:4px; background:var(--surface-soft); }
      .box strong { color:var(--ink); font-weight:950; }
      .activity-item { border:2px solid var(--ink); border-radius:4px; background:var(--surface); }
      .activity-item.active { background:var(--coral); border-color:var(--ink); box-shadow:4px 4px 0 var(--ink); }
      .qr-box img { border:10px solid var(--ink); border-radius:3px; padding:12px; box-shadow:6px 6px 0 var(--coral); }
      .link { color:var(--ink); font-weight:700; }
      .notice { border:2px solid var(--ink); border-radius:4px; }
      .notice.pending { background:var(--teal-soft); border-color:var(--ink); }
      .notice.win { background:var(--coral); border-color:var(--ink); }
      .notice.lose { background:#ffb3a9; border-color:var(--ink); }
      .notice.neutral { background:var(--surface-soft); border-color:var(--ink); }
      .notice-title { font-weight:950; letter-spacing:-.06em; }
      .dropzone { border:2px dashed var(--ink); border-radius:4px; background:#f4ffbd; }
      .dropzone strong { color:var(--ink); font-weight:950; }
      .dropzone.active { background:var(--coral); border-color:var(--ink); }
      table { border:2px solid var(--ink); border-radius:4px; }
      th { background:var(--ink); color:var(--coral); font-weight:900; }
      th, td { border-bottom:1px solid #aeb1aa; }
      .action-center { background:var(--ink); border:2px solid var(--ink); border-radius:7px; box-shadow:6px 6px 0 var(--coral); }
      .action-center h2, .action-center .sub { color:#fffefa; }
      .action-center button { background:var(--coral); border-color:var(--coral); color:var(--ink); }
      .action-center button:hover { background:var(--coral-dark); color:var(--ink); }
      .identity-grid div { border:2px solid var(--ink); border-radius:3px; background:var(--surface); }
      .identity-confirm form button { background:var(--coral); border-color:var(--ink); color:var(--ink); box-shadow:4px 4px 0 var(--ink); }
      .identity-confirm form button:hover { background:var(--coral-dark); }
      .text-link, .prize-link { color:var(--ink); text-decoration:underline; text-decoration-thickness:2px; text-underline-offset:4px; font-weight:800; }
      .checkin-card { max-width:760px; }
      .checkin-card .card { border-top:14px solid var(--ink); padding:38px; box-shadow:8px 8px 0 var(--coral); }
      body:has(.checkin-card) { background:linear-gradient(135deg,#f8f8f3 0%,#eeffc0 100%); }
      body:has(.checkin-card) .checkin-card .card { animation:none; }
      @media (max-width:720px) {
        .hero h1 { font-size:32px; }
        .checkin-card .card { padding:26px 18px; border-top-width:10px; }
      }
      /* Minimal mini-program direction: white space, hairlines, quiet hierarchy. */
      :root {
        --canvas:#ffffff;
        --canvas-deep:#f7f7f7;
        --surface:#ffffff;
        --surface-soft:#fafafa;
        --ink:#171717;
        --muted-ink:#8f8f8f;
        --line-soft:#e8e8e8;
        --coral:#171717;
        --coral-dark:#000000;
        --teal:#171717;
        --teal-soft:#f7f7f7;
        --gold:#171717;
        --danger-ink:#171717;
      }
      html, body { background:#fff; }
      body {
        font-family:"PingFang SC","Noto Sans SC","Microsoft YaHei UI",sans-serif;
        letter-spacing:0;
        color:var(--ink);
        background:#fff;
      }
      body::before { display:none; }
      ::-webkit-scrollbar { width:6px; height:6px; }
      ::-webkit-scrollbar-track { background:#fff; }
      ::-webkit-scrollbar-thumb { background:#cfcfcf; border:1px solid #fff; border-radius:99px; }
      .wrap { max-width:1280px; padding:28px 30px 60px; }
      .card {
        border:1px solid var(--line-soft);
        border-radius:2px;
        background:var(--surface);
        box-shadow:0 10px 30px rgba(0,0,0,.035);
        backdrop-filter:none;
      }
      .hero { border-bottom:1px solid var(--ink); padding-bottom:18px; margin-bottom:20px; }
      .hero h1, .checkin-card h1 { font-family:"Songti SC","STSong","Noto Serif SC",serif; font-weight:600; letter-spacing:-.045em; }
      .hero h1 { font-size:30px; }
      h2 { font-size:16px; font-weight:600; letter-spacing:0; }
      p.sub, .muted, .notice-sub { color:var(--muted-ink); }
      .hero-actions { gap:8px; }
      button, .btn {
        min-height:42px;
        padding:10px 16px;
        border:1px solid var(--ink);
        border-radius:2px;
        background:var(--ink);
        color:#fff;
        box-shadow:none;
        font-size:14px;
        font-weight:500;
        transition:background .16s ease, color .16s ease, border-color .16s ease;
      }
      button:hover, .btn:hover { background:#fff; color:var(--ink); border-color:var(--ink); box-shadow:none; transform:none; }
      button:active, .btn:active { transform:none; }
      .btn.secondary { background:#fff; color:var(--ink); border-color:var(--ink); box-shadow:none; }
      .btn.secondary:hover { background:var(--ink); color:#fff; }
      .btn.ghost { background:#fff; color:var(--ink); border:1px solid #cfcfcf; box-shadow:none; }
      .btn.ghost:hover { background:#f5f5f5; border-color:var(--ink); color:var(--ink); }
      .btn.danger, button.danger { background:#fff; color:var(--ink); border-color:#cfcfcf; box-shadow:none; }
      .btn.danger:hover, button.danger:hover { background:#f4f4f4; color:var(--ink); }
      input, textarea, select {
        border:1px solid #d7d7d7;
        border-radius:2px;
        background:#fff;
        color:var(--ink);
        box-shadow:none;
      }
      input::placeholder, textarea::placeholder { color:#a4a4a4; }
      input:focus-visible, textarea:focus-visible, select:focus-visible { outline:1px solid var(--ink); outline-offset:2px; }
      .box { border:1px solid var(--line-soft); border-radius:2px; background:#fff; }
      .box strong { color:var(--ink); font-size:25px; font-weight:500; }
      .activity-item { border:1px solid var(--line-soft); border-radius:2px; background:#fff; }
      .activity-item.active { border-color:var(--ink); background:#fafafa; box-shadow:inset 3px 0 0 var(--ink); }
      .qr-box img { width:220px; height:220px; border:1px solid #d5d5d5; border-radius:0; padding:12px; box-shadow:none; }
      .link { color:#646464; font-size:12px; font-weight:400; }
      .notice { border:1px solid var(--line-soft); border-radius:2px; }
      .notice.pending, .notice.win, .notice.lose, .notice.neutral { background:#fafafa; border-color:var(--line-soft); }
      .notice-title { font-size:20px; font-weight:600; letter-spacing:-.03em; }
      .dropzone { border:1px dashed #cfcfcf; border-radius:2px; background:#fcfcfc; }
      .dropzone strong { color:var(--ink); font-weight:500; }
      .dropzone.active { background:#f4f4f4; border-color:var(--ink); }
      table { border:1px solid var(--line-soft); border-radius:2px; }
      th { background:#fafafa; color:#777; font-weight:500; }
      th, td { border-bottom:1px solid var(--line-soft); }
      .action-center { background:#fff; border:1px solid var(--ink); border-radius:2px; box-shadow:none; color:var(--ink); }
      .action-center h2, .action-center .sub { color:var(--ink); }
      .action-center button { background:var(--ink); border-color:var(--ink); color:#fff; }
      .action-center button:hover { background:#fff; border-color:var(--ink); color:var(--ink); }
      .identity-grid div { border:1px solid var(--line-soft); border-radius:2px; background:#fff; }
      .identity-confirm form button { background:var(--ink); border:1px solid var(--ink); color:#fff; box-shadow:none; }
      .identity-confirm form button:hover { background:#fff; color:var(--ink); }
      .text-link, .prize-link { color:var(--ink); text-decoration:underline; text-underline-offset:3px; font-weight:400; }
      .checkin-card { max-width:620px; min-height:100vh; padding:48px 14px 70px; }
      .checkin-card .card { padding:34px 30px 28px; border:0; border-top:1px solid var(--ink); border-radius:0; box-shadow:none; }
      .checkin-card h1 { font-size:32px; text-align:center; }
      .checkin-card .card > .sub:first-of-type { max-width:360px; margin:12px auto 0; text-align:center; font-size:13px; line-height:1.8; }
      .checkin-card .notice { margin:34px 0 0; padding:24px 20px; }
      .checkin-card .notice-title { text-align:center; }
      .checkin-card .notice-text { text-align:center; color:#555; font-size:14px; }
      .checkin-card .card > .sub:last-child { margin-top:34px; padding-top:18px; text-align:center; border-top:1px solid var(--line-soft); font-size:12px; }
      body:has(.checkin-card) { background:#fff; }
      body:has(.checkin-card) .checkin-card .card { animation:none; }
      @media (max-width:720px) {
        .wrap { padding:20px 16px 42px; }
        .hero h1 { font-size:26px; }
        .checkin-card { padding:22px 10px 54px; }
        .checkin-card .card { padding:30px 18px 24px; }
        .checkin-card h1 { font-size:28px; }
        .qr-box img { width:200px; height:200px; }
      }
      /* Warm editorial system: ivory canvas, teal lead, orange and blue states. */
      :root {
        --canvas:#f8f9d8;
        --canvas-deep:#edf0c1;
        --surface:#fffef7;
        --surface-soft:#f3f6d8;
        --ink:#202515;
        --muted-ink:#747c61;
        --line-soft:#dfe4b5;
        --coral:#cfe31c;
        --coral-dark:#a8b713;
        --teal:#cfe31c;
        --teal-soft:#edf6b5;
        --gold:#e3c943;
        --danger-ink:#8c5a16;
      }
      html, body { background:var(--canvas); }
      body {
        color:var(--ink);
        background:
          radial-gradient(rgba(207,227,28,.12) .8px, transparent .8px) 0 0/18px 18px,
          linear-gradient(180deg,#fbfce8 0%,var(--canvas) 70%,#eff2c5 100%);
      }
      body::before { display:none; }
      .wrap { max-width:1360px; padding:32px 28px 64px; }
      .card {
        border:1px solid #d9dfda;
        border-radius:18px;
        background:rgba(255,254,251,.94);
        box-shadow:0 10px 28px rgba(29,55,50,.07);
      }
      .hero { border-bottom:1px solid #cfd8d4; padding-bottom:22px; margin-bottom:24px; }
      .hero h1, .checkin-card h1 { font-family:"Songti SC","STSong","Noto Serif SC",serif; font-weight:700; letter-spacing:-.055em; }
      .hero h1 { font-size:38px; }
      h2 { font-size:17px; font-weight:650; }
      p.sub, .muted, .notice-sub { color:var(--muted-ink); }
      button, .btn {
        min-height:44px;
        border:1px solid var(--coral);
        border-radius:11px;
        background:var(--coral);
        color:#243000;
        box-shadow:0 5px 13px rgba(168,183,19,.16);
        font-weight:600;
      }
      button:hover, .btn:hover { background:var(--coral-dark); border-color:var(--coral-dark); color:#243000; box-shadow:0 8px 18px rgba(168,183,19,.18); transform:translateY(-1px); }
      button:active, .btn:active { transform:translateY(1px); }
      .btn.secondary { background:var(--gold); border-color:var(--gold); color:#332700; box-shadow:0 5px 13px rgba(227,201,67,.16); }
      .btn.secondary:hover { background:#b9ab23; border-color:#b9ab23; }
      .btn.ghost { background:#fffef6; color:var(--ink); border-color:#d8deb8; box-shadow:none; }
      .btn.ghost:hover { background:var(--surface-soft); border-color:var(--coral); color:var(--ink); }
      .btn.danger, button.danger { background:#fff7ea; color:var(--danger-ink); border-color:#ead6ae; box-shadow:none; }
      .btn.danger:hover, button.danger:hover { background:#fbe9c7; color:var(--danger-ink); border-color:#dfc180; }
      input, textarea, select { border:1px solid #d8e0b9; border-radius:10px; background:#fffef8; color:var(--ink); }
      input:focus-visible, textarea:focus-visible, select:focus-visible { outline:3px solid rgba(207,227,28,.24); outline-offset:2px; }
      .box { border:1px solid #dfe5b5; border-radius:14px; background:var(--surface-soft); }
      .box strong { color:var(--ink); font-size:28px; font-weight:650; }
      .activity-item { border:1px solid #dfe5b5; border-radius:14px; background:#fffef8; }
      .activity-item.active { border-color:#b6ca24; background:#f4f8d7; box-shadow:inset 3px 0 0 var(--teal); }
      .qr-box img { width:224px; height:224px; border:1px solid #d9e0b6; border-radius:16px; padding:12px; box-shadow:0 8px 20px rgba(76,90,20,.10); }
      .setup-status { width:100%; max-width:420px; padding:10px 12px; border-radius:10px; font-size:12px; line-height:1.6; text-align:left; }
      .setup-status.enabled { color:#5a6700; background:#f2f8c7; border:1px solid #dbe48c; }
      .setup-status.disabled { color:#8a4b24; background:#fff3e6; border:1px solid #edc89f; }
      .setup-notice { border-color:#edd892; background:#fff9de; }
      .link { color:#728000; font-size:12px; }
      .notice { border:1px solid #dfe5b5; border-radius:14px; }
      .notice.pending { background:var(--teal-soft); border-color:#dbe48c; }
      .notice.win { background:#fff6d8; border-color:#e5cd78; }
      .notice.lose { background:#fff8df; border-color:#e4d795; }
      .notice.neutral { background:var(--surface-soft); border-color:#dfe5b5; }
      .notice-title { font-size:21px; font-weight:700; }
      .notice.pending, .notice.win, .notice.lose { text-align:center; }
      .dropzone { border:1px dashed #a8c9c1; border-radius:14px; background:#f0f8f5; }
      .dropzone strong { color:#6f7f00; font-weight:650; }
      .dropzone.active { background:#fff6d8; border-color:var(--gold); }
      table { border:1px solid #dfe5b5; border-radius:14px; }
      th { background:#f1f5f1; color:#62716e; font-weight:650; }
      th, td { border-bottom:1px solid #e3e8e4; }
      .action-center { background:#f1f6cf; border:1px solid #d5df87; border-radius:18px; box-shadow:none; color:var(--ink); }
      .action-center h2, .action-center .sub { color:var(--ink); }
      .action-center button { background:var(--coral); border-color:var(--coral); color:#243000; }
      .action-center button:hover { background:var(--coral-dark); border-color:var(--coral-dark); }
      .identity-grid div { border:1px solid #dfe5b5; border-radius:12px; background:#fffef8; }
      .identity-confirm form button { background:var(--teal); border-color:var(--teal); color:#243000; box-shadow:0 8px 18px rgba(168,183,19,.15); }
      .identity-confirm form button:hover { background:var(--coral-dark); }
      .text-link, .prize-link { color:#6f7f00; text-decoration:underline; text-underline-offset:3px; font-weight:500; }
      .checkin-card { max-width:660px; padding:42px 14px 70px; }
      .checkin-card .card { position:relative; overflow:hidden; padding:36px 30px 28px; border:1px solid #d9dfb5; border-radius:18px; box-shadow:0 14px 34px rgba(76,90,20,.08); }
      .checkin-card .card::before { content:""; position:absolute; inset:0 0 auto; height:5px; background:var(--teal); }
      .checkin-card h1 { font-size:32px; color:var(--ink); }
      .checkin-card .card > .sub:first-of-type { max-width:390px; margin:12px auto 0; text-align:center; font-size:13px; line-height:1.8; }
      .checkin-card .notice { margin:30px 0 0; padding:24px 20px; }
      .checkin-card .notice-title { text-align:center; }
      .checkin-card .notice-text { text-align:center; color:#566360; font-size:14px; }
      .checkin-card .notice-time { margin-top:10px; text-align:center; color:var(--muted-ink); font-size:14px; }
      .checkin-card .card > .sub:last-child { margin-top:30px; padding-top:18px; text-align:center; border-top:1px solid var(--line-soft); font-size:12px; }
      body:has(.checkin-card) { background:radial-gradient(rgba(207,227,28,.11) .8px, transparent .8px) 0 0/18px 18px,#fbfcea; }
      body:has(.checkin-card) .checkin-card .card { animation:none; }
      @media (max-width:720px) {
        .wrap { padding:20px 16px 42px; }
        .hero h1 { font-size:30px; }
        .checkin-card { padding:24px 10px 54px; }
        .checkin-card .card { padding:30px 18px 24px; }
        .checkin-card h1 { font-size:28px; }
        .qr-box img { width:204px; height:204px; }
      }
    </style>
    ${extraHead}
  </head>
  <body>${body}</body>
  </html>`;
}

function adminPage(state, event, baseUrl, flash = '') {
  const total = event.checkins.length;
  const matched = event.checkins.filter((item) => item.matched).length;
  const winners = event.checkins.filter((item) => item.drawResult === 'won').length;
  const pending = event.checkins.filter((item) => item.drawResult === 'pending').length;
  const remainingPrizes = availablePrizeUnits(event).length;
  const checkinUrl = eventQuery('/checkin', event.id);
  const exportSigninsUrl = eventQuery('/api/export/signins.csv', event.id);
  const exportLotteryUrl = eventQuery('/api/export/lottery.csv', event.id);
  const qrcodeUrl = publicUrl(baseUrl, eventQuery('/api/qrcode', event.id));
  const scanTargetUrl = FEISHU_ENABLED
    ? publicUrl(baseUrl, eventQuery('/auth/feishu/start', event.id))
    : publicUrl(baseUrl, checkinUrl);
  const feishuNotice = FEISHU_ENABLED
    ? '<div class="setup-status enabled">飞书身份识别已启用，扫码后会先确认姓名和部门。</div>'
    : '<div class="setup-status disabled">飞书身份识别未启用：当前二维码不会自动识别姓名和部门。请配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 后重启服务。</div>';
  const clearUrl = appPath('/api/events/clear');
  const deleteUrl = appPath('/api/events/delete');

  const activities = state.events.map((item) => `
    <div class="activity-item ${item.id === event.id ? 'active' : ''}">
      <div>
        <strong>${escapeHtml(item.config.title)}</strong>
        <div class="muted">创建时间：${escapeHtml(item.createdAt)}</div>
        <div class="muted">签到 ${item.checkins.length} 人，奖品 ${item.prizes.length} 项</div>
      </div>
      <div class="row">
        <a class="btn ghost" href="${eventQuery('/', item.id)}">切换到这场</a>
        <a class="btn ghost" href="${eventQuery('/checkin', item.id)}" target="_blank">打开签到页</a>
        ${state.events.length > 1 ? `
          <form class="inline-form" method="post" action="${deleteUrl}" onsubmit="return confirm('确认删除这场活动及其全部数据吗？');">
            <input type="hidden" name="eventId" value="${escapeHtml(item.id)}" />
            <button type="submit" class="danger">删除活动</button>
          </form>
        ` : ''}
      </div>
    </div>
  `).join('');

  const recentRows = event.checkins
    .slice()
    .reverse()
    .slice(0, 20)
    .map((item) => `
      <tr>
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(item.department)}</td>
        <td>${escapeHtml(item.employeeType)}</td>
        <td>${escapeHtml(item.checkedInAt)}</td>
        <td>${escapeHtml(item.drawResult === 'won' ? '已中奖' : item.drawResult === 'not_won' ? '未中奖' : '待开奖')}</td>
        <td>${escapeHtml(item.prizeName || '')}</td>
      </tr>
    `).join('');

  const prizeRows = event.prizes.length
    ? event.prizes.map((item) => `
      <tr>
        <td>${renderPrizeAsset(item, true)}</td>
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(String(item.quantity))}</td>
        <td>${escapeHtml(String(item.remaining))}</td>
        <td>${escapeHtml(item.description || '')}</td>
        <td>
          <form class="inline-form" method="post" action="${appPath('/api/prizes/delete')}" onsubmit="return confirm('确认删除这个奖品吗？已开奖的历史记录不会受影响。');">
            <input type="hidden" name="eventId" value="${escapeHtml(event.id)}" />
            <input type="hidden" name="prizeId" value="${escapeHtml(item.id)}" />
            <button type="submit" class="danger">删除奖品</button>
          </form>
        </td>
      </tr>
    `).join('')
    : '<tr><td colspan="6" class="muted">暂无奖品数据</td></tr>';

  return pageShell(
    `${event.config.title} - 后台`,
    `
    <div class="wrap">
      <div class="hero">
        <div>
          <h1>${escapeHtml(event.config.title)}</h1>
          <p class="sub">${escapeHtml(event.config.subtitle)}</p>
        </div>
        <div class="hero-actions">
          <a class="btn ghost" href="${checkinUrl}" target="_blank">打开签到页</a>
          <a class="btn" href="${exportSigninsUrl}">导出签到表</a>
          <a class="btn secondary" href="${exportLotteryUrl}">导出开奖表</a>
          <form class="inline-form" method="post" action="${clearUrl}" onsubmit="return confirm('确认清空当前活动的名单、奖品、签到和开奖数据吗？');">
            <input type="hidden" name="eventId" value="${escapeHtml(event.id)}" />
            <button type="submit" class="danger">清空当前活动数据</button>
          </form>
        </div>
      </div>
      ${flash ? `<div class="notice neutral"><div class="notice-text">${escapeHtml(flash)}</div></div>` : ''}
      <div class="grid">
        <div class="card">
          <h2>活动管理</h2>
          <div class="activity-list">${activities}</div>
          <form method="post" action="${appPath('/api/events/create')}">
            <div class="spacer"></div>
            <input name="title" placeholder="新活动名称，例如：8月培训签到抽奖" />
            <div class="row">
              <button type="submit">创建新活动</button>
            </div>
          </form>
        </div>
        <div class="card">
          <h2>签到二维码</h2>
          <div class="qr-box">
            <img src="${qrcodeUrl}" alt="签到二维码" />
            <div class="center">
              <div class="muted">扫码地址</div>
              <div class="link">${escapeHtml(scanTargetUrl)}</div>
            </div>
            ${feishuNotice}
          </div>
        </div>
      </div>
      <div class="top-pair">
        <div class="card">
          <h2>当前活动概览</h2>
          <div class="stat">
            <div class="box"><span class="muted">签到人数</span><strong>${total}</strong></div>
            <div class="box"><span class="muted">已匹配</span><strong>${matched}</strong></div>
            <div class="box"><span class="muted">待开奖</span><strong>${pending}</strong></div>
            <div class="box"><span class="muted">剩余奖品</span><strong>${remainingPrizes}</strong></div>
          </div>
        </div>
        <div class="card action-center">
          <h2>开始抽选</h2>
          <form method="post" action="${appPath('/api/draw/start')}">
            <input type="hidden" name="eventId" value="${escapeHtml(event.id)}" />
            <input name="winnerCount" type="number" min="1" value="${remainingPrizes > 0 ? Math.min(remainingPrizes, 1) : 1}" />
            <div class="row">
              <button type="submit">开始抽选</button>
            </div>
          </form>
          <p class="sub">每次都会从当前活动的待开奖签到池中随机抽取，并按奖品池顺序发奖。</p>
        </div>
      </div>
      <div class="grid" style="margin-top:16px;">
        <div class="card">
          <h2>活动文案设置</h2>
          <form method="post" action="${appPath('/api/config')}">
            <input type="hidden" name="eventId" value="${escapeHtml(event.id)}" />
            <input name="title" value="${escapeHtml(event.config.title)}" placeholder="签到标题" />
            <div class="spacer"></div>
            <textarea name="subtitle" placeholder="页面说明">${escapeHtml(event.config.subtitle)}</textarea>
            <div class="spacer"></div>
            <input name="successText" value="${escapeHtml(event.config.successText)}" placeholder="签到成功文案" />
            <div class="spacer"></div>
            <input name="pendingText" value="${escapeHtml(event.config.pendingText)}" placeholder="待开奖文案" />
            <div class="spacer"></div>
            <input name="winText" value="${escapeHtml(event.config.winText)}" placeholder="中奖文案" />
            <div class="spacer"></div>
            <input name="noWinText" value="${escapeHtml(event.config.noWinText)}" placeholder="未中奖文案" />
            <div class="spacer"></div>
            <input name="footerText" value="${escapeHtml(event.config.footerText)}" placeholder="底部提示文案" />
            <div class="row">
              <button type="submit">保存文案</button>
            </div>
          </form>
        </div>
        <div class="card">
          <h2>导入公司名单文件</h2>
          <form method="post" action="${appPath('/api/roster/upload')}" enctype="multipart/form-data">
            <input type="hidden" name="eventId" value="${escapeHtml(event.id)}" />
            <div class="dropzone" id="roster-dropzone-${escapeHtml(event.id)}">
              <strong>把名单文件直接拖到这里</strong>
              <div class="muted">不限格式，系统会自动识别名单内容，优先读取姓名、部门、员工类型。</div>
              <input id="roster-input-${escapeHtml(event.id)}" type="file" name="rosterFiles" multiple />
            </div>
            <div class="spacer"></div>
            <textarea name="text" placeholder="也可以直接粘贴名单内容&#10;姓名,部门,员工类型&#10;张三,市场部,正职&#10;李四,研发部,实习生"></textarea>
            <div class="row">
              <button type="submit">导入名单</button>
            </div>
          </form>
          <script>
            (function () {
              const zone = document.getElementById('roster-dropzone-${escapeHtml(event.id)}');
              const input = document.getElementById('roster-input-${escapeHtml(event.id)}');
              if (!zone || !input) return;
              ['dragenter', 'dragover'].forEach(function (name) {
                zone.addEventListener(name, function (event) {
                  event.preventDefault();
                  zone.classList.add('active');
                });
              });
              ['dragleave', 'drop'].forEach(function (name) {
                zone.addEventListener(name, function (event) {
                  event.preventDefault();
                  zone.classList.remove('active');
                });
              });
              zone.addEventListener('drop', function (event) {
                if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
                  input.files = event.dataTransfer.files;
                }
              });
            })();
          </script>
        </div>
        <div class="card">
          <h2>拖拽上传奖品</h2>
          <form method="post" action="${appPath('/api/prizes/upload')}" enctype="multipart/form-data">
            <input type="hidden" name="eventId" value="${escapeHtml(event.id)}" />
            <div class="dropzone" id="dropzone-${escapeHtml(event.id)}">
              <strong>把奖品图片或文件直接拖到这里</strong>
              <div class="muted">也可以点击下方选择文件，文件仅作为奖品图片或附件。</div>
              <input id="prize-input-${escapeHtml(event.id)}" type="file" name="prizeFiles" multiple />
            </div>
            <div class="spacer"></div>
            <textarea name="prizeNames" placeholder="奖品名称（可自行填写；上传多个文件时每行一个，按上传顺序对应）"></textarea>
            <div class="spacer"></div>
            <input name="quantity" type="number" min="1" value="1" placeholder="每个文件默认数量" />
            <div class="spacer"></div>
            <input name="description" placeholder="奖品说明（可选）" />
            <div class="row">
              <button type="submit">上传到当前奖品池</button>
            </div>
          </form>
          <script>
            (function () {
              const zone = document.getElementById('dropzone-${escapeHtml(event.id)}');
              const input = document.getElementById('prize-input-${escapeHtml(event.id)}');
              if (!zone || !input) return;
              ['dragenter', 'dragover'].forEach(function (name) {
                zone.addEventListener(name, function (event) {
                  event.preventDefault();
                  zone.classList.add('active');
                });
              });
              ['dragleave', 'drop'].forEach(function (name) {
                zone.addEventListener(name, function (event) {
                  event.preventDefault();
                  zone.classList.remove('active');
                });
              });
              zone.addEventListener('drop', function (event) {
                if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
                  input.files = event.dataTransfer.files;
                }
              });
            })();
          </script>
        </div>
      </div>
      <div class="grid" style="margin-top:16px;">
        <div class="card">
          <h2>奖品池</h2>
          <table>
            <thead>
              <tr><th>文件</th><th>奖品</th><th>总数量</th><th>剩余</th><th>说明</th><th>操作</th></tr>
            </thead>
            <tbody>${prizeRows}</tbody>
          </table>
        </div>
        <div class="card">
          <h2>最近签到</h2>
          <table>
            <thead>
              <tr><th>姓名</th><th>部门</th><th>员工类型</th><th>签到时间</th><th>状态</th><th>奖品</th></tr>
            </thead>
            <tbody>${recentRows || '<tr><td colspan="6" class="muted">暂无签到数据</td></tr>'}</tbody>
          </table>
        </div>
      </div>
      <div class="card" style="margin-top:16px;">
        <h2>中奖人数</h2>
        <p class="sub">当前已中奖：${winners} 人</p>
      </div>
    </div>
    `
  );
}

function checkinPage(event, participant, baseUrl, pendingProfile = null) {
  const showSubtitle = !participant || participant.drawResult !== 'not_won';
  const pendingRefresh = participant && participant.drawResult === 'pending'
    ? `
      <script>
        setTimeout(function () {
          window.location.reload();
        }, 10000);
      </script>
    `
    : '';

  return pageShell(
    event.config.title,
    `
    <div class="checkin-card">
      <div class="card">
        <h1>${escapeHtml(event.config.title)}</h1>
        ${showSubtitle ? `<p class="sub">${escapeHtml(event.config.subtitle)}</p>` : ''}
        ${participantStatusBlock(event, participant)}
        ${pendingProfileBlock(event, pendingProfile)}
        ${participant || pendingProfile || FEISHU_ENABLED ? '' : '<div class="notice neutral setup-notice"><div class="notice-title">飞书签到暂未启用</div><div class="notice-text">当前服务没有读取到飞书应用配置，因此无法识别你的姓名和部门。请管理员配置飞书应用后重新生成二维码。</div></div>'}
        <p class="sub">${escapeHtml(event.config.footerText)}</p>
      </div>
    </div>
    `,
    pendingRefresh
  );
}

async function qrPngBuffer(text) {
  return QRCode.toBuffer(text, {
    type: 'png',
    margin: 1,
    width: 320,
    color: {
      dark: '#0f172a',
      light: '#ffffffff',
    },
  });
}

function resultPage(title, message, backUrl) {
  return pageShell(
    title,
    `<div class="wrap"><div class="card"><p>${escapeHtml(message)}</p><div class="row"><a class="btn" href="${backUrl}">返回后台</a></div></div></div>`
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  requestContext.enterWith({ basePath: inferBasePath(req, url.pathname) });
  url.pathname = stripPublicBasePath(url.pathname);
  const state = loadState();
  const baseUrl = getBaseUrl(req);
  const cookies = parseCookies(req);

  try {
    if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
      const fileName = decodeURIComponent(url.pathname.replace('/uploads/', ''));
      const targetPath = path.join(UPLOAD_DIR, safeFileName(fileName));
      if (!targetPath.startsWith(UPLOAD_DIR) || !fs.existsSync(targetPath)) {
        send(res, 404, '<h1>404</h1>');
        return;
      }
      const ext = fileExt(targetPath);
      const typeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
      };
      sendText(res, 200, fs.readFileSync(targetPath), typeMap[ext] || 'application/octet-stream');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendText(res, 200, JSON.stringify({ ok: true, service: 'checkin-lottery' }), 'application/json; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const requestedEventId = url.searchParams.get('event');
      const event = getCurrentEvent(state, requestedEventId);
      if (requestedEventId && event && event.id !== state.activeEventId) {
        state.activeEventId = event.id;
        saveState(state);
      }
      send(res, 200, adminPage(state, event, baseUrl));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/checkin') {
      const event = getCurrentEvent(state, url.searchParams.get('event'));
      const participant = findCheckinById(event, cookies[eventCookieName(event)]);
      const pendingToken = cookies[pendingFeishuCookieName(event)];
      const pendingEntry = pendingFeishuProfiles.get(pendingToken);
      const pendingProfile = pendingEntry && pendingEntry.expiresAt > Date.now() ? pendingEntry.profile : null;
      if (pendingEntry && !pendingProfile) pendingFeishuProfiles.delete(pendingToken);
      if (FEISHU_ENABLED && !participant && !pendingProfile) {
        res.writeHead(302, { Location: eventQuery('/auth/feishu/start', event.id) });
        res.end();
        return;
      }
      send(res, 200, checkinPage(event, participant, baseUrl, pendingProfile));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/result') {
      const event = getCurrentEvent(state, url.searchParams.get('event'));
      res.writeHead(302, { Location: eventQuery('/checkin', event.id) });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/auth/feishu/start') {
      const event = getCurrentEvent(state, url.searchParams.get('event'));
      if (!FEISHU_ENABLED) {
        res.writeHead(302, { Location: eventQuery('/checkin', event.id) });
        res.end();
        return;
      }
      res.writeHead(302, { Location: feishuAuthorizeUrl(event, baseUrl) });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/auth/feishu/callback') {
      const event = getCurrentEvent(state, url.searchParams.get('event') || url.searchParams.get('state'));
      if (!FEISHU_ENABLED) {
        res.writeHead(302, { Location: eventQuery('/checkin', event.id) });
        res.end();
        return;
      }

      const code = String(url.searchParams.get('code') || '').trim();
      if (!code) {
        res.writeHead(302, { Location: eventQuery('/checkin', event.id) });
        res.end();
        return;
      }

      try {
        const tokenData = await exchangeFeishuAuthCode(code);
        const userData = await fetchFeishuUserInfo(tokenData?.data?.access_token || tokenData?.access_token || '');
        const profile = enrichFeishuProfile(event, normalizeFeishuProfile(userData));
        const pendingToken = crypto.randomBytes(24).toString('hex');
        pendingFeishuProfiles.set(pendingToken, { profile, expiresAt: Date.now() + 10 * 60 * 1000 });
        const headers = {};
        setCookie(headers, pendingFeishuCookieName(event), pendingToken);
        send(res, 200, checkinPage(event, null, baseUrl, profile), headers);
        return;
      } catch {
        res.writeHead(302, { Location: eventQuery('/checkin', event.id) });
        res.end();
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/checkin/confirm') {
      const raw = await readRequestBody(req);
      const body = parseRequestBody(raw, req.headers['content-type'] || '');
      const event = getCurrentEvent(state, resolveEventId(url, body, state));
      const pendingToken = cookies[pendingFeishuCookieName(event)];
      const pendingEntry = pendingFeishuProfiles.get(pendingToken);
      if (!pendingEntry || pendingEntry.expiresAt <= Date.now()) {
        pendingFeishuProfiles.delete(pendingToken);
        send(res, 400, checkinPage(event, null, baseUrl).replace('</form>', '</form><div class="notice lose"><div class="notice-text">身份确认已过期，请重新进行飞书签到。</div></div>'));
        return;
      }

      const result = registerCheckinByProfile(event, pendingEntry.profile, 'feishu', nowText());
      pendingFeishuProfiles.delete(pendingToken);
      saveState(state);
      const headers = {};
      setCookie(headers, eventCookieName(event), result.record.id);
      clearCookie(headers, pendingFeishuCookieName(event));
      send(res, 200, checkinPage(event, result.record, baseUrl), headers);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/qrcode') {
      const event = getCurrentEvent(state, url.searchParams.get('event'));
      const target = FEISHU_ENABLED
        ? publicUrl(baseUrl, eventQuery('/auth/feishu/start', event.id))
        : publicUrl(baseUrl, eventQuery('/checkin', event.id));
      const buffer = await qrPngBuffer(target);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(buffer);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/export/signins.csv') {
      const event = getCurrentEvent(state, url.searchParams.get('event'));
      sendText(res, 200, exportSigninsCsv(event), 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="${event.slug}-signins.csv"`,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/export/lottery.csv') {
      const event = getCurrentEvent(state, url.searchParams.get('event'));
      sendText(res, 200, exportLotteryCsv(event), 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="${event.slug}-lottery.csv"`,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/events/create') {
      const raw = await readRequestBody(req);
      const body = parseRequestBody(raw, req.headers['content-type'] || '');
      const title = String(body.title || '').trim() || `培训活动 ${state.events.length + 1}`;
      const event = createEvent(state, title);
      saveState(state);
      send(res, 200, resultPage('活动已创建', `已创建新活动：${event.config.title}`, eventQuery('/', event.id)));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/events/clear') {
      const raw = await readRequestBody(req);
      const body = parseRequestBody(raw, req.headers['content-type'] || '');
      const event = getCurrentEvent(state, resolveEventId(url, body, state));
      clearEventData(event);
      saveState(state);
      const headers = {};
      clearCookie(headers, eventCookieName(event));
      send(res, 200, resultPage('数据已清空', '当前活动的数据已清空，可以重新开始新一轮签到。', eventQuery('/', event.id)), headers);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/events/delete') {
      const raw = await readRequestBody(req);
      const body = parseRequestBody(raw, req.headers['content-type'] || '');
      const event = getCurrentEvent(state, resolveEventId(url, body, state));
      const result = deleteEvent(state, event.id);
      if (!result.ok) {
        send(res, 200, resultPage('无法删除', result.message, eventQuery('/', event.id)));
        return;
      }
      saveState(state);
      const headers = {};
      clearCookie(headers, eventCookieName(result.removed));
      send(
        res,
        200,
        resultPage('活动已删除', `已删除活动：${result.removed.config.title}`, eventQuery('/', result.nextActive.id)),
        headers
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/config') {
      const raw = await readRequestBody(req);
      const body = parseRequestBody(raw, req.headers['content-type'] || '');
      const event = getCurrentEvent(state, resolveEventId(url, body, state));
      updateConfig(event, body);
      saveState(state);
      send(res, 200, resultPage('文案已保存', '当前活动的标题和页面文案已经保存。', eventQuery('/', event.id)));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/roster/import') {
      const raw = await readRequestBody(req);
      const body = parseRequestBody(raw, req.headers['content-type'] || '');
      const event = getCurrentEvent(state, resolveEventId(url, body, state));
      const count = addRosterFromText(event, body.text || '');
      const refreshed = refreshCheckinMatches(event);
      saveState(state);
      send(res, 200, resultPage('名单已导入', `当前活动新增或更新 ${count} 条名单，并回填了 ${refreshed} 条已签到记录。`, eventQuery('/', event.id)));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/roster/upload') {
      const buffer = await readRequestBuffer(req);
      const parsed = parseMultipartFormData(buffer, req.headers['content-type'] || '');
      const event = getCurrentEvent(state, resolveEventId(url, parsed.fields, state));
      const fileResult = addRosterFromFiles(event, parsed.files.filter((item) => item.fieldName === 'rosterFiles'));
      const textCount = addRosterFromText(event, parsed.fields.text || '');
      const refreshed = refreshCheckinMatches(event);
      saveState(state);
      const unreadableText = fileResult.unreadable.length
        ? ` 以下文件暂时没有识别出名单内容：${fileResult.unreadable.join('、')}。`
        : '';
      send(
        res,
        200,
        resultPage(
          '名单已导入',
          `当前活动新增或更新 ${fileResult.count + textCount} 条名单，并回填了 ${refreshed} 条已签到记录。${unreadableText}`,
          eventQuery('/', event.id)
        )
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/prizes/import') {
      const raw = await readRequestBody(req);
      const body = parseRequestBody(raw, req.headers['content-type'] || '');
      const event = getCurrentEvent(state, resolveEventId(url, body, state));
      const count = replacePrizesFromText(event, body.text || '');
      saveState(state);
      send(res, 200, resultPage('奖品池已更新', `当前活动共导入 ${count} 个奖品项目。`, eventQuery('/', event.id)));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/prizes/upload') {
      const buffer = await readRequestBuffer(req);
      const parsed = parseMultipartFormData(buffer, req.headers['content-type'] || '');
      const event = getCurrentEvent(state, resolveEventId(url, parsed.fields, state));
      const count = saveUploadedPrizeFiles(
        event,
        parsed.files.filter((item) => item.fieldName === 'prizeFiles'),
        parsed.fields.quantity,
        parsed.fields.description,
        parsed.fields.prizeNames
      );
      saveState(state);
      send(res, 200, resultPage('奖品已上传', `当前活动新增 ${count} 个奖品文件。`, eventQuery('/', event.id)));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/prizes/delete') {
      const raw = await readRequestBody(req);
      const body = parseRequestBody(raw, req.headers['content-type'] || '');
      const event = getCurrentEvent(state, resolveEventId(url, body, state));
      const result = deletePrize(event, String(body.prizeId || '').trim());
      if (result.ok) saveState(state);
      send(res, 200, resultPage(result.ok ? '奖品已删除' : '删除失败', result.ok ? `已从当前活动奖品池删除“${result.name}”。` : result.message, eventQuery('/', event.id)));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/checkin') {
      const raw = await readRequestBody(req);
      const body = parseRequestBody(raw, req.headers['content-type'] || '');
      const event = getCurrentEvent(state, resolveEventId(url, body, state));
      const result = registerCheckin(event, body.name || '', 'single', nowText());
      if (!result.ok) {
        send(res, 400, checkinPage(event, null, baseUrl).replace('</form>', `</form><div class="notice lose"><div class="notice-text">${escapeHtml(result.message)}</div></div>`));
        return;
      }
      saveState(state);
      const headers = {};
      setCookie(headers, eventCookieName(event), result.record.id);
      send(res, 200, checkinPage(event, result.record, baseUrl), headers);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/draw/start') {
      const raw = await readRequestBody(req);
      const body = parseRequestBody(raw, req.headers['content-type'] || '');
      const event = getCurrentEvent(state, resolveEventId(url, body, state));
      const result = drawWinners(event, body.winnerCount || 0);
      saveState(state);
      const winnerText = result.winners.length
        ? result.winners.map((item) => `${item.name}：${item.prizeName}`).join('、')
        : '本次没有抽出中奖人。';
      send(res, 200, resultPage('开奖完成', winnerText, eventQuery('/', event.id)));
      return;
    }

    send(res, 404, '<h1>404</h1>');
  } catch (error) {
    send(res, 500, `<pre>${escapeHtml(error.stack || error.message)}</pre>`);
  }
});

server.listen(PORT, () => {
  console.log(`Check-in lottery app running at http://localhost:${PORT}`);
});
