import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const SEED = 'markr-demo-v1', OWNER = 'markr-demo';
const MAX_FILE = 5 * 1024 * 1024, MAX_TOTAL = 35 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
const fail = message => { throw new Error(message); };
const requireValue = (condition, message) => { if (!condition) fail(message); };
const text = (value, label, limit = 10000) => requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= limit, `Invalid ${label}`);
const slug = (value, label) => requireValue(typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64, `Invalid ${label}`);
const assetId = id => `demo-v1-asset-${id}`;
const workId = id => `demo-v1-work-${id}`;
const collectionId = id => `demo-v1-collection-${id}`;

function httpsURL(value, hosts, label) {
  let url;
  try { url = new URL(value); } catch { fail(`Invalid ${label}`); }
  requireValue(url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password && !url.port, `Invalid ${label}`);
  return url;
}

export function validateManifest(manifest) {
  requireValue(manifest && manifest.version === 1 && manifest.seed === SEED && manifest.owner === OWNER, 'Expected version 1 markr-demo-v1 manifest for markr-demo');
  requireValue(Array.isArray(manifest.photos) && manifest.photos.length >= 8 && manifest.photos.length <= 12, 'Demo must contain 8–12 photos');
  requireValue(Array.isArray(manifest.collections) && manifest.collections.length >= 2 && manifest.collections.length <= 3, 'Demo must contain 2–3 collections');
  const profile = manifest.profile;
  requireValue(profile && /Markr Demo/.test(profile.name) && /演示/.test(profile.name), 'Profile must clearly name Markr Demo and 演示');
  text(profile.bio, 'profile bio');
  requireValue(/^#[0-9a-f]{6}$/i.test(profile.accent) && ['grid', 'column'].includes(profile.layout), 'Invalid profile appearance');
  requireValue(Array.isArray(profile.modules) && profile.modules.length === 2 && profile.modules.includes('works') && profile.modules.includes('collections'), 'Invalid profile modules');
  const photoIds = new Set(), filenames = new Set(), sourcePages = new Set();
  for (const photo of manifest.photos) {
    slug(photo.id, 'photo id');
    requireValue(!photoIds.has(photo.id), 'Duplicate photo id'); photoIds.add(photo.id);
    requireValue(typeof photo.file === 'string' && basename(photo.file) === photo.file && /^[a-z0-9][a-z0-9._-]*\.(?:jpe?g|png|webp)$/i.test(photo.file) && !filenames.has(photo.file), 'Invalid or duplicate photo filename'); filenames.add(photo.file);
    requireValue(typeof photo.sha256 === 'string' && /^[0-9a-f]{64}$/.test(photo.sha256), 'Invalid photo SHA-256');
    text(photo.title, 'photo title', 200); text(photo.text, 'photo description'); slug(photo.collection, 'photo collection');
    requireValue(photo.featuredRank === undefined || photo.featuredRank === 1, 'Only explicit featuredRank 1 is supported');
    const source = photo.source;
    requireValue(source && typeof source === 'object', 'Missing photo source');
    for (const field of ['title', 'author', 'licenseName', 'changes']) text(source[field], `source ${field}`, 2000);
    const page = httpsURL(source.sourcePage, ['commons.wikimedia.org'], 'source page');
    requireValue(page.pathname.startsWith('/wiki/File:') && !sourcePages.has(source.sourcePage), 'Source must be a distinct Wikimedia Commons file page'); sourcePages.add(source.sourcePage);
    httpsURL(source.downloadURL, ['upload.wikimedia.org', 'thumb.wikimedia.org'], 'download URL');
    const license = httpsURL(source.licenseURL, ['creativecommons.org', 'commons.wikimedia.org'], 'license URL');
    const name = source.licenseName.trim();
    const ccBy = /^CC BY (1\.0|2\.0|2\.5|3\.0|4\.0)$/i.exec(name);
    const ccZero = /^CC0(?: 1\.0(?: Universal)?)?$/i.test(name);
    const publicDomain = /^Public domain$/i.test(name);
    requireValue(
      (ccZero && license.hostname === 'creativecommons.org' && /^\/publicdomain\/zero\/1\.0\/?$/.test(license.pathname)) ||
      (ccBy && license.hostname === 'creativecommons.org' && license.pathname.startsWith(`/licenses/by/${ccBy[1]}/`)) ||
      (publicDomain && ((license.hostname === 'creativecommons.org' && /^\/publicdomain\/mark\/1\.0\/?$/.test(license.pathname)) || (license.hostname === 'commons.wikimedia.org' && license.pathname.startsWith('/wiki/')))),
      'Only matching CC0, Public domain or CC BY licenses are accepted; review the source page before preparing the manifest'
    );
  }
  requireValue(manifest.photos.filter(photo => photo.featuredRank === 1).length === 1, 'Exactly one demo banner is required');
  requireValue(photoIds.has(profile.cover), 'Profile cover must reference a demo photo');
  const collectionIds = new Set(), membership = new Set();
  for (const collection of manifest.collections) {
    slug(collection.id, 'collection id'); text(collection.title, 'collection title', 200); text(collection.text, 'collection description');
    requireValue(!collectionIds.has(collection.id), 'Duplicate collection id'); collectionIds.add(collection.id);
    requireValue(Array.isArray(collection.photos) && collection.photos.length > 0, 'Each collection needs photos');
    for (const id of collection.photos) {
      requireValue(photoIds.has(id) && !membership.has(id), 'Invalid or repeated collection photo'); membership.add(id);
      requireValue(manifest.photos.find(photo => photo.id === id).collection === collection.id, 'Photo collection mismatch');
    }
  }
  requireValue(membership.size === photoIds.size, 'Every photo must belong to exactly one collection');
  return manifest;
}

function regular(path, label) {
  requireValue(existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), `${label} must be an existing regular file`);
}

