// An agent's proposed edit to a file of a folder: proposed against the bytes
// the agent read, approved (which writes the file and records the change as a
// capture) or rejected, and looked up again by its execution. Installed on
// TimelineService by service.js.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { json, transaction } from '../db.js';
import { normalizeActor } from './actors.js';
import { hashBuffer } from './blob-store.js';
import { createStructuredDiff } from './diff.js';
import { HttpError, VersionConflictError } from './errors.js';

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

export const agentEditMethods = {
  resolveProjectPath(project, relativePath) {
    this.drives?.assertOnline(project.id);
    if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
      throw new HttpError(400, 'A relative project file path is required.');
    }
    const root = path.resolve(project.rootPath);
    const destination = path.resolve(root, relativePath);
    if (destination === root || !destination.startsWith(`${root}${path.sep}`)) {
      throw new HttpError(400, 'File path escapes the project directory.');
    }
    // A directory can have been replaced by a symlink since it was indexed.
    // The scanner skips symlinks, so writes must apply the same boundary.
    let current = root;
    for (const part of ['', ...path.relative(root, destination).split(path.sep)]) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
      if (stat.isSymbolicLink()) throw new HttpError(409, 'The project file path now contains a symbolic link. Reopen the directory before editing.');
      if (current !== destination && !stat.isDirectory()) throw new HttpError(409, 'The project file directory has changed.');
    }
    return destination;
  },

  assertWorkingFileUnchanged(project, relativePath, expectedHash) {
    const destination = this.resolveProjectPath(project, relativePath);
    let actualHash = null;
    try { actualHash = hashBuffer(fs.readFileSync(destination)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (actualHash !== expectedHash) {
      throw new HttpError(409, 'The file changed on disk. Reload its latest version before applying this edit.');
    }
    return destination;
  },

  proposeAgentEdit(projectId, input) {
    const project = this.getProject(projectId);
    const agent = normalizeActor(input.agent, 'AI_AGENT');
    if (agent.actorType !== 'AI_AGENT') throw new HttpError(400, 'Agent edits require an AI_AGENT actor.');
    const initiatedBy = normalizeActor(input.initiatedBy, 'HUMAN_SELF');
    if (!['HUMAN_SELF', 'HUMAN_COLLABORATOR'].includes(initiatedBy.actorType)) {
      throw new HttpError(400, 'Agent edit initiator must be a human actor.');
    }
    const baseSnapshotId = input.baseSnapshotId ?? project.currentSnapshotId;
    if (baseSnapshotId !== project.currentSnapshotId) throw new VersionConflictError(baseSnapshotId, project.currentSnapshotId);
    const relativePath = String(input.path ?? '').split(path.sep).join('/');
    this.resolveProjectPath(project, relativePath);
    const previousFile = this.snapshotFile(baseSnapshotId, relativePath);
    const beforeBuffer = previousFile ? this.blobs.get(previousFile.contentHash) : null;
    const afterBuffer = Buffer.from(String(input.content ?? ''), 'utf8');
    const fileType = previousFile?.fileType ?? 'text';
    const proposedHash = this.blobs.put(afterBuffer);
    const structuredDiff = createStructuredDiff({
      fileType,
      filePath: relativePath,
      beforeBuffer,
      afterBuffer,
      changeType: previousFile ? 'MODIFIED' : 'ADDED',
    });
    const executionId = id();
    const proposal = {
      path: relativePath,
      contentHashBefore: previousFile?.contentHash ?? null,
      contentHashAfter: proposedHash,
      changeType: previousFile ? 'MODIFIED' : 'ADDED',
      structuredDiff,
      provenance: Array.isArray(input.provenance) ? input.provenance : [],
      dependencyProposals: input.dependencyProposals
        ?? this.dependencies?.predictAgentDependencies(projectId, input)
        ?? [],
    };
    transaction(this.db, () => {
      this.upsertActor(agent);
      this.upsertActor(initiatedBy);
      this.db.prepare(`
        INSERT INTO agent_executions(id, project_id, agent_actor_id, initiated_by_actor_id, request_text, base_snapshot_id, status, proposal_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?)
      `).run(executionId, projectId, agent.id, initiatedBy.id, String(input.request ?? ''), baseSnapshotId, JSON.stringify(proposal), now());
    });
    return { id: executionId, status: 'PROPOSED', baseSnapshotId, agent, initiatedBy, request: String(input.request ?? ''), proposal };
  },

  getExecution(executionId) {
    const row = this.db.prepare(`
      SELECT x.*, a.display_name AS agent_name, a.actor_type AS agent_type,
        i.display_name AS initiator_name, i.actor_type AS initiator_type
      FROM agent_executions x
      JOIN actors a ON a.id = x.agent_actor_id
      LEFT JOIN actors i ON i.id = x.initiated_by_actor_id
      WHERE x.id = ?
    `).get(executionId);
    if (!row) throw new HttpError(404, 'Agent execution not found.');
    return {
      id: row.id,
      projectId: row.project_id,
      baseSnapshotId: row.base_snapshot_id,
      status: row.status,
      request: row.request_text,
      proposal: json(row.proposal_json, {}),
      agent: { id: row.agent_actor_id, displayName: row.agent_name, actorType: row.agent_type },
      initiatedBy: row.initiated_by_actor_id
        ? { id: row.initiated_by_actor_id, displayName: row.initiator_name, actorType: row.initiator_type }
        : null,
      createdAt: row.created_at,
      appliedAt: row.applied_at,
    };
  },

  approveAgentEdit(executionId) {
    const execution = this.getExecution(executionId);
    if (execution.status !== 'PROPOSED') throw new HttpError(409, 'Only proposed agent edits can be applied.');
    const project = this.getProject(execution.projectId);
    if (project.currentSnapshotId !== execution.baseSnapshotId) {
      this.db.prepare("UPDATE agent_executions SET status = 'CONFLICT' WHERE id = ?").run(executionId);
      throw new VersionConflictError(execution.baseSnapshotId, project.currentSnapshotId);
    }
    const proposal = execution.proposal;
    const currentFile = this.snapshotFile(project.currentSnapshotId, proposal.path);
    if ((currentFile?.contentHash ?? null) !== proposal.contentHashBefore) {
      this.db.prepare("UPDATE agent_executions SET status = 'CONFLICT' WHERE id = ?").run(executionId);
      throw new HttpError(409, 'The target file no longer matches the proposed before version.');
    }
    let destination;
    try { destination = this.assertWorkingFileUnchanged(project, proposal.path, proposal.contentHashBefore); }
    catch (error) {
      if (error.status === 409) this.db.prepare("UPDATE agent_executions SET status = 'CONFLICT' WHERE id = ?").run(executionId);
      throw error;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.lasso-${executionId}.tmp`;
    fs.writeFileSync(temporary, this.blobs.get(proposal.contentHashAfter), { flag: 'wx' });
    fs.renameSync(temporary, destination);

    const capture = this.capture(execution.projectId, execution.agent, {
      expectedSnapshotId: execution.baseSnapshotId,
      initiatedBy: execution.initiatedBy,
      source: 'AGENT_EDIT',
      agentExecutionId: execution.id,
    });
    this.db.prepare("UPDATE agent_executions SET status = 'APPLIED', applied_at = ? WHERE id = ?")
      .run(now(), executionId);
    for (const link of proposal.provenance ?? []) {
      this.addProvenanceLink(execution.projectId, {
        fromSnapshotId: capture.snapshot.id,
        fromPath: proposal.path,
        fromAnchor: link.fromAnchor ?? null,
        relation: link.relation,
        toSnapshotId: link.toSnapshotId ?? execution.baseSnapshotId,
        toPath: link.toPath ?? null,
        toAnchor: link.toAnchor ?? null,
        metadata: link.metadata ?? {},
        createdByEventId: capture.event?.id ?? null,
      });
    }
    const appliedExecution = this.getExecution(executionId);
    const dependencyLinks = this.dependencies?.acceptAgentDependencies(appliedExecution, capture) ?? [];
    return { ...capture, execution: appliedExecution, dependencyLinks };
  },

  rejectAgentEdit(executionId) {
    const execution = this.getExecution(executionId);
    if (execution.status !== 'PROPOSED') throw new HttpError(409, 'Only proposed agent edits can be rejected.');
    this.db.prepare("UPDATE agent_executions SET status = 'REJECTED' WHERE id = ?").run(executionId);
    return this.getExecution(executionId);
  },
};
