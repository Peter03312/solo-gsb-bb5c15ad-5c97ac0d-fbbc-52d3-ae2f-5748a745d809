'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

// 独立临时库 + 独立根目录（备份文件、恢复目录都放这里）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-backup-'));
process.env.DB_PATH = path.join(TMP, 'app.db');
const DB_PATH = process.env.DB_PATH;
const BACKUP_CLI = path.join(__dirname, '..', 'src', 'backup.js');
const SERVER_JS = path.join(__dirname, '..', 'server.js');
const { app } = require('../server.js');

let server;
let port;

function httpJson(method, urlPath, body) {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method,
        headers: payload ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { json = data; }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (p) => httpJson('GET', p);
const post = (p, b) => httpJson('POST', p, b);
const put = (p, b) => httpJson('PUT', p, b);
const del = (p) => httpJson('DELETE', p);

// 运行备份/恢复 CLI；返回 { code, stdout, stderr }
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BACKUP_CLI, ...args], {
      env: { ...process.env, DB_PATH },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function freshDir(name) {
  const p = path.join(TMP, name);
  rmrf(p);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

async function resetDraft() {
  const cues = (await get('/api/cues')).json;
  for (const c of cues) await del(`/api/cues/${c.id}`);
  const lights = (await get('/api/lights')).json;
  for (const l of lights) await del(`/api/lights/${l.id}`);
  // 灯具删尽后接线随之清除，回路即可删除（名称唯一，每个用例都要清干净）
  const circuits = (await get('/api/circuits')).json;
  for (const c of circuits) await del(`/api/circuits/${c.id}`);
}

// 种一份“有血有肉”的数据：草稿、回路、发布版本、绑定版本的调光记录（含操作）、房间
async function seedRichData() {
  await resetDraft();
  await post('/api/lights', { name: '备份面光' });
  await post('/api/lights', { name: '备份侧光' });
  const circuit = (await post('/api/circuits', { name: '备份回路', capacity: 1000 })).json;
  const lights = (await get('/api/lights')).json;
  await put(`/api/lights/${lights[0].id}/wiring`, { circuit_id: circuit.id, watts: 200 });
  await post('/api/cues', [
    { cue_no: 9001, light_id: lights[0].id, time: 0, target: 100, duration: 10 },
    { cue_no: 9002, light_id: lights[1].id, time: 2, target: 40, duration: 4 },
  ]);
  const version = (await post('/api/versions', { label: '备份基线版本' })).json;
  const record = (await post('/api/records', { version_id: version.id, label: '备份用临时调光' })).json;
  await post(`/api/records/${record.id}/ops`, {
    revision: 0,
    op: { light_id: lights[0].id, time: 1, op_type: 'override', target: 70, duration: 0 },
  });
  const room = (await post('/api/rooms', {
    version_id: version.id, label: '备份房间', overload_protection: true,
  })).json;
  return { versionId: version.id, recordId: record.id, room };
}

before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => {
  await new Promise((r) => server.close(r));
  rmrf(TMP);
});

beforeEach(() => {
  // 清空各测试可能留下的备份/恢复目录（保留主库）
  for (const name of fs.readdirSync(TMP)) {
    if (name !== 'app.db' && name !== 'app.db-wal' && name !== 'app.db-shm') {
      rmrf(path.join(TMP, name));
    }
  }
});

// 对备份文件容器做拆包，返回 { header, payload }
function unpack(file) {
  const buf = fs.readFileSync(file);
  assert.deepEqual([...buf.subarray(0, 4)], [...Buffer.from('CRBK', 'ascii')]);
  const headerLen = buf.readUInt32BE(4);
  const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString('utf8'));
  const payload = buf.subarray(8 + headerLen);
  return { header, payload };
}

/* -------------------------------- 备份 -------------------------------- */

