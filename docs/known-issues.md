# Known issues

A running log of bugs we've spotted but haven't fixed yet, so they don't get
lost. Newest first. When one is fixed, move it to the commit that fixes it (or
delete it) rather than leaving it here stale.

---

_None open right now._

<!--
Resolved:
- Phylactery `UNIQUE constraint failed on memory_vecs primary key` during
  embedding — fixed 0.7.32. Root cause: the embedding write used
  `INSERT OR REPLACE`, but sqlite-vec (vec0) virtual tables don't honor
  OR-REPLACE / UPSERT conflict resolution, so re-embedding an existing
  memory_id/node_id raised the UNIQUE error instead of replacing. Fixed in
  memory.py + graph.py with delete-then-insert (see tests/test_vec_upsert.py).
-->
