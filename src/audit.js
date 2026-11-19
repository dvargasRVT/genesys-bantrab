// Read-only audit report tool. Genesys audit queries are POSTs that create an
// async job; this tool runs one job for an interval of at most 30 days, waits
// for it, walks every page of results, and returns COMPACT rows (CSV) instead
// of the raw audit events, which are ~1 KB each. Nothing in the org changes.

import { GenesysError } from './genesys.js';

const DAY = 86400000;
const MAX_DAYS = 30;
const RETENTION_DAYS = 365;
const POLL_MS = 2000;
const MAX_POLLS = 45;
const MAX_PAGES = 40;

const REPORTS = {
  users_created: {
    serviceName: 'Directory',
    filters: [{ property: 'EntityType', value: 'User' }, { property: 'Action', value: 'Create' }],
    header: ['eventDate', 'actorId', 'level', 'newUserId', 'name', 'email', 'title', 'department', 'divisionId'],
    row: (e) => {
      const p = Object.fromEntries((e.propertyChanges || []).map((c) => [c.property, (c.newValues || [])[0] ?? '']));
      return [e.eventDate, e.user?.id || '', e.level, e.entity?.id || '', p.name, p.email, p.title, p.department, p.divisionId];
    },
  },
  role_changes: {
    serviceName: 'PeoplePermissions',
    filters: [{ property: 'EntityType', value: 'Role' }],
    header: ['eventDate', 'actorId', 'level', 'action', 'targetUserId', 'roleId', 'divisionId'],
    row: (e) => {
      // Role grant events name the entity "<userId>--<roleId>--<divisionId>".
      const [target = '', role = e.entity?.id || '', division = ''] = String(e.entity?.name || '').split('--');
      return [e.eventDate, e.user?.id || '', e.level, e.action, target, role, division];
    },
  },
};

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n');

function parseDate(s, label) {
  const t = Date.parse(s);
  if (typeof s !== 'string' || Number.isNaN(t)) throw new GenesysError(`${label} must be an ISO date like 2026-03-01 or 2026-03-01T00:00:00Z.`, 400);
  return t;
}

export function checkInterval(start, end, now = Date.now()) {
  const a = parseDate(start, 'start');
  const b = parseDate(end, 'end');
  if (b <= a) throw new GenesysError('end must be after start.', 400);
  if (b - a > MAX_DAYS * DAY) throw new GenesysError(`The interval may span at most ${MAX_DAYS} days (a Genesys limit); call the tool once per window.`, 400);
  if (a < now - RETENTION_DAYS * DAY) throw new GenesysError(`Genesys keeps audit events for ${RETENTION_DAYS} days; start must be on or after ${new Date(now - RETENTION_DAYS * DAY).toISOString().slice(0, 10)}.`, 400);
  return `${new Date(a).toISOString()}/${new Date(b).toISOString()}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runAuditReport(gc, args, { pollMs = POLL_MS } = {}) {
  const spec = REPORTS[args.report];
  if (!spec) throw new GenesysError(`report must be one of: ${Object.keys(REPORTS).join(', ')}.`, 400);
  const interval = checkInterval(args.start, args.end);
  const job = await gc.post('/api/v2/audits/query', { interval, serviceName: spec.serviceName, filters: spec.filters });
  if (!job?.id) throw new GenesysError('Genesys did not return an audit query id.', 502);

  let page;
  for (let i = 0; ; i++) {
    try {
      page = await gc.get(`/api/v2/audits/query/${job.id}/results`, { pageSize: 500 });
      break;
    } catch (e) {
      if (!/not completed/i.test(e.message) || i >= MAX_POLLS) throw e;
      await sleep(pollMs);
    }
  }

  const rows = [];
  let pages = 0;
  for (;;) {
    for (const e of page.entities || []) {
      if (args.user_level_only && e.level !== 'USER') continue;
      rows.push(spec.row(e));
    }
    pages++;
    if (!page.cursor || pages >= MAX_PAGES) break;
    page = await gc.get(`/api/v2/audits/query/${job.id}/results`, { pageSize: 500, cursor: page.cursor });
  }

  // Name the people who acted, so the report says who, not just an id.
  const actorIds = [...new Set(rows.map((r) => r[1]).filter(Boolean))];
  const actors = {};
  for (const id of actorIds) {
    try {
      const u = await gc.get(`/api/v2/users/${id}`, { state: 'any' });
      actors[id] = { name: u.name, email: u.email, state: u.state };
    } catch {
      actors[id] = { name: '(unknown or deleted user)' };
    }
  }

  return {
    report: args.report,
    interval,
    events: rows.length,
    truncated: Boolean(page.cursor) && pages >= MAX_PAGES,
    actors,
    note: 'level SYSTEM = done by Genesys itself (defaults, automatic cleanup), with no person behind it.',
    csv: toCsv([spec.header, ...rows]),
  };
}

export const AUDIT_TOOL = {
  name: 'audit_report',
  description: 'Read-only audit report (changes nothing). Runs one Genesys audit query for an interval of at most 30 days (within the 365-day retention), waits for it, and returns compact CSV rows plus the names of the people who acted. report "users_created": who created which users. report "role_changes": who added/removed which role for which user, in which division (MemberAdd / MemberRemove / MemberUpdate). Call once per 30-day window for longer periods.',
  inputSchema: {
    type: 'object',
    properties: {
      report: { type: 'string', enum: Object.keys(REPORTS) },
      start: { type: 'string', description: 'Start of the window, ISO date (UTC), e.g. 2026-03-01' },
      end: { type: 'string', description: 'End of the window, ISO date (UTC), at most 30 days after start' },
      user_level_only: { type: 'boolean', description: 'Drop SYSTEM-level events (done by Genesys itself), keeping only actions by a person or client.' },
    },
    required: ['report', 'start', 'end'],
    additionalProperties: false,
  },
  handler: (gc, a) => runAuditReport(gc, a),
};
