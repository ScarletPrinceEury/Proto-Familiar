import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionForFeature, primaryConnectionFrom } from '../cerebellum.js';

// ── primaryConnectionFrom: locate the primary connection ────────────────────

test('primaryConnectionFrom: finds connection matching primaryConnectionId', () => {
  const settings = {
    primaryConnectionId: 'primary-1',
    connections: [
      { id: 'primary-1', apiKey: 'key1', model: 'gpt-4' },
      { id: 'other', apiKey: 'key2', model: 'claude-opus' },
    ],
  };
  const conn = primaryConnectionFrom(settings);
  assert.equal(conn.id, 'primary-1');
  assert.equal(conn.apiKey, 'key1');
});

test('primaryConnectionFrom: returns null if primaryConnectionId is unset', () => {
  const settings = {
    primaryConnectionId: undefined,
    connections: [{ id: 'conn-1', apiKey: 'key1', model: 'gpt-4' }],
  };
  assert.equal(primaryConnectionFrom(settings), null);
});

test('primaryConnectionFrom: returns null if primaryConnectionId points to nonexistent id', () => {
  const settings = {
    primaryConnectionId: 'does-not-exist',
    connections: [{ id: 'conn-1', apiKey: 'key1', model: 'gpt-4' }],
  };
  assert.equal(primaryConnectionFrom(settings), null);
});

test('primaryConnectionFrom: returns null if connections array is absent', () => {
  const settings = {
    primaryConnectionId: 'primary-1',
    connections: undefined,
  };
  assert.equal(primaryConnectionFrom(settings), null);
});

test('primaryConnectionFrom: returns null if settings is null', () => {
  assert.equal(primaryConnectionFrom(null), null);
});

test('primaryConnectionFrom: returns null if settings is undefined', () => {
  assert.equal(primaryConnectionFrom(undefined), null);
});

// ── connectionForFeature: feature-specific assignment routing ────────────────

test('connectionForFeature: assigned connection with apiKey+model returns that connection', () => {
  const settings = {
    primaryConnectionId: 'primary',
    featureConnections: { pondering: 'custom' },
    connections: [
      { id: 'primary', apiKey: 'pk', model: 'pm' },
      { id: 'custom', apiKey: 'ck', model: 'cm' },
    ],
  };
  const conn = connectionForFeature(settings, 'pondering');
  assert.equal(conn.id, 'custom');
  assert.equal(conn.apiKey, 'ck');
  assert.equal(conn.model, 'cm');
});

test('connectionForFeature: no assignment for feature falls back to primary', () => {
  const settings = {
    primaryConnectionId: 'primary',
    featureConnections: {}, // empty, no assignment for 'pondering'
    connections: [
      { id: 'primary', apiKey: 'pk', model: 'pm' },
      { id: 'other', apiKey: 'ok', model: 'om' },
    ],
  };
  const conn = connectionForFeature(settings, 'pondering');
  assert.equal(conn.id, 'primary');
});

test('connectionForFeature: assigned id is stale (not in connections) falls back to primary', () => {
  const settings = {
    primaryConnectionId: 'primary',
    featureConnections: { triage: 'stale-id' },
    connections: [
      { id: 'primary', apiKey: 'pk', model: 'pm' },
      { id: 'other', apiKey: 'ok', model: 'om' },
    ],
  };
  const conn = connectionForFeature(settings, 'triage');
  assert.equal(conn.id, 'primary');
});

test('connectionForFeature: assigned connection missing apiKey falls back to primary', () => {
  const settings = {
    primaryConnectionId: 'primary',
    featureConnections: { pondering: 'incomplete' },
    connections: [
      { id: 'primary', apiKey: 'pk', model: 'pm' },
      { id: 'incomplete', model: 'im' }, // no apiKey
    ],
  };
  const conn = connectionForFeature(settings, 'pondering');
  assert.equal(conn.id, 'primary');
});

test('connectionForFeature: assigned connection missing model falls back to primary', () => {
  const settings = {
    primaryConnectionId: 'primary',
    featureConnections: { pondering: 'incomplete' },
    connections: [
      { id: 'primary', apiKey: 'pk', model: 'pm' },
      { id: 'incomplete', apiKey: 'ik' }, // no model
    ],
  };
  const conn = connectionForFeature(settings, 'pondering');
  assert.equal(conn.id, 'primary');
});

test('connectionForFeature: featureConnections is undefined returns primary', () => {
  const settings = {
    primaryConnectionId: 'primary',
    featureConnections: undefined,
    connections: [
      { id: 'primary', apiKey: 'pk', model: 'pm' },
    ],
  };
  const conn = connectionForFeature(settings, 'pondering');
  assert.equal(conn.id, 'primary');
});

test('connectionForFeature: no primary and no assignment returns null', () => {
  const settings = {
    primaryConnectionId: 'does-not-exist',
    featureConnections: {},
    connections: [
      { id: 'other', apiKey: 'ok', model: 'om' },
    ],
  };
  const conn = connectionForFeature(settings, 'pondering');
  assert.equal(conn, null);
});

test('connectionForFeature: different feature with assignment still returns primary for unassigned feature', () => {
  const settings = {
    primaryConnectionId: 'primary',
    featureConnections: { triage: 'custom' }, // triage is assigned
    connections: [
      { id: 'primary', apiKey: 'pk', model: 'pm' },
      { id: 'custom', apiKey: 'ck', model: 'cm' },
    ],
  };
  // pondering has no assignment, so should return primary
  const connPondering = connectionForFeature(settings, 'pondering');
  assert.equal(connPondering.id, 'primary');

  // triage has an assignment, should return custom
  const connTriage = connectionForFeature(settings, 'triage');
  assert.equal(connTriage.id, 'custom');
});

test('connectionForFeature: multiple features with independent assignments', () => {
  const settings = {
    primaryConnectionId: 'primary',
    featureConnections: {
      triage: 'custom-triage',
      pondering: 'custom-ponder',
    },
    connections: [
      { id: 'primary', apiKey: 'pk', model: 'pm' },
      { id: 'custom-triage', apiKey: 'tk', model: 'tm' },
      { id: 'custom-ponder', apiKey: 'ponk', model: 'ponm' },
    ],
  };
  const triageConn = connectionForFeature(settings, 'triage');
  const ponderConn = connectionForFeature(settings, 'pondering');
  assert.equal(triageConn.id, 'custom-triage');
  assert.equal(ponderConn.id, 'custom-ponder');
});

test('connectionForFeature: null settings returns null', () => {
  assert.equal(connectionForFeature(null, 'pondering'), null);
});

test('connectionForFeature: undefined settings returns null', () => {
  assert.equal(connectionForFeature(undefined, 'pondering'), null);
});

test('connectionForFeature: connections is not an array falls back to primary', () => {
  const settings = {
    primaryConnectionId: 'primary',
    featureConnections: { pondering: 'assigned' },
    connections: 'not-an-array',
  };
  const conn = connectionForFeature(settings, 'pondering');
  assert.equal(conn, null); // no valid primary path
});
