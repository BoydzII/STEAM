/**
 * กระดานไอเดียออนไลน์ (หลายคน) — backend สำหรับ STEAM Active Learning Designer
 *
 * วิธีติดตั้ง (ทำครั้งเดียว)
 * 1. สร้าง Google Sheets ใหม่ 1 ไฟล์ → เมนู ส่วนขยาย → Apps Script
 * 2. ลบโค้ดเดิมใน Code.gs แล้ววางไฟล์นี้ทั้งหมด → กดบันทึก
 * 3. ทำให้ใช้งานได้ (Deploy) → การทำให้ใช้งานได้รายการใหม่ → ประเภท: เว็บแอป
 *    - เรียกใช้ในฐานะ: ฉัน
 *    - ผู้ที่มีสิทธิ์เข้าถึง: ทุกคน
 * 4. คัดลอก URL ที่ลงท้ายด้วย /exec ไปใส่ในค่าคงที่ ROOM_API ใน index.html
 *
 * ชีตที่ระบบสร้างเองอัตโนมัติ: rooms, ideas
 */

var ROOM_COLS = ['code', 'name', 'topics', 'createdAt', 'rev', 'creator'];
var IDEA_COLS = ['id', 'code', 'topicId', 'text', 'author', 'stars', 'createdAt', 'deleted'];
var COLOR_KEYS = ['yellow', 'blue', 'green', 'pink', 'purple', 'orange'];
var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
var CACHE_SECS = 21600; // 6 ชั่วโมง

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'room_get') return json_(roomGet_(p.code, p.rev));
    return json_({ ok: true, msg: 'room-board api' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad json' });
  }
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (err) {
    return json_({ ok: false, error: 'ระบบไม่ว่าง ลองใหม่อีกครั้ง' });
  }
  try {
    switch (body.action) {
      case 'create_room': return json_(createRoom_(body));
      case 'edit_topics': return json_(editTopics_(body));
      case 'add_idea': return json_(addIdea_(body));
      case 'edit_idea': return json_(editIdea_(body));
      case 'del_idea': return json_(delIdea_(body));
      case 'star': return json_(toggleStar_(body));
      default: return json_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- actions ---------- */

function roomGet_(code, rev) {
  code = cleanCode_(code);
  var cache = CacheService.getScriptCache();
  var cachedRev = cache.get('rev_' + code);
  if (cachedRev !== null && rev !== undefined && String(rev) === cachedRev) {
    return { ok: true, same: true, rev: Number(cachedRev) };
  }
  var state = cache.get('state_' + code);
  if (state) return { ok: true, state: JSON.parse(state) };
  var built = buildState_(code);
  if (!built) return { ok: false, error: 'ไม่พบกลุ่มรหัสนี้' };
  putCache_(built);
  return { ok: true, state: built };
}

function createRoom_(b) {
  var sh = sheet_('rooms', ROOM_COLS);
  var name = cleanText_(b.name, 60) || 'กระดานไอเดีย';
  var topics = cleanTopics_(b.topics);
  if (!topics.length) throw new Error('ต้องมีอย่างน้อย 1 หัวข้อ');
  var existing = {};
  colValues_(sh, 1).forEach(function (c) { existing[c] = true; });
  var code;
  for (var i = 0; i < 50; i++) {
    code = '';
    for (var j = 0; j < 6; j++) code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    if (!existing[code]) break;
  }
  sh.appendRow([code, name, JSON.stringify(topics), String(new Date().getTime()), 1, cleanText_(b.author, 40)]);
  var state = buildState_(code);
  putCache_(state);
  return { ok: true, state: state };
}

function editTopics_(b) {
  var code = cleanCode_(b.code);
  var r = findRow_(sheet_('rooms', ROOM_COLS), 1, code);
  if (!r) throw new Error('ไม่พบกลุ่มรหัสนี้');
  var topics = cleanTopics_(b.topics);
  if (!topics.length) throw new Error('ต้องมีอย่างน้อย 1 หัวข้อ');
  var keep = {};
  topics.forEach(function (t) { keep[t.id] = true; });
  var ideas = loadIdeas_(code);
  for (var i = 0; i < ideas.length; i++) {
    if (!keep[ideas[i].topicId]) throw new Error('ลบหัวข้อที่ยังมีไอเดียอยู่ไม่ได้ ย้ายหรือลบไอเดียก่อน');
  }
  r.sheet.getRange(r.row, 2, 1, 2).setValues([[cleanText_(b.name, 60) || r.values[1], JSON.stringify(topics)]]);
  return bump_(code);
}

function addIdea_(b) {
  var code = cleanCode_(b.code);
  var room = findRow_(sheet_('rooms', ROOM_COLS), 1, code);
  if (!room) throw new Error('ไม่พบกลุ่มรหัสนี้');
  var text = cleanText_(b.text, 500);
  if (!text) throw new Error('ไอเดียว่าง');
  var topicId = cleanId_(b.topicId);
  if (!topicExists_(room.values[2], topicId)) throw new Error('ไม่พบหัวข้อนี้');
  var id = 'i' + new Date().getTime() + Math.floor(Math.random() * 1000);
  sheet_('ideas', IDEA_COLS).appendRow([id, code, topicId, text, cleanText_(b.author, 40) || 'ไม่ระบุชื่อ', '[]', String(new Date().getTime()), false]);
  return bump_(code);
}

function editIdea_(b) {
  var code = cleanCode_(b.code);
  var r = ideaRow_(code, b.id);
  if (b.text !== undefined) {
    var text = cleanText_(b.text, 500);
    if (!text) throw new Error('ไอเดียว่าง');
    r.sheet.getRange(r.row, 4).setValue(text);
  }
  if (b.topicId !== undefined) {
    var room = findRow_(sheet_('rooms', ROOM_COLS), 1, code);
    var topicId = cleanId_(b.topicId);
    if (!topicExists_(room.values[2], topicId)) throw new Error('ไม่พบหัวข้อนี้');
    r.sheet.getRange(r.row, 3).setValue(topicId);
  }
  return bump_(code);
}

function delIdea_(b) {
  var code = cleanCode_(b.code);
  var r = ideaRow_(code, b.id);
  r.sheet.getRange(r.row, 8).setValue(true);
  return bump_(code);
}

function toggleStar_(b) {
  var code = cleanCode_(b.code);
  var r = ideaRow_(code, b.id);
  var cid = cleanId_(b.clientId);
  if (!cid) throw new Error('no clientId');
  var stars = parseArr_(r.values[5]);
  var at = stars.indexOf(cid);
  if (at >= 0) stars.splice(at, 1); else stars.push(cid);
  r.sheet.getRange(r.row, 6).setValue(JSON.stringify(stars));
  return bump_(code);
}

/* ---------- state ---------- */

function bump_(code) {
  var r = findRow_(sheet_('rooms', ROOM_COLS), 1, code);
  var rev = (Number(r.values[4]) || 0) + 1;
  r.sheet.getRange(r.row, 5).setValue(rev);
  var state = buildState_(code);
  putCache_(state);
  return { ok: true, state: state };
}

function buildState_(code) {
  var r = findRow_(sheet_('rooms', ROOM_COLS), 1, code);
  if (!r) return null;
  return {
    code: code,
    name: unq_(r.values[1]),
    topics: parseArr_(r.values[2]).map(function (t) { t.name = unq_(t.name); return t; }),
    rev: Number(r.values[4]) || 1,
    ideas: loadIdeas_(code)
  };
}

function loadIdeas_(code) {
  var sh = sheet_('ideas', IDEA_COLS);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, IDEA_COLS.length).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i];
    if (String(v[1]) !== code || String(v[7]).toUpperCase() === 'TRUE') continue;
    out.push({
      id: String(v[0]),
      topicId: String(v[2]),
      text: unq_(v[3]),
      author: unq_(v[4]),
      stars: parseArr_(v[5]),
      createdAt: Number(v[6]) || 0
    });
  }
  return out;
}

