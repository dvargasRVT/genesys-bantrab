import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAuditReport, checkInterval, toCsv } from '../src/audit.js';
import { GenesysError } from '../src/genesys.js';
import { TOOLS, WRITE_TOOLS } from '../src/tools.js';

const NOW = Date.parse('2026-11-19T00:00:00Z');

test('checkInterval enforces the 30-day window and 365-day retention', () => {
  assert.equal(checkInterval('2026-10-20', '2026-11-19', NOW), '2026-10-20T00:00:00.000Z/2026-11-19T00:00:00.000Z');
  assert.throws(() => checkInterval('2026-03-01', '2026-11-19', NOW), /at most 30 days/);
  assert.throws(() => checkInterval('2025-11-01', '2025-11-30', NOW), /365 days/);
  assert.throws(() => checkInterval('2026-11-19', '2026-11-01', NOW), /after start/);
  assert.throws(() => checkInterval('ayer', '2026-11-01', NOW), /ISO date/);
});

test('toCsv quotes commas and quotes', () => {
  assert.equal(toCsv([['a', 'b,c', 'd"e']]), 'a,"b,c","d""e"');
});

function fakeClient(pages, { pendingPolls = 1 } = {}) {
  const calls = [];
  let polls = 0;
  return {
    calls,
    async post(path, body) { calls.push(['POST', path, body]); return { id: 'job1' }; },
    async get(path, query) {
      calls.push(['GET', path, query]);
      if (path.startsWith('/api/v2/users/')) return { name: 'Gestion de Redes', email: 'redesti@example.com', state: 'active' };
      if (polls++ < pendingPolls) throw new GenesysError('Query execution not completed for id [job1]', 400);
      return query.cursor ? pages[1] : pages[0];
    },
  };
}

test('role_changes: polls, pages, splits the grant name, and names the actor', async () => {
  const ev = (level, action, name, actor) => ({ eventDate: '2026-10-23T17:27:30Z', level, action, user: actor ? { id: actor } : {}, entity: { id: 'r1', name } });
  const gc = fakeClient([
    { cursor: 'c2', entities: [ev('USER', 'MemberAdd', 'u1--r1--d1', 'a1')] },
    { entities: [ev('SYSTEM', 'MemberRemove', 'u2--r2--d2', null)] },
  ]);
  const r = await runAuditReport(gc, { report: 'role_changes', start: '2026-10-20', end: '2026-11-19' }, { pollMs: 0 });
  assert.equal(r.events, 2);
  assert.equal(r.csv.split('\n')[1], '2026-10-23T17:27:30Z,a1,USER,MemberAdd,u1,r1,d1');
  assert.equal(r.csv.split('\n')[2], '2026-10-23T17:27:30Z,,SYSTEM,MemberRemove,u2,r2,d2');
  assert.equal(r.actors.a1.name, 'Gestion de Redes');
  assert.deepEqual(gc.calls[0], ['POST', '/api/v2/audits/query', { interval: '2026-10-20T00:00:00.000Z/2026-11-19T00:00:00.000Z', serviceName: 'PeoplePermissions', filters: [{ property: 'EntityType', value: 'Role' }] }]);
  assert.ok(gc.calls.every(([m, p]) => m === 'GET' || p === '/api/v2/audits/query'), 'only the audit query is a POST');
});

test('user_level_only drops SYSTEM events; users_created reads the new user fields', async () => {
  const gc = fakeClient([{ entities: [
    { eventDate: 'd', level: 'USER', user: { id: 'a1' }, entity: { id: 'n1' }, propertyChanges: [{ property: 'name', newValues: ['Ana, H'] }, { property: 'email', newValues: ['ana@x.com'] }] },
    { eventDate: 'd', level: 'SYSTEM', user: {}, entity: { id: 'n2' }, propertyChanges: [] },
  ] }], { pendingPolls: 0 });
  const r = await runAuditReport(gc, { report: 'users_created', start: '2026-10-20', end: '2026-11-19', user_level_only: true }, { pollMs: 0 });
  assert.equal(r.events, 1);
  assert.equal(r.csv.split('\n')[1], 'd,a1,USER,n1,"Ana, H",ana@x.com,,,');
});

test('unknown report is refused; audit_report is registered as a read tool', async () => {
  await assert.rejects(() => runAuditReport(fakeClient([]), { report: 'x', start: '2026-10-20', end: '2026-11-19' }), /report must be one of/);
  assert.ok(TOOLS.some((t) => t.name === 'audit_report'));
  assert.ok(!WRITE_TOOLS.has('audit_report'));
});