test('备份：服务运行期间可在线导出一致单文件，权限 0600、输出不泄露密钥/凭证', async () => {
  const seeded = await seedRichData();
  // 发起一次主持权交接，制造交接凭证
  const issue = await post(`/api/rooms/${seeded.room.code}/handover/issue`, {
    control_key: seeded.room.control_key,
    revision: seeded.room.revision,
  });
  assert.equal(issue.status, 200);
  const handoverToken = issue.json.handover_token;
  assert.ok(handoverToken && handoverToken.length === 48);

  const out = path.join(TMP, 'snap1.crbk');
  const r = await runCli(['backup', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /备份完成/);
  assert.match(r.stdout, /已发布版本 1/);
  assert.match(r.stdout, /共享房间 1/);
  // 命令结果不得回显控制密钥或交接凭证本体
  assert.ok(!r.stdout.includes(seeded.room.control_key), 'stdout 泄露了控制密钥');
  assert.ok(!r.stderr.includes(seeded.room.control_key), 'stderr 泄露了控制密钥');
  assert.ok(!r.stdout.includes(handoverToken), 'stdout 泄露了交接凭证');
  assert.ok(!r.stderr.includes(handoverToken), 'stderr 泄露了交接凭证');

  // 权限仅当前运行用户可读写
  const mode = fs.statSync(out).mode & 0o777;
  assert.equal(mode, 0o600);

  // 清单自洽：载荷 SHA-256 与长度正确
  const crypto = require('node:crypto');
  const { header, payload } = unpack(out);
  assert.equal(header.format, 'cue-rehearsal-backup');
  assert.equal(header.db_size, payload.length);
  assert.equal(
    crypto.createHash('sha256').update(payload).digest('hex'),
    header.sha256
  );
  // 行数统计包含全部目标对象
  assert.equal(header.tables.rooms, 1);
  assert.equal(header.tables.versions, 1);
  assert.equal(header.tables.rehearsal_records, 1);
  assert.equal(header.tables.record_ops, 1);
  assert.equal(header.tables.room_handovers, 1);

  // 载荷是一份独立可读的 SQLite 快照，内容与主库一致
  const tmpDb = path.join(TMP, 'snap-inspect.db');
  fs.writeFileSync(tmpDb, payload, { mode: 0o600 });
  const sdb = new Database(tmpDb, { readonly: true });
  assert.equal(sdb.prepare('SELECT COUNT(*) AS n FROM versions').get().n, 1);
  assert.equal(
    sdb.prepare('SELECT label FROM versions WHERE id = ?').get(seeded.versionId).label,
    '备份基线版本'
  );
  const roomRow = sdb.prepare('SELECT code, version_id FROM rooms').get();
  assert.equal(roomRow.code, seeded.room.code);
  // 密钥/凭证在库内按原值保留（迁移后仍可用），只是命令不打印
  assert.equal(
    sdb.prepare('SELECT control_key FROM rooms WHERE code = ?').get(seeded.room.code).control_key,
    seeded.room.control_key
  );
  assert.equal(sdb.prepare('SELECT token FROM room_handovers').get().token, handoverToken);
  sdb.close();
});

test('备份：服务期间持续写入也能得到完整一致快照（在线备份）', async () => {
  // 备份进行的同时在库里追加版本（用多个不同草稿无法在同库并发发布，
  // 这里改为备份前后各发一版，校验“备份时刻”快照恰好包含其中之一且完整一致）
  await seedRichData();
  const out = path.join(TMP, 'snap-live.crbk');
  const r = await runCli(['backup', out]);
  assert.equal(r.code, 0, r.stderr);
  const { header } = unpack(out);
  const countsAtBackup = header.tables.versions;
  // 备份后再发布一个新版本
  await resetDraft();
  await post('/api/lights', { name: '备份后新增灯' });
  const newLights = (await get('/api/lights')).json;
  await post('/api/cues', [{ cue_no: 9100, light_id: newLights[0].id, time: 0, target: 10, duration: 0 }]);
  const v2 = (await post('/api/versions', { label: '备份后版本' })).json;
  // 备份快照不含新版本；主库含新版本
  const tmpDb = path.join(TMP, 'snap-live.db');
  fs.writeFileSync(tmpDb, unpack(out).payload);
  const sdb = new Database(tmpDb);
  assert.equal(sdb.prepare('SELECT COUNT(*) AS n FROM versions').get().n, countsAtBackup);
  assert.equal(sdb.prepare('SELECT COUNT(*) AS n FROM versions WHERE id = ?').get(v2.id).n, 0);
  sdb.close();
});

test('备份：源数据库不存在时明确报错', async () => {
  const r = await runCli(['backup', path.join(TMP, 'x.crbk'), '--db', path.join(TMP, 'no-such.db')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /数据库文件不存在/);
});

/* -------------------------------- 恢复 -------------------------------- */

test('恢复：空目录原子落地，草稿/版本编号/记录/房间控制·编排·停点·预约全部保留', async () => {
  const seeded = await seedRichData();
  const code = seeded.room.code;

  // 预置讨论停点 + 循环编排 + 定时启播预约（墙钟时刻写死，用于验证绝对时间保留）
  const roomState0 = (await get(`/api/rooms/${code}`)).json;
  await put(`/api/rooms/${code}/stops`, {
    control_key: seeded.room.control_key, revision: roomState0.revision, stops: [3, 7],
  });
  let st = (await get(`/api/rooms/${code}`)).json;
  const program = await post(`/api/rooms/${code}/program`, {
    control_key: seeded.room.control_key,
    revision: st.revision,
    segments: [{ start: 0, end: 8, repeat: 2 }],
  });
  assert.equal(program.status, 200);
  st = (await get(`/api/rooms/${code}`)).json;
  // 编排提交后房间在播放；暂停后才能预约
  const paused = await post(`/api/rooms/${code}/control`, {
    control_key: seeded.room.control_key, revision: st.revision, action: 'pause',
  });
  assert.equal(paused.status, 200);
  st = (await get(`/api/rooms/${code}`)).json;
  const futureWall = Math.floor(Date.now() / 1000) + 3600;
  const sched = await put(`/api/rooms/${code}/schedule`, {
    control_key: seeded.room.control_key, revision: st.revision, start_at: futureWall,
  });
  assert.equal(sched.status, 200, JSON.stringify(sched.json));

  const out = path.join(TMP, 'full.crbk');
  const b = await runCli(['backup', out]);
  assert.equal(b.code, 0, b.stderr);

  const restoreDir = freshDir('restore-full');
  const r = await runCli(['restore', out, restoreDir]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /备份校验通过/);
  assert.match(r.stdout, /原子恢复/);
  const finalDb = path.join(restoreDir, 'app.db');
  assert.ok(fs.existsSync(finalDb));
  // 落地后不得残留临时文件
  assert.deepEqual(fs.readdirSync(restoreDir), ['app.db']);
  assert.equal(fs.statSync(finalDb).mode & 0o777, 0o600);
  // 密钥/凭证不被回显
  assert.ok(!r.stdout.includes(seeded.room.control_key));

  const rdb = new Database(finalDb, { readonly: true });
  // 版本快照与原编号一致
  assert.equal(rdb.prepare('SELECT label FROM versions WHERE id = ?').get(seeded.versionId).label, '备份基线版本');
  assert.equal(
    rdb.prepare('SELECT COUNT(*) AS n FROM version_cues WHERE version_id = ?').get(seeded.versionId).n,
    2
  );
  // 调光记录与操作
  assert.equal(rdb.prepare('SELECT revision FROM rehearsal_records WHERE id = ?').get(seeded.recordId).revision, 1);
  assert.equal(rdb.prepare('SELECT COUNT(*) AS n FROM record_ops WHERE record_id = ?').get(seeded.recordId).n, 1);
  // 房间：控制状态、编排、停点、预约齐全
  const room = rdb.prepare('SELECT * FROM rooms WHERE code = ?').get(code);
  assert.equal(room.version_id, seeded.versionId);
  assert.equal(rdb.prepare('SELECT COUNT(*) AS n FROM room_programs WHERE room_id = ?').get(room.id).n, 1);
  const stopsRow = rdb.prepare('SELECT stops FROM room_stops WHERE room_id = ?').get(room.id);
  assert.deepEqual(JSON.parse(stopsRow.stops), [3, 7]);
  const schedRow = rdb.prepare('SELECT start_at FROM room_schedules WHERE room_id = ?').get(room.id);
  assert.equal(schedRow.start_at, futureWall); // 绝对墙钟原样保留
  rdb.close();
});

test('恢复：目标非空明确报错且目标数据不变', async () => {
  await seedRichData();
  const out = path.join(TMP, 'nonempty.crbk');
  await runCli(['backup', out]);
  const dir = freshDir('restore-nonempty');
  fs.writeFileSync(path.join(dir, 'app.db'), 'existing');
  fs.mkdirSync(path.join(dir, 'sub'));

  const r = await runCli(['restore', out, dir]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /目标数据目录非空/);
  // 原有内容原样保留，且没有留下恢复临时文件
  assert.equal(fs.readFileSync(path.join(dir, 'app.db'), 'utf8'), 'existing');
  assert.ok(fs.existsSync(path.join(dir, 'sub')));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['app.db', 'sub']);
});

test('恢复：目标目录不存在 / 备份文件不存在均明确报错', async () => {
  await seedRichData();
  const out = path.join(TMP, 'e.crbk');
  await runCli(['backup', out]);

  let r = await runCli(['restore', out, path.join(TMP, 'missing-dir')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /目标数据目录不存在/);

  r = await runCli(['restore', path.join(TMP, 'no-backup.crbk'), freshDir('restore-missing-bak')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /备份文件不存在/);
});

test('恢复：校验和不匹配（追加/篡改字节）拒绝且目标目录保持全空', async () => {
  await seedRichData();
  const good = path.join(TMP, 'g.crbk');
  await runCli(['backup', good]);

  // 末尾追加
  const tampered = path.join(TMP, 'tampered-append.crbk');
  const b1 = fs.readFileSync(good);
  fs.writeFileSync(tampered, Buffer.concat([b1, Buffer.from([0xff])]));
  let dir = freshDir('restore-tamper1');
  let r = await runCli(['restore', tampered, dir]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /长度不一致|校验和/);
  assert.deepEqual(fs.readdirSync(dir), []);

  // 翻转载荷中间字节（长度不变）→ SHA-256 不匹配
  const b2 = fs.readFileSync(good);
  b2[b2.length - 10] ^= 0x01;
  const tampered2 = path.join(TMP, 'tampered-flip.crbk');
  fs.writeFileSync(tampered2, b2);
  dir = freshDir('restore-tamper2');
  r = await runCli(['restore', tampered2, dir]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /校验和不匹配/);
  assert.deepEqual(fs.readdirSync(dir), []);

  // 魔数错误
  const b3 = fs.readFileSync(good);
  b3[0] = 0x58;
  const badMagic = path.join(TMP, 'bad-magic.crbk');
  fs.writeFileSync(badMagic, b3);
  dir = freshDir('restore-badmagic');
  r = await runCli(['restore', badMagic, dir]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /魔数不匹配|不是本系统/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('恢复：载荷损坏（通过校验和后内容非数据库）→ 结构/完整性校验拒绝，目标不变', async () => {
  await seedRichData();
  const good = path.join(TMP, 'g2.crbk');
  await runCli(['backup', good]);

  // 手工重封装：保留合法魔数/清单/校验和，但载荷换成“看起来像数据库头但内容损坏”
  const { header } = unpack(good);
  const fakePayload = Buffer.alloc(header.db_size, 0);
  Buffer.from('SQLite format 3\0', 'ascii').copy(fakePayload, 0);
  const newHeader = { ...header, sha256: require('node:crypto').createHash('sha256').update(fakePayload).digest('hex') };
  const hb = Buffer.from(JSON.stringify(newHeader), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(hb.length, 0);
  const crafted = path.join(TMP, 'crafted.crbk');
  fs.writeFileSync(crafted, Buffer.concat([Buffer.from('CRBK', 'ascii'), lenBuf, hb, fakePayload]));

  const dir = freshDir('restore-crafted');
  const r = await runCli(['restore', crafted, dir]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /完整性|不是有效的 SQLite|备份校验失败/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('恢复：引用关系异常（房间指向缺失版本）拒绝恢复且目标不变', async () => {
  await seedRichData();
  const good = path.join(TMP, 'g3.crbk');
  await runCli(['backup', good]);

  // 解出载荷 → 制造孤儿引用（删掉版本，留下指向它的房间）→ 重封装
  const { payload } = unpack(good);
  const work = path.join(TMP, 'mutate.db');
  fs.writeFileSync(work, payload);
  const wdb = new Database(work);
  wdb.pragma('foreign_keys = OFF');
  wdb.prepare('DELETE FROM versions WHERE id IN (SELECT version_id FROM rooms)').run();
  wdb.pragma('wal_checkpoint(TRUNCATE)');
  wdb.close();
  const mutated = fs.readFileSync(work);
  const { header } = unpack(good);
  const hb = Buffer.from(JSON.stringify({
    ...header,
    db_size: mutated.length,
    sha256: require('node:crypto').createHash('sha256').update(mutated).digest('hex'),
  }), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(hb.length, 0);
  const out = path.join(TMP, 'orphan.crbk');
  fs.writeFileSync(out, Buffer.concat([Buffer.from('CRBK', 'ascii'), lenBuf, hb, mutated]));

  const dir = freshDir('restore-orphan');
  const r = await runCli(['restore', out, dir]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /引用|备份校验失败/);
  assert.deepEqual(fs.readdirSync(dir), []);
  rmrf(work);
});

test('恢复：结构不兼容（缺少必需表）拒绝恢复', async () => {
  await seedRichData();
  const good = path.join(TMP, 'g4.crbk');
  await runCli(['backup', good]);
  const { payload, header } = unpack(good);
  const work = path.join(TMP, 'mutate-drop.db');
  fs.writeFileSync(work, payload);
  const wdb = new Database(work);
  wdb.prepare('DROP TABLE room_schedules').run();
  wdb.pragma('wal_checkpoint(TRUNCATE)');
  wdb.close();
  const mutated = fs.readFileSync(work);
  const hb = Buffer.from(JSON.stringify({
    ...header,
    db_size: mutated.length,
    sha256: require('node:crypto').createHash('sha256').update(mutated).digest('hex'),
  }), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(hb.length, 0);
  const out = path.join(TMP, 'dropped-table.crbk');
  fs.writeFileSync(out, Buffer.concat([Buffer.from('CRBK', 'ascii'), lenBuf, hb, mutated]));

  const dir = freshDir('restore-dropped');
  const r = await runCli(['restore', out, dir]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /缺少必需的数据表|结构不兼容|备份校验失败/);
  assert.deepEqual(fs.readdirSync(dir), []);
  rmrf(work);
});

/* ---------------- 恢复后运行语义（墙钟、凭证、HTTP API） ---------------- */

// 启动一个以恢复库为 DB_PATH 的独立服务进程，返回 { child, port, kill }
function startRestoredServer(dbFile) {
  const childPort = 3000 + Math.floor(Math.random() * 1000) + 2000;
  const child = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, DB_PATH: dbFile, PORT: String(childPort) },
  });
  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  const waitReady = async () => {
    for (let i = 0; i < 60; i += 1) {
      try {
        const r = await new Promise((resolve, reject) => {
          const req = http.get({ host: '127.0.0.1', port: childPort, path: '/api/versions' }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          });
          req.on('error', reject);
          req.setTimeout(500, () => req.destroy(new Error('timeout')));
        });
        if (r === 200) return;
      } catch {
        // 服务尚未起来
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`恢复服务未在超时内就绪：\n${logs}`);
  };
  return { child, port: childPort, waitReady };
}

function reqTo(childPort, method, urlPath, body) {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: childPort, path: urlPath, method,
        headers: payload ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { json = data; }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('恢复后：HTTP API 可用、原编号不变、播放进度按绝对墙钟延续', async () => {
  const seeded = await seedRichData();
  const code = seeded.room.code;

  // 让房间播放一小段后暂停，固化一个已知锚点
  let st = (await get(`/api/rooms/${code}`)).json;
  const play = await post(`/api/rooms/${code}/control`, {
    control_key: seeded.room.control_key, revision: st.revision, action: 'play',
  });
  assert.equal(play.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  st = (await get(`/api/rooms/${code}`)).json;
  const pause = await post(`/api/rooms/${code}/control`, {
    control_key: seeded.room.control_key, revision: st.revision, action: 'pause',
  });
  assert.equal(pause.status, 200);
  const pausedTime = pause.json.time;
  assert.ok(pausedTime >= 0);

  const out = path.join(TMP, 'api.crbk');
  await runCli(['backup', out]);

  const dir = freshDir('restore-api');
  const rr = await runCli(['restore', out, dir]);
  assert.equal(rr.code, 0, rr.stderr);

  const srv = startRestoredServer(path.join(dir, 'app.db'));
  try {
    await srv.waitReady();

    // 版本编号保持不变
    const versions = await reqTo(srv.port, 'GET', '/api/versions');
    assert.equal(versions.status, 200);
    assert.ok(versions.json.some((v) => v.id === seeded.versionId && v.label === '备份基线版本'));
    const snap = await reqTo(srv.port, 'GET', `/api/versions/${seeded.versionId}`);
    assert.equal(snap.status, 200);
    assert.equal(snap.json.cues.length, 2);

    // 房间码与暂停进度一致
    const room = await reqTo(srv.port, 'GET', `/api/rooms/${code}`);
    assert.equal(room.status, 200);
    assert.equal(room.json.playing, false);
    assert.equal(room.json.version.id, seeded.versionId);
    assert.ok(Math.abs(room.json.time - pausedTime) < 1e-6, `进度未保留：${room.json.time} vs ${pausedTime}`);
    // GET 房间不回显密钥
    assert.ok(!('control_key' in room.json));

    // 原控制密钥仍可控制（密钥随库原样恢复）
    const again = await reqTo(srv.port, 'POST', `/api/rooms/${code}/control`, {
      control_key: seeded.room.control_key,
      revision: room.json.revision,
      action: 'play',
    });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.playing, true);

    // 草稿/调光记录 API 也可用
    const rec = await reqTo(srv.port, 'GET', `/api/records/${seeded.recordId}`);
    assert.equal(rec.status, 200);
    assert.equal(rec.json.ops.length, 1);
  } finally {
    srv.child.kill('SIGTERM');
    await new Promise((r) => srv.child.on('exit', r));
  }
});

test('恢复后：到点预约按原绝对墙钟补算启播（迟到查询也不重复启播）', async () => {
  const seeded = await seedRichData();
  const code = seeded.room.code;

  // 直接写库：暂停房间 + 一个“过去 60 秒”的预约（恢复后首次 GET 应按该绝对时刻补算）
  const mdb = new Database(DB_PATH);
  const roomId = mdb.prepare('SELECT id FROM rooms WHERE code = ?').get(code).id;
  mdb.prepare('UPDATE rooms SET playing = 0, time = 0, anchor_wall = ?, speed = 1 WHERE id = ?')
    .run(Date.now() / 1000, roomId);
  const past = Date.now() / 1000 - 60;
  mdb.prepare('INSERT INTO room_schedules (room_id, start_at) VALUES (?, ?)').run(roomId, past);
  mdb.pragma('wal_checkpoint(TRUNCATE)');
  mdb.close();

  const out = path.join(TMP, 'past-sched.crbk');
  const b = await runCli(['backup', out]);
  assert.equal(b.code, 0, b.stderr);

  const dir = freshDir('restore-sched');
  const rr = await runCli(['restore', out, dir]);
  assert.equal(rr.code, 0, rr.stderr);

  const srv = startRestoredServer(path.join(dir, 'app.db'));
  try {
    await srv.waitReady();
    const room = await reqTo(srv.port, 'GET', `/api/rooms/${code}`);
    assert.equal(room.status, 200, JSON.stringify(room.json));
    // 预约按绝对墙钟（past）起算，60 秒已远超版本时长（10s）→ 已自动启播并停在末尾，
    // schedule 标记为 started 且预约行已删除（不会重复启播）
    assert.equal(room.json.schedule.state, 'started');
    assert.equal(room.json.playing, false);
    assert.ok(room.json.time >= room.json.duration - 1e-6, `应停在末尾，实际 time=${room.json.time}`);
    // 再查一次：时码不回退、不重复启播
    const again = await reqTo(srv.port, 'GET', `/api/rooms/${code}`);
    assert.equal(again.json.schedule.state, 'started');
    assert.equal(again.json.playing, false);
    assert.ok(Math.abs(again.json.time - room.json.time) < 1e-9);
  } finally {
    srv.child.kill('SIGTERM');
    await new Promise((r) => srv.child.on('exit', r));
  }
});

test('恢复后：交接凭证按原到期墙钟判定（已过期则 403，控制权不变）', async () => {
  const seeded = await seedRichData();
  const code = seeded.room.code;

  // 发起交接，然后把凭证到期时刻改到过去，并让其绑定修订号仍等于房间修订号
  const issue = await post(`/api/rooms/${code}/handover/issue`, {
    control_key: seeded.room.control_key,
    revision: seeded.room.revision,
  });
  assert.equal(issue.status, 200);
  const token = issue.json.handover_token;

  const mdb = new Database(DB_PATH);
  const roomId = mdb.prepare('SELECT id FROM rooms WHERE code = ?').get(code).id;
  mdb.prepare('UPDATE room_handovers SET expires_at = ? WHERE room_id = ?')
    .run(Date.now() / 1000 - 1, roomId);
  mdb.pragma('wal_checkpoint(TRUNCATE)');
  mdb.close();

  const out = path.join(TMP, 'expired-ho.crbk');
  const b = await runCli(['backup', out]);
  assert.equal(b.code, 0, b.stderr);

  const dir = freshDir('restore-handover');
  const rr = await runCli(['restore', out, dir]);
  assert.equal(rr.code, 0, rr.stderr);

  const srv = startRestoredServer(path.join(dir, 'app.db'));
  try {
    await srv.waitReady();
    // GET 只报告过期状态，不回显凭证/密钥
    const view = await reqTo(srv.port, 'GET', `/api/rooms/${code}`);
    assert.equal(view.status, 200);
    assert.equal(view.json.handover.active, false);
    assert.equal(view.json.handover.reason, 'expired');
    assert.ok(!('handover_token' in view.json));
    assert.ok(!('control_key' in view.json));
    // 用过期凭证领取 → 403，控制权不变（原密钥仍有效）
    const claim = await reqTo(srv.port, 'POST', `/api/rooms/${code}/handover/claim`, {
      handover_token: token,
      revision: seeded.room.revision,
    });
    assert.equal(claim.status, 403);
    assert.match(claim.json.error, /交接凭证已过期/);
    assert.ok(!JSON.stringify(claim.json).includes(token));
  } finally {
    srv.child.kill('SIGTERM');
    await new Promise((r) => srv.child.on('exit', r));
  }
});
