// Vercel serverless function — Company Radar CRUD over data/radar.json in the
// private GitHub repo. Additive feature: it never touches job-status.json or any
// of the existing job-pipeline endpoints.
//
// Auth: X-Dashboard-Password header (same check as api/jobs.js).
// Reads/writes radar.json with the Git Data API blob→tree→commit pattern used
// everywhere else in this codebase (see api/action.js putJobStatus).

import crypto from 'crypto';
import { readGithubFile, writeGithubFile } from '../lib/github.js';
import { safeEqual } from '../lib/auth.mjs';

const GITHUB_API = 'https://api.github.com';
const RADAR_PATH = 'data/radar.json';

// Allowed enums — keep in sync with the dashboard. Unknown values are rejected so
// a typo can't silently corrupt the data model.
const COMPANY_STATUSES = ['researching', 'contacted', 'connected', 'active', 'archived'];
const CONTACT_STATUSES = ['not_contacted', 'contacted', 'replied', 'meeting_scheduled', 'ongoing'];

// ATS boards the scanner can resolve from a single slug (scanner/radarSource.mjs).
// Empty string = no board mapped yet (the company won't be scanned until set).
const ATS_BOARDS = ['', 'greenhouse', 'ashby', 'lever'];

// ── Read radar.json (handles the >1MB download_url case via the shared helper) ──
async function readRadar(githubToken, owner, repo) {
  const { exists, content } = await readGithubFile(githubToken, owner, repo, RADAR_PATH);
  // First run before radar.json is committed — start from an empty model.
  if (!exists) return { companies: {} };
  const parsed = JSON.parse(content);
  if (!parsed.companies || typeof parsed.companies !== 'object') parsed.companies = {};
  return parsed;
}

// ── Write radar.json via the shared Git Data API helper (blob → tree → commit → ref, with retry) ──
async function writeRadar(githubToken, owner, repo, content, message) {
  return writeGithubFile(
    githubToken, owner, repo, RADAR_PATH,
    JSON.stringify(content, null, 2) + '\n',
    message,
    { logTag: 'radar' },
  );
}

// ── Small helpers ────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function slugify(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Only copy known company fields from a client payload. Prevents arbitrary keys
// (or a client-sent contacts array) from overwriting server-managed structure.
const COMPANY_EDITABLE = ['company', 'url', 'slug', 'description', 'location', 'why', 'contactPriority', 'scannerEnabled', 'scanFrequency', 'atsBoard', 'atsSlug', 'status', 'linkedinResearch'];
const CONTACT_EDITABLE = ['name', 'role', 'mutualConnections', 'outreachType', 'dateContacted', 'replyReceived', 'replyDate', 'contactStatus', 'notes'];

