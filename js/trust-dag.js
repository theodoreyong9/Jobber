// trust-dag.js — a grow-only set of content-addressed events, linked by
// causal parents. No global clock, no total order on insert; merging two
// independently-collected histories of the same events is a pure,
// commutative set union. Ported from the AIWA_chain repo's own
// public/core/event-dag.js and public/core/weighted-median.js — both are
// fully generic, no AIWA-specific concept (wallets, burns, Solana) baked
// in, so they carry over here unchanged in substance. See credibility.js
// for what Jobber actually builds on top of them.

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
    return sorted;
  }
  return value;
}

export class EventDag {
  constructor() {
    this._events = new Map();
  }

  async computeId(parents, payload) {
    const canonical = canonicalize({ parents: [...parents].sort(), payload });
    const data = new TextEncoder().encode(JSON.stringify(canonical));
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async addEvent(parents, payload) {
    for (const p of parents) {
      if (!this._events.has(p)) throw new Error(`Unknown parent: ${p}`);
    }
    const id = await this.computeId(parents, payload);
    if (!this._events.has(id)) {
      this._events.set(id, { id, parents: [...parents], payload });
    }
    return id;
  }

  // A real, fast bulk-load path — trusts each event's own stored id rather
  // than recomputing it. Safe ONLY for events already verified once, at
  // genuine creation time, and now being restored from this exact same
  // browser's own local, trusted storage (IndexedDB) — never for events
  // from a genuinely external source (a proof shared by another peer),
  // where addEvent()'s real recomputation remains the whole point.
  // Silently skips an event whose parent isn't yet present, rather than
  // throwing — dropped, not misplaced, if ever handed out of causal order.
  loadTrusted(events) {
    for (const ev of events) {
      if (this._events.has(ev.id)) continue;
      if (!ev.parents.every((p) => this._events.has(p))) continue;
      this._events.set(ev.id, { id: ev.id, parents: [...ev.parents], payload: ev.payload });
    }
  }

  merge(otherDag) {
    for (const ev of otherDag._events.values()) {
      if (!this._events.has(ev.id)) this._events.set(ev.id, ev);
    }
  }

  topoOrder() {
    const visited = new Set();
    const order = [];
    const visit = (id) => {
      if (visited.has(id)) return;
      visited.add(id);
      const ev = this._events.get(id);
      for (const p of [...ev.parents].sort()) visit(p);
      order.push(ev);
    };
    for (const id of [...this._events.keys()].sort()) visit(id);
    return order;
  }

  materialize(reducer, initialState) {
    return this.topoOrder().reduce((state, ev) => reducer(state, ev), initialState);
  }

  get size() {
    return this._events.size;
  }
}

// A minority of adversarial weight cannot pull a weighted median
// arbitrarily, as long as its total weight stays below half. Pure, no
// domain-specific knowledge of what "weight" means — not used yet in
// credibility.js's first pass (which only ever folds a single browser's
// own observations), but this is the primitive that lets a later version
// combine several *independent* observers' estimates of the same
// identity without one loud or repeated voice dominating.
export function weightedMedian(estimates) {
  if (estimates.length === 0) throw new Error('weightedMedian requires at least one estimate');
  const totalWeight = estimates.reduce((sum, e) => sum + e.weight, 0);
  if (!(totalWeight > 0)) throw new Error('total weight must be positive');

  const sorted = [...estimates].sort((a, b) => a.value - b.value);
  let cumulative = 0;
  for (const e of sorted) {
    cumulative += e.weight;
    if (cumulative >= totalWeight / 2) return e.value;
  }
  return sorted[sorted.length - 1].value; // unreachable in practice, a safe fallback
}
