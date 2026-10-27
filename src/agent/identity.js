// Who an agent is, as the store records it. The identity comes from the
// connection (the MCP client's name, the REST token's owner), and the actor
// type is always AI_AGENT: no request field can make an agent a person.

export function slugActor(id, displayName) {
  const clean = String(id).toLowerCase().replace(/[^a-z0-9:._-]+/g, '-').slice(0, 120);
  return { id: clean, displayName: String(displayName).slice(0, 120), actorType: 'AI_AGENT' };
}
