/**
 * A cited-part link as it was made before PDFs, Word documents and text files
 * stopped offering one. Such links are out in the world and keep working, but
 * can no longer be created, so the grant is written as it was stored then.
 */
export function legacyCitedShare(app, { projectId, object, actor, excerpt = null }) {
  const share = app.objectShares.createShare({ projectId, objectId: object.id, versionId: object.versionId,
    actor, accessScope: 'DOCUMENT' });
  app.db.prepare('UPDATE object_share_grants SET access_scope = ?, excerpt_json = ? WHERE token = ?')
    .run('INDEXED', excerpt ? JSON.stringify(excerpt) : null, share.token);
  return share;
}
