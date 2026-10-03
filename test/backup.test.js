'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

// 每个测试文件使用独立临时库，不触碰开发数据
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-backup-'));
process.env.DB_PATH = path.join(TMP_DIR, 'app.db');
const { app } = require('../server.js');
const { get } = require('../src/db');
const Backup = require('../src/backup.js');

const BACKUP_FILE = path.join(TMP_DIR, 'backup.json');
const RESTORE_DIR = path.join(TMP_DIR, 'restored');
const RESTORE_DB = path.join(RESTORE_DIR, 'app.db');
const CLI = path.join(__dirname, '..', 'src', 'backup.js');

let server;
let port;
const ctx = {}; // 种子数据上下文（before 钩子填充）

function request(method, urlPath, body, targetPort = port) {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: targetPort,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function seed() {
  const c1 = (await request('POST', '/api/circuits', { name: '面光回路', capacity: 1500 })).json;
  const l1 = (await request('POST', '/api/lights', { name: '面光1' })).json;
  const l2 = (await request('POST', '/api/lights', { name: '侧光2' })).json;
  await request('PUT', `/api/lights/${l1.id}/wiring`, { circuit_id: c1.id, watts: 300 });
  await request('POST', '/api/cues', [
    { cue_no: 1, light_id: l1.id, time: 0, target: 100, duration: 10 },
    { cue_no: 2, light_id: l2.id, time: 2, target: 50, duration: 4 },
  ]);
  ctx.v1 = (await request('POST', '/api/versions', { label: '首演' })).json;
  await request('POST', '/api/cues', { cue_no: 3, light_id: l1.id, time: 12, target: 0, duration: 2 });
  ctx.v2 = (await request('POST', '/api/versions', { label: '复排' })).json;
  // 长版本（末尾 600 秒）：供播放中的房间使用，避免测试期间撞到版本末尾
  await request('POST', '/api/cues', { cue_no: 4, light_id: l2.id, time: 0, target: 100, duration: 600 });
  ctx.v3 = (await request('POST', '/api/versions', { label: '长跑版' })).json;

  // 临时调光记录 + 一条覆盖操作
  ctx.rec = (await request('POST', '/api/records', { version_id: ctx.v1.id, label: '联排记录' })).json;
  let r = await request('POST', `/api/records/${ctx.rec.id}/ops`, {
    revision: 0,
    op: { light_id: l1.id, time: 2, op_type: 'override', target: 80, duration: 6 },
  });
  assert.equal(r.status, 201);

  // 房间 A（暂停态）：循环排演 + 讨论停点 + 未来定时启播 + 待领取交接凭证
  const roomA = (await request('POST', '/api/rooms', {
    version_id: ctx.v1.id,
    label: 'A房',
    overload_protection: true,
  })).json;
  r = await request('POST', `/api/rooms/${roomA.code}/program`, {
    control_key: roomA.control_key,
    revision: 0,
    segments: [{ start: 0, end: 8, repeat: 2 }],
  });
  assert.equal(r.status, 200);
  r = await request('POST', `/api/rooms/${roomA.code}/control`, {
    control_key: roomA.control_key,
    revision: 1,
    action: 'pause',
  });
  assert.equal(r.status, 200);
  r = await request('PUT', `/api/rooms/${roomA.code}/stops`, {
    control_key: roomA.control_key,
    revision: 2,
    stops: [4],
  });
  assert.equal(r.status, 200);
  ctx.scheduleAt = Math.floor(Date.now() / 1000) + 3600;
  r = await request('PUT', `/api/rooms/${roomA.code}/schedule`, {
    control_key: roomA.control_key,
    revision: 3,
    start_at: ctx.scheduleAt,
  });
  assert.equal(r.status, 200);
  r = await request('POST', `/api/rooms/${roomA.code}/handover/issue`, {
    control_key: roomA.control_key,
    revision: 4,
  });
  assert.equal(r.status, 200);
  ctx.roomA = { ...roomA, handover_token: r.json.handover_token, revision: 4 };

  // 房间 B：播放中（验证恢复后按原绝对墙钟继续结算）
  const roomB = (await request('POST', '/api/rooms', { version_id: ctx.v3.id, label: 'B房' })).json;
  r = await request('POST', `/api/rooms/${roomB.code}/control`, {
    control_key: roomB.control_key,
    revision: 0,
    action: 'play',
  });
  assert.equal(r.status, 200);
  ctx.roomB = { ...roomB, revision: 1, playWall: r.json.server_wall };

  // 房间 C：暂停在 3 秒（before 钩子中再补一条已过点的预约，模拟到点时服务已停）
  const roomC = (await request('POST', '/api/rooms', { version_id: ctx.v3.id, label: 'C房' })).json;
  r = await request('POST', `/api/rooms/${roomC.code}/control`, {
    control_key: roomC.control_key,
    revision: 0,
    action: 'seek',
    time: 3,
  });
  assert.equal(r.status, 200);
  ctx.roomC = { ...roomC, revision: 1 };
}

before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  await seed();

  // 直接落库两类边界数据（此后不再在原服务上触碰 B/C 两房，避免惰性结算改变状态）：
  //  - 房间 C：已过点的定时启播预约（绝对墙钟，恢复后应按预约时刻起算惰性启播）
  //  - 房间 B：已过期的交接凭证（恢复后应按原到期时刻判定为过期）
  const db = get();
  const now = Date.now() / 1000;
  const roomC = db.prepare('SELECT id FROM rooms WHERE code = ?').get(ctx.roomC.code);
  db.prepare('INSERT INTO room_schedules (room_id, start_at) VALUES (?, ?)').run(roomC.id, now - 1.5);
  const roomB = db.prepare('SELECT id FROM rooms WHERE code = ?').get(ctx.roomB.code);
  db.prepare(
    'INSERT INTO room_handovers (room_id, token, revision, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(roomB.id, 'e'.repeat(48), ctx.roomB.revision, now - 10, now - 400);

  // 服务运行期间导出一致的单文件备份
  const r = Backup.exportBackup(process.env.DB_PATH, BACKUP_FILE);
  ctx.counts = r.counts;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

test('备份文件：单文件、校验和可验、权限 600、覆盖全部业务表', () => {
  const st = fs.statSync(BACKUP_FILE);
  assert.equal(st.mode & 0o777, 0o600);
  const obj = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
  assert.equal(obj.format, Backup.FORMAT);
  assert.equal(obj.format_version, 1);
  const signed = {
    format: obj.format,
    format_version: obj.format_version,
    created_at: obj.created_at,
    tables: obj.tables,
  };
  assert.equal(obj.checksum, Backup.computeChecksum(signed));
  for (const t of [
    'lights', 'cues', 'circuits', 'versions', 'version_lights', 'version_cues',
    'version_circuits', 'version_light_wiring', 'rehearsal_records', 'record_ops',
    'rooms', 'room_handovers', 'room_programs', 'room_stops', 'room_schedules',
  ]) {
    assert.ok(Array.isArray(obj.tables[t]), `缺少表 ${t}`);
  }
  assert.equal(obj.tables.versions.length, 3);
  assert.equal(obj.tables.rooms.length, 3);
  assert.equal(obj.tables.room_schedules.length, 2); // A 的未来预约 + C 的已过点预约
  assert.equal(obj.tables.room_handovers.length, 2); // A 待领取 + B 已过期
  assert.equal(obj.tables.room_programs.length, 1);
  assert.equal(obj.tables.room_stops.length, 1);
  assert.equal(ctx.counts.rooms, 3);
});

test('导出：默认不覆盖已有备份文件，--force 才覆盖', () => {
  assert.throws(() => Backup.exportBackup(process.env.DB_PATH, BACKUP_FILE), /已存在/);
  const other = path.join(TMP_DIR, 'backup-force.json');
  Backup.exportBackup(process.env.DB_PATH, other);
  const r = Backup.exportBackup(process.env.DB_PATH, other, { force: true });
  assert.equal(r.counts.versions, 3);
});

test('恢复：空数据目录原子落地，版本编号与房间各项状态保持原值', () => {
  const r = Backup.restoreBackup(BACKUP_FILE, RESTORE_DB);
  assert.equal(r.counts.rooms, 3);
  const db = new Database(RESTORE_DB, { readonly: true });
  try {
    // 版本快照编号保持不变
    const versions = db.prepare('SELECT id, label, cue_count FROM versions ORDER BY id').all();
    assert.deepEqual(versions.map((v) => v.id), [ctx.v1.id, ctx.v2.id, ctx.v3.id]);
    assert.deepEqual(versions.map((v) => v.label), ['首演', '复排', '长跑版']);
    assert.equal(versions[0].cue_count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM version_lights').get().n, 6); // 3 版本 × 2 灯
    // 房间 A：控制状态、编排、停点、预约、交接凭证原样落库
    const roomA = db.prepare('SELECT * FROM rooms WHERE code = ?').get(ctx.roomA.code);
    assert.equal(roomA.control_key, ctx.roomA.control_key);
    assert.equal(roomA.revision, 4);
    assert.equal(roomA.overload_protection, 1);
    const prog = db.prepare('SELECT * FROM room_programs WHERE room_id = ?').get(roomA.id);
    assert.deepEqual(JSON.parse(prog.segments), [{ start: 0, end: 8, repeat: 2 }]);
    const stops = db.prepare('SELECT * FROM room_stops WHERE room_id = ?').get(roomA.id);
    assert.deepEqual(JSON.parse(stops.stops), [4]);
    const sch = db.prepare('SELECT * FROM room_schedules WHERE room_id = ?').get(roomA.id);
    assert.equal(sch.start_at, ctx.scheduleAt);
    const ho = db.prepare('SELECT * FROM room_handovers WHERE room_id = ?').get(roomA.id);
    assert.equal(ho.token, ctx.roomA.handover_token);
    assert.ok(Math.abs(ho.expires_at - ho.created_at - 300) < 1e-6);
    // 房间 C 的已过点预约按原绝对墙钟保留
    const roomC = db.prepare('SELECT * FROM rooms WHERE code = ?').get(ctx.roomC.code);
    const schC = db.prepare('SELECT * FROM room_schedules WHERE room_id = ?').get(roomC.id);
    assert.ok(schC.start_at < Date.now() / 1000);
    // 调光记录与操作序列
    const ops = db.prepare('SELECT * FROM record_ops ORDER BY id').all();
    assert.equal(ops.length, 1);
    assert.equal(ops[0].op_type, 'override');
    assert.equal(ops[0].target, 80);
  } finally {
    db.close();
  }
  assert.equal(fs.statSync(RESTORE_DB).mode & 0o777, 0o600);
});

test('恢复拒绝：目标数据目录非空，明确报错且目标数据不变', () => {
  const before1 = crypto.createHash('sha256').update(fs.readFileSync(RESTORE_DB)).digest('hex');
  assert.throws(() => Backup.restoreBackup(BACKUP_FILE, RESTORE_DB), /非空/);
  const after1 = crypto.createHash('sha256').update(fs.readFileSync(RESTORE_DB)).digest('hex');
  assert.equal(before1, after1);
});

// 重新签名（保持校验和有效）的篡改备份：用于结构/引用校验的专项测试
function forgeBackup(mutate) {
  const obj = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
  mutate(obj);
  const signed = {
    format: obj.format,
    format_version: obj.format_version,
    created_at: obj.created_at,
    tables: obj.tables,
  };
  obj.checksum = Backup.computeChecksum(signed);
  const p = path.join(TMP_DIR, `forged-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

test('恢复拒绝：备份被篡改（校验和不匹配），目标目录保持为空', () => {
  const obj = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
  obj.tables.lights[0].name = '被篡改';
  const p = path.join(TMP_DIR, 'tampered.json');
  fs.writeFileSync(p, JSON.stringify(obj)); // 不重新签名
  const target = path.join(TMP_DIR, 't-tampered', 'app.db');
  assert.throws(() => Backup.restoreBackup(p, target), /完整性校验失败/);
  assert.ok(!fs.existsSync(target));
});

test('恢复拒绝：备份格式版本不兼容', () => {
  const p = forgeBackup((obj) => {
    obj.format_version = 99;
  });
  const target = path.join(TMP_DIR, 't-fmt', 'app.db');
  assert.throws(() => Backup.restoreBackup(p, target), /不兼容/);
  assert.ok(!fs.existsSync(target));
});

test('恢复拒绝：结构非法（速度取值越界）', () => {
  const p = forgeBackup((obj) => {
    obj.tables.rooms[0].speed = 3;
  });
  const target = path.join(TMP_DIR, 't-struct', 'app.db');
  assert.throws(() => Backup.restoreBackup(p, target), /结构校验失败/);
  assert.ok(!fs.existsSync(target));
});

test('恢复拒绝：引用关系断裂（房间指向不存在的版本）', () => {
  const p = forgeBackup((obj) => {
    obj.tables.rooms[0].version_id = 9999;
  });
  const target = path.join(TMP_DIR, 't-ref', 'app.db');
  assert.throws(() => Backup.restoreBackup(p, target), /引用关系校验失败/);
  assert.ok(!fs.existsSync(target));
});

test('恢复拒绝：备份文件不存在', () => {
  assert.throws(
    () => Backup.restoreBackup(path.join(TMP_DIR, 'no-such.json'), path.join(TMP_DIR, 't-missing', 'app.db')),
    /不可读/
  );
});

test('CLI：服务运行期间导出，命令输出不回显控制密钥与交接凭证', () => {
  const out = path.join(TMP_DIR, 'cli-backup.json');
  const r = spawnSync(process.execPath, [CLI, 'export', '--db', process.env.DB_PATH, '--output', out], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /备份完成/);
  assert.ok(!r.stdout.includes(ctx.roomA.control_key));
  assert.ok(!r.stdout.includes(ctx.roomA.handover_token));
  assert.ok(!r.stderr.includes(ctx.roomA.control_key));
  assert.ok(!r.stderr.includes(ctx.roomA.handover_token));
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

test('CLI：恢复到空目录成功；重复恢复到非空目录失败且数据不变', () => {
  const db = path.join(TMP_DIR, 'cli-restore', 'app.db');
  let r = spawnSync(process.execPath, [CLI, 'restore', '--file', BACKUP_FILE, '--db', db], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /恢复完成/);
  assert.ok(!r.stdout.includes(ctx.roomA.control_key));
  assert.ok(!r.stdout.includes(ctx.roomA.handover_token));
  const hash = crypto.createHash('sha256').update(fs.readFileSync(db)).digest('hex');
  r = spawnSync(process.execPath, [CLI, 'restore', '--file', BACKUP_FILE, '--db', db], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /非空/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(db)).digest('hex'), hash);
});

test('恢复后启动服务：既有 HTTP API 可用，墙钟/预约/凭证按原时刻结算', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DB_PATH: RESTORE_DB, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const cport = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`子服务启动超时：${buf}`)), 15000);
      child.stdout.on('data', (d) => {
        buf += d;
        const m = buf.match(/localhost:(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      child.stderr.on('data', (d) => {
        buf += d;
      });
    });
    const capi = (method, p, body) => request(method, p, body, cport);

    // 版本编号保持原样（列表接口按 id 倒序返回）
    let r = await capi('GET', '/api/versions');
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.json.map((v) => v.id).sort((a, b) => a - b),
      [ctx.v1.id, ctx.v2.id, ctx.v3.id]
    );

    // 房间 A：编排/停点/预约/交接状态完整恢复，响应不含密钥
    r = await capi('GET', `/api/rooms/${ctx.roomA.code}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.revision, 4);
    assert.equal(r.json.program.status, 'paused');
    assert.deepEqual(r.json.stops.points, [4]);
    assert.equal(r.json.schedule.state, 'pending');
    assert.equal(r.json.schedule.start_at, ctx.scheduleAt);
    assert.equal(r.json.handover.active, true);
    assert.equal(r.json.control_key, undefined);

    // 交接凭证按原到期时刻判定：仍在有效期内，可领取；领取与修订号 +1 原子完成
    r = await capi('POST', `/api/rooms/${ctx.roomA.code}/handover/claim`, {
      handover_token: ctx.roomA.handover_token,
      revision: 4,
    });
    assert.equal(r.status, 200);
    const newKey = r.json.control_key;
    assert.match(newKey, /^[0-9a-f]{48}$/);
    assert.equal(r.json.revision, 5);
    // 旧密钥即刻失效，新密钥可控制
    r = await capi('POST', `/api/rooms/${ctx.roomA.code}/control`, {
      control_key: ctx.roomA.control_key,
      revision: 5,
      action: 'pause',
    });
    assert.equal(r.status, 403);
    r = await capi('POST', `/api/rooms/${ctx.roomA.code}/control`, {
      control_key: newKey,
      revision: 5,
      action: 'pause',
    });
    assert.equal(r.status, 200);

    // 房间 B：播放进度按原绝对墙钟继续结算
    r = await capi('GET', `/api/rooms/${ctx.roomB.code}`);
    assert.equal(r.json.playing, true);
    const expectB = r.json.server_wall - ctx.roomB.playWall;
    assert.ok(Math.abs(r.json.time - expectB) < 1.5, `time=${r.json.time} expect~${expectB}`);
    // 过期交接凭证按原到期时刻判定为过期
    assert.equal(r.json.handover.active, false);
    assert.equal(r.json.handover.reason, 'expired');
    r = await capi('POST', `/api/rooms/${ctx.roomB.code}/handover/claim`, {
      handover_token: 'e'.repeat(48),
      revision: 1,
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /过期/);

    // 房间 C：已过点的预约按原绝对墙钟惰性启播（从暂停的 3 秒起算）
    r = await capi('GET', `/api/rooms/${ctx.roomC.code}`);
    assert.equal(r.json.playing, true);
    assert.equal(r.json.schedule.state, 'started');
    assert.ok(r.json.time > 3 && r.json.time < 30, `time=${r.json.time}`);

    // 调光记录与输出口径不变
    r = await capi('GET', `/api/records/${ctx.rec.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.ops.length, 1);
    r = await capi('GET', `/api/records/${ctx.rec.id}/output?at=3`);
    assert.equal(r.status, 200);

    // 版本编号继续递增（自增序列连续）
    r = await capi('POST', '/api/versions', { label: '迁移后首版' });
    assert.equal(r.status, 201);
    assert.equal(r.json.id, ctx.v3.id + 1);
  } finally {
    child.kill();
  }
});
