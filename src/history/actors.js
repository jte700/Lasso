// Who did something in a folder's history: a person, an agent or Lasso itself.

import { ACTOR_TYPES } from '../config.js';
import { HttpError } from './errors.js';

/** An actor as history records it, with a type it knows and an id made from its name when it has none. */
export function normalizeActor(actor, fallbackType = 'HUMAN_SELF') {
  const candidate = actor ?? {};
  const actorType = ACTOR_TYPES.has(candidate.actorType) ? candidate.actorType : fallbackType;
  const displayName = String(candidate.displayName ?? '').trim();
  if (!displayName) throw new HttpError(400, 'Actor displayName is required.');
  return {
    id: String(candidate.id ?? `${actorType.toLowerCase()}:${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`),
    displayName,
    actorType,
  };
}