function pick(src, keys) {
  const out = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const password    = process.env.DASHBOARD_PASSWORD;
  const githubToken = process.env.GH_TOKEN;
  const githubRepo  = process.env.GH_REPO;
  const [owner, repo] = githubRepo.split('/');

  // Auth — same X-Dashboard-Password header check as api/jobs.js.
  const headerPw = req.headers['x-dashboard-password'];
  if (!password || !headerPw || !safeEqual(headerPw, password)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!githubToken) return res.status(500).json({ error: 'GH_TOKEN not configured' });

  try {
    // ── GET: return the full radar ───────────────────────────────────────────
    if (req.method === 'GET') {
      const radar = await readRadar(githubToken, owner, repo);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(radar);
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const action = req.query.action;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const radar = await readRadar(githubToken, owner, repo);

    // ── POST ?action=add ─────────────────────────────────────────────────────
    if (action === 'add') {
      if (!body.company || !String(body.company).trim()) {
        return res.status(400).json({ error: 'company is required' });
      }
      if (body.status && !COMPANY_STATUSES.includes(body.status)) {
        return res.status(400).json({ error: `Invalid status: ${body.status}` });
      }
      if (body.atsBoard !== undefined && !ATS_BOARDS.includes(body.atsBoard)) {
        return res.status(400).json({ error: `Invalid atsBoard: ${body.atsBoard}` });
      }
      const id = crypto.randomUUID();
      const company = {
        id,
        company: String(body.company).trim(),
        url: body.url || '',
        slug: body.slug ? slugify(body.slug) : slugify(body.company),
        description: body.description || '',
        location: body.location || '',
        why: body.why || '',
        contactPriority: Array.isArray(body.contactPriority) ? body.contactPriority : [],
        scannerEnabled: !!body.scannerEnabled,
        scanFrequency: body.scanFrequency || null,
        // ATS board mapping so the scanner can resolve this company to a jobs board.
        atsBoard: body.atsBoard || '',
        atsSlug: body.atsSlug || '',
        status: body.status || 'researching',
        contacts: [],
        linkedinResearch: null,
        addedAt: todayISO(),
        lastActivity: todayISO(),
      };
      radar.companies[id] = company;
      await writeRadar(githubToken, owner, repo, radar, `chore: radar add ${company.company} [skip ci]`);
      return res.status(200).json({ success: true, company });
    }

    // All remaining actions operate on an existing company.
    const companyId = body.companyId || body.id;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    const company = radar.companies[companyId];
    if (!company) return res.status(404).json({ error: 'Company not found' });

    // ── POST ?action=update ──────────────────────────────────────────────────
    if (action === 'update') {
      const updates = pick(body, COMPANY_EDITABLE);
      if (updates.status && !COMPANY_STATUSES.includes(updates.status)) {
        return res.status(400).json({ error: `Invalid status: ${updates.status}` });
      }
      if (updates.atsBoard !== undefined && !ATS_BOARDS.includes(updates.atsBoard)) {
        return res.status(400).json({ error: `Invalid atsBoard: ${updates.atsBoard}` });
      }
      if (updates.slug !== undefined) updates.slug = slugify(updates.slug);
      Object.assign(company, updates);
      company.lastActivity = todayISO();
      await writeRadar(githubToken, owner, repo, radar, `chore: radar update ${company.company} [skip ci]`);
      return res.status(200).json({ success: true, company });
    }

    // ── POST ?action=archive ─────────────────────────────────────────────────
    if (action === 'archive') {
      company.status = 'archived';
      company.lastActivity = todayISO();
      await writeRadar(githubToken, owner, repo, radar, `chore: radar archive ${company.company} [skip ci]`);
      return res.status(200).json({ success: true, company });
    }

    if (!Array.isArray(company.contacts)) company.contacts = [];

    // ── POST ?action=addContact ──────────────────────────────────────────────
    if (action === 'addContact') {
      if (body.contactStatus && !CONTACT_STATUSES.includes(body.contactStatus)) {
        return res.status(400).json({ error: `Invalid contactStatus: ${body.contactStatus}` });
      }
      const contact = {
        id: crypto.randomUUID(),
        name: body.name || '',
        role: body.role || '',
        mutualConnections: body.mutualConnections || '',
        outreachType: body.outreachType || 'peer',
        dateContacted: body.dateContacted || null,
        replyReceived: !!body.replyReceived,
        replyDate: body.replyDate || null,
        contactStatus: body.contactStatus || 'not_contacted',
        notes: body.notes || '',
      };
      company.contacts.push(contact);
      company.lastActivity = todayISO();
      await writeRadar(githubToken, owner, repo, radar, `chore: radar add contact for ${company.company} [skip ci]`);
      return res.status(200).json({ success: true, company, contact });
    }

    // ── POST ?action=updateContact ───────────────────────────────────────────
    if (action === 'updateContact') {
      const contactId = body.contactId;
      if (!contactId) return res.status(400).json({ error: 'contactId is required' });
      const contact = company.contacts.find(c => c.id === contactId);
      if (!contact) return res.status(404).json({ error: 'Contact not found' });
      if (body.contactStatus && !CONTACT_STATUSES.includes(body.contactStatus)) {
        return res.status(400).json({ error: `Invalid contactStatus: ${body.contactStatus}` });
      }
      Object.assign(contact, pick(body, CONTACT_EDITABLE));
      company.lastActivity = todayISO();
      await writeRadar(githubToken, owner, repo, radar, `chore: radar update contact for ${company.company} [skip ci]`);
      return res.status(200).json({ success: true, company, contact });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[radar] Error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
