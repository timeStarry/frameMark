import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export function createStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'markr.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS records_kind ON records(kind);`);
  return {
    db,
    get: id => { const r = db.prepare('SELECT * FROM records WHERE id=?').get(id); return r ? { ...JSON.parse(r.data), id:r.id, kind:r.kind, owner:r.owner } : null; },
    list: kind => db.prepare('SELECT * FROM records WHERE kind=? ORDER BY rowid DESC').all(kind).map(r => ({ ...JSON.parse(r.data), id:r.id, kind:r.kind, owner:r.owner })),
    save(kind, owner, data, id = randomUUID()) {
      db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, kind, owner, JSON.stringify(data));
      return this.get(id);
    }
  };
}
export function canRead(record, viewer) {
  return !!record && (record.owner === viewer || (record.status === 'published' && ['public', 'unlisted'].includes(record.visibility)));
}
export function inSquare(record) { return record.status === 'published' && record.visibility === 'public' && record.distribute === true; }