function pathsFor(directory) {
  requireValue(typeof directory === 'string' && directory.length > 0, 'An explicit existing --directory is required');
  const root = realpathSync(resolve(directory));
  requireValue(lstatSync(root).isDirectory(), 'Data directory does not exist');
  const database = join(root, 'markr.sqlite'), media = join(root, 'media');
  regular(database, 'Database');
  if (existsSync(media)) requireValue(lstatSync(media).isDirectory() && !lstatSync(media).isSymbolicLink(), 'Media must be a regular directory');
  return { root, database, media };
}

function openDatabase(path, readOnly) {
  const db = new DatabaseSync(path, { readOnly });
  try {
    const fields = db.prepare('PRAGMA table_info(records)').all();
    requireValue(['id', 'kind', 'owner', 'data'].every(name => fields.some(field => field.name === name)), 'Existing records table is required');
    db.exec('PRAGMA busy_timeout=5000');
    return db;
  } catch (error) { db.close(); throw error; }
}

async function preparePhotos(manifest, images) {
  requireValue(typeof images === 'string' && images.length > 0, 'An explicit --images directory is required');
  const root = realpathSync(resolve(images));
  requireValue(lstatSync(root).isDirectory(), 'Images directory does not exist');
  const photos = []; let bytes = 0;
  for (const photo of manifest.photos) {
    const path = join(root, photo.file); regular(path, 'Source image');
    const size = lstatSync(path).size;
    requireValue(size > 0 && size <= MAX_FILE, 'Each source image must be at most 5 MiB');
    bytes += size; requireValue(bytes <= MAX_TOTAL, 'Source image total must be at most 35 MiB');
    const original = readFileSync(path);
    requireValue(hash(original) === photo.sha256, `Source checksum mismatch: ${photo.id}`);
    const image = sharp(original, { limitInputPixels: 40000000 });
    const metadata = await image.metadata();
    requireValue(['jpeg', 'png', 'webp'].includes(metadata.format) && (metadata.pages || 1) === 1, 'Only single-frame JPEG, PNG and WebP source images are supported');
    const { data: display, info } = await image.rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
    photos.push({ photo, original, display, metadata, info });
  }
  return photos;
}