function putCache_(state) {
  var cache = CacheService.getScriptCache();
  var s = JSON.stringify(state);
  var pairs = { };
  pairs['rev_' + state.code] = String(state.rev);
  if (s.length < 95000) pairs['state_' + state.code] = s;
  else cache.remove('state_' + state.code);
  cache.putAll(pairs, CACHE_SECS);
}

/* ---------- helpers ---------- */

function sheet_(name, cols) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange('A:Z').setNumberFormat('@'); // เก็บเป็นข้อความ รหัสอย่าง 234567 จะได้ไม่กลายเป็นตัวเลข
    sh.appendRow(cols);
    sh.setFrozenRows(1);
  }
  return sh;
}

function colValues_(sh, col) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, col, last - 1, 1).getValues().map(function (r) { return String(r[0]); });
}

function findRow_(sh, col, value) {
  if (!value) return null;
  var last = sh.getLastRow();
  if (last < 2) return null;
  var hit = sh.getRange(2, col, last - 1, 1).createTextFinder(String(value)).matchEntireCell(true).findNext();
  if (!hit) return null;
  var row = hit.getRow();
  return { sheet: sh, row: row, values: sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0] };
}

function ideaRow_(code, id) {
  var r = findRow_(sheet_('ideas', IDEA_COLS), 1, cleanId_(id));
  if (!r || String(r.values[1]) !== code) throw new Error('ไม่พบไอเดียนี้');
  return r;
}

function topicExists_(topicsJson, topicId) {
  var topics = parseArr_(topicsJson);
  for (var i = 0; i < topics.length; i++) if (topics[i].id === topicId) return true;
  return false;
}

function cleanTopics_(list) {
  if (!(list instanceof Array)) return [];
  var out = [], seen = {};
  for (var i = 0; i < list.length && out.length < 8; i++) {
    var t = list[i] || {};
    var name = cleanText_(t.name, 40);
    if (!name) continue;
    var id = cleanId_(t.id) || ('t' + i + '_' + new Date().getTime());
    if (seen[id]) continue;
    seen[id] = true;
    out.push({ id: id, name: name, color: COLOR_KEYS.indexOf(t.color) >= 0 ? t.color : COLOR_KEYS[i % COLOR_KEYS.length] });
  }
  return out;
}

function cleanCode_(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); }
function cleanId_(s) { return String(s || '').replace(/[^\w-]/g, '').slice(0, 40); }
function cleanText_(s, max) {
  var t = String(s || '').replace(/^\s+|\s+$/g, '').slice(0, max);
  return /^[=+\-@]/.test(t) ? "'" + t : t; // กันไม่ให้ชีตตีความเป็นสูตร
}
function unq_(s) { s = String(s); return /^'[=+\-@]/.test(s) ? s.slice(1) : s; }
function parseArr_(s) { try { var a = JSON.parse(s || '[]'); return a instanceof Array ? a : []; } catch (e) { return []; } }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
