// Rules: one trigger, one action, evaluated deterministically.
//
// This is not an automation platform and is not meant to become one. A rule
// reacts to a change the graph already recorded, and every action it can take
// is a flag — nothing here edits a document or revokes a share on its own.

import crypto from 'node:crypto';
import { HttpError } from '../history/errors.js';
import { normalizeActor } from '../history/service.js';
import { slug } from './names.js';

function now() { return new Date().toISOString(); }

export const TRIGGERS = {
  SOURCE_PATH_PREFIX: {
    keyword: 'source path starts with',
    describe: (value) => `source path starts with ${value}`,
    needsValue: true,
  },
  DEPENDENCY_NAME: {
    keyword: 'dependency is',
    describe: (value) => `dependency is ${value}`,
    needsValue: true,
  },
  SHARED_SOURCE_CHANGED: {
    keyword: 'a shared source changes',
    describe: () => 'a shared source changes',
    needsValue: false,
  },
};

export const ACTIONS = {
  FLAG_DEPENDENTS: { describe: () => 'flag affected dependencies' },
  EXCLUDE_FROM_AUTOCOMPLETE: { describe: () => 'exclude from autocomplete' },
  MARK_SHARE_STALE: { describe: () => 'mark the share as potentially stale' },
};

/**
 * Parses the sentence form the terminal accepts:
 *   when source path starts with Finance/Q3 then flag affected dependencies
 * The vocabulary is closed; anything outside it is refused with the list of
 * what is understood rather than interpreted loosely.
 */