function recordPlan(manifest, photos, seededAt) {
  const marker = { seed: SEED, seedManifestHash: hash(canonical(manifest)), seededAt, isDemo: true };
  const rows = [];
  const add = (id, kind, data) => rows.push({ id, kind, owner: OWNER, data: { ...data, ...marker } });
  // Reverse insertion means square/profile rowid-desc order follows the manifest.
  for (const { photo, original, display, metadata, info } of [...photos].reverse()) {
    add(assetId(photo.id), 'asset', {
      format: metadata.format, width: metadata.width, height: metadata.height,
      displayWidth: info.width, displayHeight: info.height, bytes: original.length,
      originalSha256: hash(original), displaySha256: hash(display), displayBytes: display.length,
      source: photo.source, createdAt: seededAt
    });
    add(workId(photo.id), 'work', {
      title: photo.title,
      text: `${photo.text}\n\n演示占位作品，非 Markr Demo 原创。来源：${photo.source.title}；作者：${photo.source.author}。原始页面：${photo.source.sourcePage}。许可：${photo.source.licenseName}（${photo.source.licenseURL}）。处理：${photo.source.changes}`,
      assets: [assetId(photo.id)], status: 'published', visibility: 'public', distribute: true,
      allowOriginal: false, license: null, aiDeclaration: null, tags: [],
      attributions: [photo.source], ...(photo.featuredRank === 1 ? { featuredRank: 1 } : {}), updatedAt: seededAt
    });
  }
  for (const collection of [...manifest.collections].reverse()) {
    add(collectionId(collection.id), 'collection', {
      title: collection.title, text: `${collection.text}\n\nMarkr Demo 演示占位作品集；图片来自明确许可的外部作者，逐张来源及许可见作品详情。`,
      works: collection.photos.map(workId), status: 'published', visibility: 'public', distribute: false,
      allowOriginal: false, updatedAt: seededAt
    });
  }
  add('demo-v1-profile', 'profile', {
    name: manifest.profile.name,
    bio: `${manifest.profile.bio}\n\n演示身份，不能登录；非原作者账户，不代表用户的原创作品。图片作者、原始页面及许可见各作品详情。`,
    accent: manifest.profile.accent, layout: manifest.profile.layout, modules: manifest.profile.modules,
    cover: assetId(manifest.profile.cover), status: 'published', visibility: 'public', updatedAt: seededAt
  });
  return rows;
}

function readRows(db) {
  return db.prepare('SELECT id,kind,owner,data FROM records').all().map(row => ({ ...row, data: JSON.parse(row.data) }));
}

function seededTimestamp(rows, manifestHash) {
  const matches = rows.filter(row => row.owner === OWNER && row.data.seed === SEED && row.data.seedManifestHash === manifestHash);
  const timestamp = matches[0]?.data.seededAt;
  if (timestamp !== undefined) requireValue(typeof timestamp === 'string' && new Date(timestamp).toISOString() === timestamp, 'Invalid existing seed timestamp');
  return timestamp || new Date().toISOString();
}

function inspectExisting(existing, plan, media) {
  const ids = new Set(plan.map(row => row.id));
  const owned = existing.filter(row => row.owner === OWNER || row.data.seed === SEED || ids.has(row.id));
  for (const row of owned) {
    const expected = plan.find(item => item.id === row.id);
    requireValue(expected && row.owner === OWNER && row.kind === expected.kind && canonical(row.data) === canonical(expected.data), `Record collision or changed seed: ${row.id}`);
  }
  requireValue(owned.length === 0 || owned.length === plan.length, 'Partial seed exists; inspect --cleanup-plan before attempting a repair');
  for (const row of plan.filter(item => item.kind === 'asset')) {
    for (const [suffix, checksum] of [['original', row.data.originalSha256], ['webp', row.data.displaySha256]]) {
      const path = join(media, `${row.id}.${suffix}`);
      if (owned.length) { regular(path, 'Existing seed media'); requireValue(hash(readFileSync(path)) === checksum, `Seed media changed: ${basename(path)}`); }
      else requireValue(!existsSync(path), `Media collision: ${basename(path)}`);
    }
  }
  return owned.length ? 'unchanged' : 'create';
}

function cleanupReport(db, media, manifest) {
  const rows = readRows(db), expected = new Set([
    'demo-v1-profile', ...manifest.photos.flatMap(photo => [assetId(photo.id), workId(photo.id)]), ...manifest.collections.map(collection => collectionId(collection.id))
  ]);
  const selected = rows.filter(row => row.owner === OWNER && row.data.seed === SEED);
  const ids = new Set(selected.map(row => row.id));
  const assetIds = new Set([...manifest.photos.map(photo => assetId(photo.id)), ...selected.filter(row => row.kind === 'asset').map(row => row.id)]);
  const references = rows.flatMap(row => {
    const values = [...(Array.isArray(row.data.assets) ? row.data.assets : []), ...(Array.isArray(row.data.works) ? row.data.works : []), row.data.cover].filter(id => ids.has(id));
    return values.length ? [{ id: row.id, owner: row.owner, kind: row.kind, references: values, outsideSeed: !ids.has(row.id) }] : [];
  });
  return {
    mode: 'cleanup-plan', seed: SEED, owner: OWNER, loginEnabled: false, deletionPerformed: false,
    records: selected.map(({ id, kind }) => ({ id, kind })),
    files: [...assetIds].flatMap(id => ['original', 'webp'].map(suffix => ({ path: join(media, `${id}.${suffix}`), exists: existsSync(join(media, `${id}.${suffix}`)), ownedBySeedRecord: ids.has(id) }))),
    expectedIds: [...expected], missingExpectedIds: [...expected].filter(id => !ids.has(id)),
    conflictingIds: rows.filter(row => expected.has(row.id) && !ids.has(row.id)).map(row => row.id), references
  };
}

