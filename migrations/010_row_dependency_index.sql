-- Row identifiers are first-class dependency targets rather than aliases for an arbitrary cell.
-- Re-running the immutable object index inserts the new row objects while retaining existing versions.
DELETE FROM snapshot_object_indexes;
