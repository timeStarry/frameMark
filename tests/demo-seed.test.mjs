import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { seedDemo, validateManifest } from '../scripts/seed-demo.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const ids = Array.from({ length: 8 }, (_, index) => `photo-${index + 1}`);
const asset = id => `demo-v1-asset-${id}`;
const work = id => `demo-v1-work-${id}`;

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'markr-demo-seed-'));
  const directory = join(root, 'data'), images = join(root, 'images');
  mkdirSync(images); mkdirSync(directory); mkdirSync(join(directory, 'media'));
  const store = createStore(directory);
  store.save('work', 'real-photographer', { title: 'Existing private work', status: 'draft', visibility: 'private', assets: [] }, 'real-work');
  store.db.exec("CREATE TABLE identity_users(id TEXT PRIMARY KEY, email TEXT, password TEXT); INSERT INTO identity_users VALUES('existing-user','existing@example.invalid','existing-test-sentinel');");
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); store.db.close();
  writeFileSync(join(directory, 'media', 'real-file.original'), 'untouched original');
  const photos = [];
  for (const [index, id] of ids.entries()) {
    const bytes = await sharp({ create: { width: index % 2 ? 42 : 72, height: index % 2 ? 70 : 44, channels: 3, background: { r: 40 + index * 20, g: 80, b: 100 } } }).jpeg().withMetadata(index === 0 ? { orientation: 6 } : {}).toBuffer();
    writeFileSync(join(images, `${id}.jpg`), bytes);
    photos.push({
      id, file: `${id}.jpg`, sha256: digest(bytes), title: `Demo photo ${index + 1}`, text: '演示图库占位图。', collection: index < 4 ? 'landscape' : 'architecture', ...(index === 0 ? { featuredRank: 1 } : {}),
      source: { title: `Licensed photograph ${index + 1}`, author: `Author ${index + 1}`, sourcePage: `https://commons.wikimedia.org/wiki/File:Example_${index + 1}.jpg`, downloadURL: `https://thumb.wikimedia.org/example-${index + 1}.jpg`, licenseName: 'CC0 1.0 Universal', licenseURL: 'https://creativecommons.org/publicdomain/zero/1.0/', changes: '缩小并生成 WebP 展示版本；测试图形仅在隔离测试中使用。', verification: 'Synthetic source metadata for isolated tests only.' }
    });
  }
  const manifest = {
    version: 1, seed: 'markr-demo-v1', owner: 'markr-demo',
    profile: { name: 'Markr Demo · 演示图库', bio: '使用许可明确的外部图片展示产品。', accent: '#c8a477', layout: 'grid', modules: ['collections', 'works'], cover: ids[0] },
    photos, collections: [
      { id: 'landscape', title: '风景 · 演示', text: '演示风景作品。', photos: ids.slice(0, 4) },
      { id: 'architecture', title: '建筑 · 演示', text: '演示建筑作品。', photos: ids.slice(4) }
    ]
  };
  const options = { directory, images, manifest };
  const readDatabase = run => {
    const db = new DatabaseSync(join(directory, 'markr.sqlite'), { readOnly: true });
    try { return run(db); } finally { db.close(); }
  };
  const identity = () => readDatabase(db => db.prepare('SELECT * FROM identity_users').all());
  const records = () => readDatabase(db => db.prepare('SELECT * FROM records ORDER BY id').all());
  try { await run({ root, directory, images, manifest, options, identity, records, readDatabase }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('demo dry-run is read-only, explicit, and does not create login identities', () => fixture(async ({ directory, images, manifest, options, identity, records }) => {
  const before = readFileSync(join(directory, 'markr.sqlite'));
  const identities = identity(), initialRecords = records(), files = readdirSync(join(directory, 'media'));
  const report = await seedDemo(options);
  assert.equal(report.mode, 'dry-run'); assert.equal(report.status, 'would-create');
  assert.equal(report.loginEnabled, false); assert.equal(report.records.length, 19); assert.equal(report.fileCount, 16);
  assert.deepEqual(identity(), identities); assert.deepEqual(records(), initialRecords);
  assert.deepEqual(readFileSync(join(directory, 'markr.sqlite')), before);
  assert.deepEqual(readdirSync(join(directory, 'media')), files);
  await assert.rejects(seedDemo({ manifest, images }), /explicit existing --directory/);
  await assert.rejects(seedDemo({ directory: join(directory, 'absent'), images, manifest, apply: true }), /ENOENT/);
  assert.equal(readdirSync(directory).includes('absent'), false);
}));

test('demo apply creates only marked records and immutable images; exact repeat preserves bytes and timestamps', () => fixture(async ({ directory, images, options, identity, records }) => {
  const identities = identity();
  const report = await seedDemo({ ...options, apply: true });
  assert.equal(report.status, 'create'); assert.equal(report.profile, '/profile/markr-demo');
  assert.deepEqual(report.collections, ['/collection/demo-v1-collection-landscape', '/collection/demo-v1-collection-architecture']);
  const first = records(); assert.equal(first.length, 20);
  const seeded = first.filter(row => row.owner === 'markr-demo').map(row => ({ ...row, data: JSON.parse(row.data) }));
  assert.ok(seeded.every(row => row.data.seed === 'markr-demo-v1' && row.data.isDemo === true));
  assert.equal(new Set(seeded.map(row => row.data.seededAt)).size, 1);
  const demoWork = seeded.find(row => row.id === work(ids[0])).data;
  assert.equal(demoWork.allowOriginal, false); assert.equal(demoWork.license, null); assert.equal(demoWork.aiDeclaration, null);
  assert.equal(demoWork.attributions[0].author, 'Author 1'); assert.match(demoWork.text, /非 Markr Demo 原创/);
  const profile = seeded.find(row => row.kind === 'profile').data;
  assert.match(profile.bio, /不能登录/);
  const display = await sharp(join(directory, 'media', `${asset(ids[0])}.webp`)).metadata();
  assert.equal(display.width, 44); assert.equal(display.height, 72); assert.equal(display.format, 'webp');
  assert.equal(display.exif, undefined); assert.equal(display.icc, undefined);
  assert.deepEqual(readFileSync(join(directory, 'media', `${asset(ids[0])}.original`)), readFileSync(join(images, `${ids[0]}.jpg`)));
  const allFiles = readdirSync(join(directory, 'media'));
  const times = allFiles.map(file => [file, statSync(join(directory, 'media', file)).mtimeMs]);
  assert.equal((await seedDemo({ ...options, apply: true })).status, 'unchanged');
  assert.deepEqual(records(), first); assert.deepEqual(identity(), identities);
  assert.deepEqual(allFiles.map(file => [file, statSync(join(directory, 'media', file)).mtimeMs]), times);
  assert.equal(readFileSync(join(directory, 'media', 'real-file.original'), 'utf8'), 'untouched original');
}));

test('demo manifest rejects unsafe filenames, mismatched licenses, unsupported counts, and checksum changes before writing', () => fixture(async ({ directory, options, manifest, records }) => {
  const initial = records();
  const invalid = [
    value => { value.photos[0].file = '../real-file.original'; },
    value => { value.photos[0].source.licenseName = 'CC BY-SA 4.0'; },
    value => { value.photos[0].source.licenseName = 'CC BY 4.0'; },
    value => { value.photos[0].source.downloadURL = 'https://example.com/image.jpg'; },
    value => { value.photos[0].source.sourcePage = 'http://commons.wikimedia.org/wiki/File:Example.jpg'; },
    value => { value.photos[0].source.licenseURL = 'https://creativecommons.org/licenses/by-nc/4.0/'; },
    value => { value.photos[0].sha256 = '0'.repeat(64); },
    value => { value.photos.pop(); },
    value => { value.profile.cover = 'missing'; },
    value => { value.owner = 'real-photographer'; },
    value => { value.collections[1].photos[0] = ids[0]; }
  ];
  for (const mutate of invalid) {
    const bad = copy(manifest); mutate(bad);
    await assert.rejects(seedDemo({ ...options, manifest: bad, apply: true }));
    assert.deepEqual(records(), initial); assert.deepEqual(readdirSync(join(directory, 'media')), ['real-file.original']);
  }
  const ccBy = copy(manifest); ccBy.photos[0].source.licenseName = 'CC BY 4.0'; ccBy.photos[0].source.licenseURL = 'https://creativecommons.org/licenses/by/4.0/';
  assert.equal(validateManifest(ccBy), ccBy);
  const pd = copy(manifest); pd.photos[0].source.licenseName = 'Public domain'; pd.photos[0].source.licenseURL = 'https://commons.wikimedia.org/wiki/Template:PD-USGov';
  assert.equal(validateManifest(pd), pd);
}));

test('demo refuses record, owner and file collisions without overwriting existing content', () => fixture(async ({ directory, options, records }) => {
  const db = new DatabaseSync(join(directory, 'markr.sqlite'));
  const insert = db.prepare('INSERT INTO records VALUES(?,?,?,?)');
  insert.run(work(ids[0]), 'work', 'real-photographer', JSON.stringify({ title: 'Unrelated colliding work' }));
  const colliding = records();
  await assert.rejects(seedDemo({ ...options, apply: true }), /Record collision/);
  assert.deepEqual(records(), colliding);
  db.prepare('DELETE FROM records WHERE id=?').run(work(ids[0]));
  insert.run('existing-profile', 'profile', 'markr-demo', JSON.stringify({ name: 'Existing nonseed profile' }));
  await assert.rejects(seedDemo({ ...options, apply: true }), /Record collision/);
  db.prepare('DELETE FROM records WHERE id=?').run('existing-profile'); db.close();
  const path = join(directory, 'media', `${asset(ids[3])}.webp`);
  writeFileSync(path, 'unrelated file');
  await assert.rejects(seedDemo({ ...options, apply: true }), /Media collision/);
  assert.equal(readFileSync(path, 'utf8'), 'unrelated file');
  assert.equal(records().length, 1);
}));

test('demo detects changed manifests, edited records, and corrupted display files on repeat', () => fixture(async ({ directory, options, manifest, records }) => {
  await seedDemo({ ...options, apply: true }); const first = records();
  const changed = copy(manifest); changed.photos[0].title = 'Changed title';
  await assert.rejects(seedDemo({ ...options, manifest: changed, apply: true }), /Record collision/);
  assert.deepEqual(records(), first);
  const db = new DatabaseSync(join(directory, 'markr.sqlite'));
  const old = first.find(row => row.id === work(ids[0]));
  db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(old.data), visibility: 'private' }), old.id);
  await assert.rejects(seedDemo({ ...options, apply: true }), /Record collision/);
  db.prepare('UPDATE records SET data=? WHERE id=?').run(old.data, old.id); db.close();
  const path = join(directory, 'media', `${asset(ids[0])}.webp`);
  writeFileSync(path, 'corrupt display');
  await assert.rejects(seedDemo({ ...options, apply: true }), /Seed media changed/);
  assert.equal(readFileSync(path, 'utf8'), 'corrupt display');
}));

