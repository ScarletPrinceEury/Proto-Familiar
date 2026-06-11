import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkAndFirePendingContacts,
  deliverToTrustedContact,
  CONTACT_ESCALATION_DELAY_MS,
} from '../cerebellum.js';

// ── checkAndFirePendingContacts — escalation deadlines ───────────
// All I/O injected: a fake outbox list, a meta recorder, a delivery
// recorder, and a fixed clock. No real settings / webhooks / files.

function triageItem(overrides = {}) {
  return {
    id:   'item-1',
    kind: 'triage',
    acknowledged: false,
    pendingContact: { name: 'Sam', message: 'please check on them', channel: 'discord' },
    contactDeadlineTs: 1_000_000,
    ...overrides,
  };
}

test('fires exactly one delivery once the deadline passes, marking delivered BEFORE the async fire', async () => {
  const events = [];
  const item = triageItem();
  const r = await checkAndFirePendingContacts({
    now: () => 1_000_001,                       // 1ms past deadline
    listOutboxFn:       async () => [item],
    updateOutboxMetaFn: async ({ id, meta }) => { events.push(['meta', id, meta]); },
    deliverFn:          async (args) => { events.push(['deliver', args]); return { ok: true }; },
  });
  assert.equal(r.fired, 1);
  // The double-delivery guard: pendingContact.delivered=true is written
  // before deliverFn runs.
  assert.equal(events[0][0], 'meta');
  assert.equal(events[0][2].pendingContact.delivered, true);
  assert.ok(events[0][2].pendingContact.deliveredAt);
  const deliverEvents = events.filter(e => e[0] === 'deliver');
  assert.equal(deliverEvents.length, 1);
  assert.deepEqual(deliverEvents[0][1], { name: 'Sam', message: 'please check on them', channel: 'discord' });
});

test('does NOT fire before the deadline', async () => {
  const deliveries = [];
  const r = await checkAndFirePendingContacts({
    now: () => 999_999,                         // 1ms before deadline
    listOutboxFn:       async () => [triageItem()],
    updateOutboxMetaFn: async () => { throw new Error('should not be called'); },
    deliverFn:          async (args) => { deliveries.push(args); return { ok: true }; },
  });
  assert.equal(r.fired, 0);
  assert.equal(deliveries.length, 0);
});

test('an acknowledged item never escalates (pendingOnly list excludes it)', async () => {
  // The pendingOnly outbox read is the acknowledgement veto: an acked
  // item simply never appears in the candidate list. Model that here —
  // the list is empty because the user acknowledged in time.
  const deliveries = [];
  const r = await checkAndFirePendingContacts({
    now: () => 5_000_000,
    listOutboxFn:       async () => [],
    updateOutboxMetaFn: async () => {},
    deliverFn:          async (args) => { deliveries.push(args); return { ok: true }; },
  });
  assert.equal(r.fired, 0);
  assert.equal(deliveries.length, 0);
});

test('an item already marked delivered does not re-fire', async () => {
  const deliveries = [];
  const item = triageItem({ pendingContact: { name: 'Sam', message: 'm', channel: 'discord', delivered: true } });
  const r = await checkAndFirePendingContacts({
    now: () => 5_000_000,
    listOutboxFn:       async () => [item],
    updateOutboxMetaFn: async () => {},
    deliverFn:          async (args) => { deliveries.push(args); return { ok: true }; },
  });
  assert.equal(r.fired, 0);
  assert.equal(deliveries.length, 0);
});

test('non-triage and no-pendingContact items are ignored', async () => {
  const deliveries = [];
  const r = await checkAndFirePendingContacts({
    now: () => 5_000_000,
    listOutboxFn: async () => [
      triageItem({ id: 'a', kind: 'reminder' }),
      triageItem({ id: 'b', pendingContact: undefined }),
    ],
    updateOutboxMetaFn: async () => {},
    deliverFn:          async (args) => { deliveries.push(args); return { ok: true }; },
  });
  assert.equal(r.fired, 0);
  assert.equal(deliveries.length, 0);
});

// ── deliverToTrustedContact — "no covert contact" invariant ──────

const SETTINGS = { trustedContacts: [{ name: 'Sam', channel: 'discord', webhook: 'https://discord.test/hook' }] };

test('successful delivery mirrors an outbound_alert to the outbox', async () => {
  const enqueued = [];
  const r = await deliverToTrustedContact({
    name: 'Sam', message: 'checking in', channel: 'discord',
    readSettings:    () => SETTINGS,
    fetchFn:         async () => ({ ok: true }),
    enqueueOutboxFn: async (item) => { enqueued.push(item); return { id: 'x' }; },
  });
  assert.equal(r.ok, true);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].kind, 'outbound_alert');
  assert.match(enqueued[0].title, /Reached out to Sam/);
  assert.match(enqueued[0].body, /checking in/);
});

test('FAILED delivery still mirrors to the outbox, with the error visible', async () => {
  const enqueued = [];
  const r = await deliverToTrustedContact({
    name: 'Sam', message: 'checking in', channel: 'discord',
    readSettings:    () => SETTINGS,
    fetchFn:         async () => ({ ok: false, status: 404, text: async () => 'unknown webhook' }),
    enqueueOutboxFn: async (item) => { enqueued.push(item); return { id: 'x' }; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /404/);
  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0].title, /delivery failed/);
  assert.match(enqueued[0].body, /unknown webhook/);
});

test('a thrown network error still mirrors to the outbox', async () => {
  const enqueued = [];
  const r = await deliverToTrustedContact({
    name: 'Sam', message: 'checking in', channel: 'discord',
    readSettings:    () => SETTINGS,
    fetchFn:         async () => { throw new Error('ECONNREFUSED'); },
    enqueueOutboxFn: async (item) => { enqueued.push(item); return { id: 'x' }; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0].title, /delivery failed/);
});

test('unknown contact returns contact_not_found without calling the webhook', async () => {
  let fetched = false;
  const r = await deliverToTrustedContact({
    name: 'Nobody', message: 'hi', channel: 'discord',
    readSettings:    () => SETTINGS,
    fetchFn:         async () => { fetched = true; return { ok: true }; },
    enqueueOutboxFn: async () => ({ id: 'x' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'contact_not_found');
  assert.equal(fetched, false);
});

// ── Escalation delay table sanity ────────────────────────────────

test('CONTACT_ESCALATION_DELAY_MS keeps severe shorter than high shorter than moderate', () => {
  assert.ok(CONTACT_ESCALATION_DELAY_MS.severe < CONTACT_ESCALATION_DELAY_MS.high);
  assert.ok(CONTACT_ESCALATION_DELAY_MS.high   < CONTACT_ESCALATION_DELAY_MS.moderate);
});