/** Import only explicitly licensed demo content; never create an authentication identity. */
export async function seedDemo({ directory, manifest, images, apply = false, cleanupPlan = false }) {
  validateManifest(manifest);
  requireValue(!(apply && cleanupPlan), '--apply and --cleanup-plan cannot be combined');
  const paths = pathsFor(directory);
  if (cleanupPlan) {
    const db = openDatabase(paths.database, true);
    try { return cleanupReport(db, paths.media, manifest); } finally { db.close(); }
  }
  const photos = await preparePhotos(manifest, images);
  const read = openDatabase(paths.database, true);
  let plan, status;
  try {
    const rows = readRows(read);
    plan = recordPlan(manifest, photos, seededTimestamp(rows, hash(canonical(manifest))));
    status = inspectExisting(rows, plan, paths.media);
  } finally { read.close(); }
  const report = {
    mode: apply ? 'apply' : 'dry-run', seed: SEED, owner: OWNER, loginEnabled: false,
    status: apply ? status : status === 'create' ? 'would-create' : status,
    records: plan.map(({ id, kind }) => ({ id, kind })),
    fileCount: photos.length * 2, bytes: photos.reduce((total, photo) => total + photo.original.length + photo.display.length, 0),
    profile: `/profile/${OWNER}`, collections: manifest.collections.map(collection => `/collection/${collectionId(collection.id)}`)
  };
  if (!apply || status === 'unchanged') return report;
  const db = openDatabase(paths.database, false), createdFiles = [];
  let inTransaction = false, createdDirectory = false;
  try {
    db.exec('BEGIN IMMEDIATE'); inTransaction = true;
    // Repeat collision checks while holding the write lock; another seed may have just committed.
    const rows = readRows(db);
    plan = recordPlan(manifest, photos, seededTimestamp(rows, hash(canonical(manifest))));
    if (inspectExisting(rows, plan, paths.media) === 'unchanged') {
      db.exec('ROLLBACK'); inTransaction = false; return { ...report, status: 'unchanged' };
    }
    if (!existsSync(paths.media)) { mkdirSync(paths.media, { mode: 0o700 }); createdDirectory = true; }
    for (const { photo, original, display } of photos) {
      for (const [suffix, bytes] of [['original', original], ['webp', display]]) {
        const path = join(paths.media, `${assetId(photo.id)}.${suffix}`);
        const fd = openSync(path, 'wx', 0o600); createdFiles.push(path);
        try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
      }
    }
    const insert = db.prepare('INSERT INTO records(id,kind,owner,data) VALUES(?,?,?,?)');
    for (const row of plan) insert.run(row.id, row.kind, row.owner, JSON.stringify(row.data));
    db.exec('COMMIT'); inTransaction = false;
    return report;
  } catch (error) {
    // SQLite may already have rolled back (for example RAISE(ROLLBACK)).
    // Cleanup must still run and preserve the original import failure.
    if (inTransaction) { try { db.exec('ROLLBACK'); } catch { /* Already rolled back or unavailable. */ } }
    for (const path of createdFiles) { try { unlinkSync(path); } catch { /* Report original failure; no unrelated files are touched. */ } }
    if (createdDirectory) { try { rmdirSync(paths.media); } catch { /* Keep nonempty directories. */ } }
    throw error;
  } finally { db.close(); }
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--apply' || flag === '--cleanup-plan') {
      const key = flag === '--apply' ? 'apply' : 'cleanupPlan'; requireValue(!options[key], `Duplicate ${flag}`); options[key] = true;
    } else if (['--directory', '--manifest', '--images'].includes(flag)) {
      const key = flag.slice(2); requireValue(!Object.hasOwn(options, key) && args[index + 1] && !args[index + 1].startsWith('--'), `Missing or duplicate ${flag}`); options[key] = args[++index];
    } else fail(`Unknown option: ${flag}`);
  }
  requireValue(options.manifest, 'Usage: node scripts/seed-demo.mjs --directory EXISTING_DATA --manifest FILE --images DIRECTORY [--apply | --cleanup-plan]');
  regular(resolve(options.manifest), 'Manifest');
  const manifest = JSON.parse(readFileSync(resolve(options.manifest), 'utf8'));
  const result = await seedDemo({ ...options, manifest });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`Demo seed refused: ${error.message}\n`); process.exitCode = 1; });
}