test('failed record transaction rolls back all new demo files and records while preserving identity data', () => fixture(async ({ directory, options, records, identity }) => {
  const initial = records(), identities = identity();
  const db = new DatabaseSync(join(directory, 'markr.sqlite'));
  db.exec("CREATE TRIGGER fail_demo_insert BEFORE INSERT ON records WHEN NEW.id='demo-v1-work-photo-4' BEGIN SELECT RAISE(ABORT,'simulated insert failure'); END;"); db.close();
  await assert.rejects(seedDemo({ ...options, apply: true }), /simulated insert failure/);
  assert.deepEqual(records(), initial); assert.deepEqual(identity(), identities);
  assert.deepEqual(readdirSync(join(directory, 'media')), ['real-file.original']);
}));

test('cleanup plan reports references and exact files without deleting or needing source images', () => fixture(async ({ directory, options, manifest, records }) => {
  // A process crash can leave a file before its record transaction commits.
  const orphan = join(directory, 'media', `${asset(ids[0])}.webp`);
  writeFileSync(orphan, 'orphan from interrupted import');
  const interrupted = await seedDemo({ directory, manifest, cleanupPlan: true });
  assert.equal(interrupted.records.length, 0); assert.equal(interrupted.files.length, 16);
  assert.deepEqual(interrupted.files.find(file => file.path === realpathSync(orphan)), { path: realpathSync(orphan), exists: true, ownedBySeedRecord: false });
  assert.equal(readFileSync(orphan, 'utf8'), 'orphan from interrupted import'); rmSync(orphan);
  await seedDemo({ ...options, apply: true });
  const db = new DatabaseSync(join(directory, 'markr.sqlite'));
  db.prepare('INSERT INTO records VALUES(?,?,?,?)').run('external-collection', 'collection', 'real-photographer', JSON.stringify({ works: [work(ids[0])] })); db.close();
  const first = records(), files = readdirSync(join(directory, 'media'));
  const plan = await seedDemo({ directory, manifest, cleanupPlan: true });
  assert.equal(plan.deletionPerformed, false); assert.equal(plan.records.length, 19); assert.equal(plan.files.length, 16);
  assert.deepEqual(plan.missingExpectedIds, []); assert.deepEqual(plan.conflictingIds, []);
  assert.deepEqual(plan.references.find(row => row.id === 'external-collection'), { id: 'external-collection', owner: 'real-photographer', kind: 'collection', references: [work(ids[0])], outsideSeed: true });
  assert.deepEqual(records(), first); assert.deepEqual(readdirSync(join(directory, 'media')), files);
  await assert.rejects(seedDemo({ ...options, apply: true, cleanupPlan: true }), /cannot be combined/);
}));