export function parseRuleSentence(text) {
  const source = String(text ?? '').trim().replace(/\s+/g, ' ');
  const match = source.match(/^when\s+(.+?)\s+then\s+(.+)$/i);
  if (!match) return { ok: false, reason: 'A rule reads: when <trigger> then <action>.' };
  const [, triggerText, actionText] = match;

  let trigger = null;
  for (const [kind, definition] of Object.entries(TRIGGERS)) {
    const pattern = new RegExp(`^${definition.keyword}\\s*(.*)$`, 'i');
    const found = triggerText.match(pattern);
    if (!found) continue;
    const value = found[1].trim().replace(/^["']|["']$/g, '');
    if (definition.needsValue && !value) continue;
    trigger = { kind, value: definition.needsValue ? value : '' };
    break;
  }
  if (!trigger) {
    return { ok: false, reason: `Understood triggers: ${Object.values(TRIGGERS).map((item) => item.keyword).join(', ')}.` };
  }

  const normalizedAction = actionText.toLowerCase();
  const action = /flag/.test(normalizedAction) ? 'FLAG_DEPENDENTS'
    : /exclude|never suggest|suppress/.test(normalizedAction) ? 'EXCLUDE_FROM_AUTOCOMPLETE'
    : /stale/.test(normalizedAction) ? 'MARK_SHARE_STALE'
    : null;
  if (!action) {
    return { ok: false, reason: 'Understood actions: flag affected dependencies, exclude from autocomplete, mark the share as potentially stale.' };
  }
  return { ok: true, trigger, action };
}

export class RuleService {
  constructor(db, timeline) {
    this.db = db;
    this.timeline = timeline;
  }

  map(row) {
    return {
      id: row.id,
      name: row.name,
      trigger: { kind: row.trigger_kind, value: row.trigger_value },
      triggerText: TRIGGERS[row.trigger_kind].describe(row.trigger_value),
      action: { kind: row.action_kind, value: row.action_value },
      actionText: ACTIONS[row.action_kind].describe(row.action_value),
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
    };
  }

  list(projectId, options = {}) {
    return this.db.prepare('SELECT * FROM terminal_rules WHERE project_id = ? ORDER BY created_at')
      .all(projectId)
      .map((row) => this.map(row))
      .filter((rule) => !options.enabledOnly || rule.enabled);
  }

  find(projectId, reference) {
    const rules = this.list(projectId);
    const index = Number(reference);
    if (Number.isInteger(index) && index >= 1 && index <= rules.length) return rules[index - 1];
    const name = slug(reference);
    return rules.find((rule) => slug(rule.name) === name) ?? null;
  }

  add(projectId, { name, sentence }, actorInput) {
    const parsed = parseRuleSentence(sentence);
    if (!parsed.ok) throw new HttpError(400, parsed.reason);
    const actor = normalizeActor(actorInput);
    this.timeline.upsertActor(actor);
    const ruleName = String(name ?? '').trim()
      || `${TRIGGERS[parsed.trigger.kind].describe(parsed.trigger.value)} → ${ACTIONS[parsed.action].describe()}`;
    if (this.list(projectId).some((rule) => slug(rule.name) === slug(ruleName))) {
      throw new HttpError(409, `A rule named ${ruleName} already exists.`);
    }
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO terminal_rules(id, project_id, name, trigger_kind, trigger_value, action_kind, action_value, enabled, created_by_actor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, projectId, ruleName, parsed.trigger.kind, parsed.trigger.value, parsed.action, '', actor.id, now());
    return this.map(this.db.prepare('SELECT * FROM terminal_rules WHERE id = ?').get(id));
  }

  remove(projectId, reference) {
    const rule = this.find(projectId, reference);
    if (!rule) throw new HttpError(404, `No rule matches ${reference}.`);
    this.db.prepare('DELETE FROM terminal_rules WHERE id = ?').run(rule.id);
    return rule;
  }

  setEnabled(projectId, reference, enabled) {
    const rule = this.find(projectId, reference);
    if (!rule) throw new HttpError(404, `No rule matches ${reference}.`);
    this.db.prepare('UPDATE terminal_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, rule.id);
    return { ...rule, enabled };
  }

  /** Paths a rule tells autocomplete to skip, read by the editor's suggestions. */
  suppressedPathPrefixes(projectId) {
    return this.list(projectId, { enabledOnly: true })
      .filter((rule) => rule.action.kind === 'EXCLUDE_FROM_AUTOCOMPLETE' && rule.trigger.kind === 'SOURCE_PATH_PREFIX')
      .map((rule) => rule.trigger.value.replace(/\/+$/, ''));
  }

  /**
   * Runs every enabled rule against a set of recorded changes and records the
   * flags they raise. Called after a capture; idempotent per subject.
   */
  evaluate(projectId, { changes = [], shares = [] } = {}) {
    const rules = this.list(projectId, { enabledOnly: true });
    if (!rules.length) return [];
    const raised = [];
    const insert = this.db.prepare(`
      INSERT INTO terminal_rule_flags(id, project_id, rule_id, subject_kind, subject_key, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rule_id, subject_kind, subject_key)
      DO UPDATE SET detail_json = excluded.detail_json, created_at = excluded.created_at, cleared_at = NULL
    `);

    for (const rule of rules) {
      if (rule.action.kind === 'EXCLUDE_FROM_AUTOCOMPLETE') continue;
      for (const change of changes) {
        const prefix = rule.trigger.value.replace(/\/+$/, '');
        // A share is only implicated by a change that happened after it was
        // created; a share made from the current value is not stale.
        const affectedShares = shares.filter((share) => share.objectId === change.objectId
          && share.status === 'active'
          && String(share.createdAt) <= String(change.changedAt));
        const matches = rule.trigger.kind === 'SOURCE_PATH_PREFIX'
          ? `${change.path}/`.startsWith(`${prefix}/`) || change.path === prefix
          : rule.trigger.kind === 'DEPENDENCY_NAME'
            ? change.name === slug(rule.trigger.value)
            : rule.trigger.kind === 'SHARED_SOURCE_CHANGED'
              ? affectedShares.length > 0
              : false;
        if (!matches) continue;
        const subjectKind = rule.action.kind === 'MARK_SHARE_STALE' ? 'SHARE' : 'OBJECT';
        const subjects = subjectKind === 'SHARE' ? affectedShares.map((share) => share.token) : [change.objectId];
        if (!subjects.length) continue;
        for (const subject of subjects) {
          const detail = {
            name: change.name,
            path: change.path,
            previousValue: change.previousValue,
            currentValue: change.currentValue,
            references: change.referenceCount,
          };
          insert.run(crypto.randomUUID(), projectId, rule.id, subjectKind, subject, JSON.stringify(detail), now());
          raised.push({ rule: rule.name, ruleId: rule.id, subjectKind, subject, detail });
        }
      }
    }
    return raised;
  }

  flags(projectId, options = {}) {
    return this.db.prepare(`
      SELECT f.*, r.name AS rule_name, r.action_kind
      FROM terminal_rule_flags f
      JOIN terminal_rules r ON r.id = f.rule_id
      WHERE f.project_id = ? AND f.cleared_at IS NULL
      ORDER BY f.created_at DESC
    `).all(projectId)
      .filter((row) => !options.subjectKind || row.subject_kind === options.subjectKind)
      .map((row) => ({
        id: row.id,
        rule: row.rule_name,
        action: row.action_kind,
        subjectKind: row.subject_kind,
        subject: row.subject_key,
        detail: JSON.parse(row.detail_json),
        createdAt: row.created_at,
      }));
  }

  clearFlags(projectId, subjectKind, subjectKey) {
    this.db.prepare(`
      UPDATE terminal_rule_flags SET cleared_at = ?
      WHERE project_id = ? AND subject_kind = ? AND subject_key = ? AND cleared_at IS NULL
    `).run(now(), projectId, subjectKind, subjectKey);
  }
}
