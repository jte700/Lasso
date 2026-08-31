// Aliases: a user-chosen name pinned to one exact source location.
//
// An alias is the answer to an ambiguous name. It stores the object key, so it
// keeps resolving as the file changes, and the address it was created from, so
// the terminal can say what it points at without re-deriving it.

import crypto from 'node:crypto';
import { HttpError } from '../history/errors.js';
import { normalizeActor } from '../history/service.js';
import { canonicalAddress, parseAddress, slug, sourceLocator } from './names.js';

function now() { return new Date().toISOString(); }

export class AliasService {
  constructor(db, timeline) {
    this.db = db;
    this.timeline = timeline;
  }

  static normalizeName(value) {
    const name = slug(value);
    if (!name) throw new HttpError(400, 'An alias name must contain a letter or a digit.');
    return name;
  }

  list(projectId) {
    return this.db.prepare(`
      SELECT * FROM dependency_aliases WHERE project_id = ? ORDER BY name
    `).all(projectId).map((row) => this.map(row));
  }

  map(row) {
    return {
      id: row.id,
      name: row.name,
      objectKey: row.object_key,
      path: row.target_path,
      locator: row.target_locator,
      address: row.target_locator ? `${row.target_path}:${row.target_locator}` : row.target_path,
      createdAt: row.created_at,
    };
  }

  find(projectId, name) {
    const row = this.db.prepare('SELECT * FROM dependency_aliases WHERE project_id = ? AND name = ?')
      .get(projectId, slug(name));
    return row ? this.map(row) : null;
  }

  findByObjectKey(projectId, objectKey) {
    const row = this.db.prepare('SELECT * FROM dependency_aliases WHERE project_id = ? AND object_key = ? ORDER BY created_at LIMIT 1')
      .get(projectId, objectKey);
    return row ? this.map(row) : null;
  }

  /**
   * Resolves an address such as `Finance/Q3/model.xlsx:Summary!B17` against the
   * indexed objects and records the alias. An address that matches more than
   * one object is refused rather than guessed at.
   */
  create(projectId, { name, address, objectKey }, actorInput, graph) {
    const aliasName = AliasService.normalizeName(name);
    let object = null;

    if (objectKey) {
      object = graph.objectByKey(projectId, objectKey);
      if (!object) throw new HttpError(404, 'No indexed source matches that object.');
    } else {
      const parsed = parseAddress(address);
      if (!parsed) throw new HttpError(400, 'An alias needs a source address, such as Finance/model.xlsx:Summary!B17.');
      const candidates = graph.namedObjects(projectId).filter((candidate) => {
        const samePath = candidate.path === parsed.path
          || candidate.path.endsWith(`/${parsed.path}`)
          || candidate.fileName === parsed.path;
        if (!samePath) return false;
        if (!parsed.locator) return true;
        return sourceLocator(candidate).toLowerCase() === parsed.locator.toLowerCase();
      });
      if (!candidates.length) {
        throw new HttpError(404, `Nothing indexed at ${address}. Use \`find\` to locate the source first.`);
      }
      if (candidates.length > 1) {
        throw new HttpError(409, `${address} matches ${candidates.length} indexed sources. Add the exact location, such as ${canonicalAddress(candidates[0])}.`);
      }
      [object] = candidates;
    }

    const actor = normalizeActor(actorInput);
    this.timeline.upsertActor(actor);
    const existing = this.find(projectId, aliasName);
    if (existing) {
      this.db.prepare('DELETE FROM dependency_aliases WHERE id = ?').run(existing.id);
    }
    const row = {
      id: crypto.randomUUID(),
      name: aliasName,
      objectKey: object.objectKey,
      path: object.path,
      locator: sourceLocator(object) || null,
    };
    this.db.prepare(`
      INSERT INTO dependency_aliases(id, project_id, name, object_key, target_path, target_locator, created_by_actor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, projectId, row.name, row.objectKey, row.path, row.locator, actor.id, now());
    return { alias: this.find(projectId, aliasName), object, replaced: Boolean(existing) };
  }

  remove(projectId, name) {
    const alias = this.find(projectId, name);
    if (!alias) throw new HttpError(404, `No alias named ${slug(name)}.`);
    this.db.prepare('DELETE FROM dependency_aliases WHERE id = ?').run(alias.id);
    return alias;
  }
}