test('demo CLI defaults to dry-run and refuses symlinked source images', () => fixture(async ({ root, directory, images, manifest, records }) => {
  const path = join(root, 'manifest.json'); writeFileSync(path, JSON.stringify(manifest));
  const cli = spawnSync(process.execPath, ['scripts/seed-demo.mjs', '--directory', directory, '--manifest', path, '--images', images], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).mode, 'dry-run'); assert.equal(records().length, 1);
  const source = join(images, `${ids[0]}.jpg`), bytes = readFileSync(source), outside = join(root, 'outside.jpg');
  rmSync(source); writeFileSync(outside, bytes); symlinkSync(outside, source);
  await assert.rejects(seedDemo({ directory, images, manifest, apply: true }), /existing regular file/);
  assert.equal(records().length, 1);
}));

test('seeded public APIs expose ordered work, covers, attribution and protected display media without login', () => fixture(async ({ directory, options, identity }) => {
  const identities = identity(); await seedDemo({ ...options, apply: true });
  // Production default viewer ignores spoofed headers; this fixture never enables account routes or sends email.
  const { app, store } = createApp({ directory });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  const get = async path => { const response = await fetch(base + path); assert.equal(response.status, 200, path); return response.json(); };
  try {
    const square = await get('square?limit=12');
    assert.deepEqual(square.works.map(item => item.id), ids.map(work));
    assert.deepEqual(square.banner.map(item => item.id), [work(ids[0])]);
    assert.ok(square.works.every(item => item.photographer === 'markr-demo' && item.photographerName === 'Markr Demo · 演示图库' && item.isDemo));
    const profile = await get('profile/markr-demo');
    assert.deepEqual(profile.collections.map(item => item.id), ['demo-v1-collection-landscape', 'demo-v1-collection-architecture']);
    assert.equal(profile.coverMedia.id, asset(ids[0])); assert.equal(profile.coverMedia.width, 44);
    const collection = await get('collection/demo-v1-collection-landscape');
    assert.deepEqual(collection.items.map(item => item.id), ids.slice(0, 4).map(work));
    assert.equal(collection.coverMedia.id, asset(ids[0]));
    const photo = await get(`work/${work(ids[1])}`);
    assert.equal(photo.attributions[0].licenseName, 'CC0 1.0 Universal'); assert.equal(photo.license, null); assert.equal(photo.aiDeclaration, null);
    for (const id of ids) {
      const response = await fetch(`${base}media/${asset(id)}/display`);
      assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/webp');
      const decoded = await sharp(Buffer.from(await response.arrayBuffer())).metadata(); assert.ok(decoded.width <= 1800 && decoded.height <= 1800);
      const head = await fetch(`${base}media/${asset(id)}/display`, { method: 'HEAD' });
      assert.equal(head.status, 200); assert.equal(head.headers.get('cache-control'), 'private, no-store'); assert.equal((await head.arrayBuffer()).byteLength, 0);
      assert.equal((await fetch(`${base}media/${asset(id)}/original`)).status, 404);
    }
    for (const path of ['work', 'assets', 'collection', 'profile']) {
      const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-viewer': 'markr-demo' }, body: '{}' });
      assert.equal(response.status, 401, path);
    }
    const me = await get('me'); assert.equal(me.user, null);
    assert.equal((await fetch(base + 'studio', { headers: { 'x-test-viewer': 'markr-demo' } })).status, 401);
    // Revoking a work removes it from distribution and makes its display inaccessible, except an intentional public cover.
    const revoked = store.get(work(ids[2])); store.save('work', 'markr-demo', { ...revoked, visibility: 'private' }, revoked.id);
    assert.equal((await fetch(base + `work/${revoked.id}`)).status, 404);
    assert.equal((await fetch(base + `media/${asset(ids[2])}/display`, { method: 'HEAD' })).status, 404);
    assert.ok(!(await get('square')).works.some(item => item.id === revoked.id));
    assert.deepEqual((await get('collection/demo-v1-collection-landscape')).works, [work(ids[0]), work(ids[1]), work(ids[3])]);
    assert.deepEqual(identity(), identities);
  } finally { await new Promise(resolve => server.close(resolve)); store.db.close(); }
}));
