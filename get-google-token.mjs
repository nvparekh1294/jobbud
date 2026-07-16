#!/usr/bin/env node
// get-google-token.mjs — one-time helper to mint a Google OAuth refresh token
// for JobBud's optional "auto-save prep docs to Google Drive" feature.
//
// It runs the standard OAuth 2.0 installed-app (loopback) flow:
//   1. reads GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from the environment,
//   2. opens Google's consent screen in your browser,
//   3. captures the authorization code on a temporary localhost server,
//   4. exchanges it for a long-lived refresh token, which it prints.
//
// It never contains or hardcodes any credentials. You supply the client ID and
// secret via env vars; the refresh token it prints is yours — copy it into
// GOOGLE_REFRESH_TOKEN (in your Vercel env and your GitHub Actions secrets).
//
// Prerequisites (see SETUP.md for the full walkthrough):
//   - A Google Cloud project with the Google Docs API and Google Drive API enabled.
//   - An OAuth 2.0 client of type "Desktop app" (its client ID + secret).
//     A Desktop-app client permits loopback (http://localhost) redirects, so no
//     redirect URI needs to be pre-registered.
//
// Usage:
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node get-google-token.mjs
//
// Requires Node 18+ (uses the built-in global fetch).

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Scopes: create Google Docs (documents) and write files into Drive, including
// an existing folder referenced by GOOGLE_DRIVE_FOLDER_ID (needs full drive scope,
// since drive.file only covers files this app itself created).
const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PORT = 4599; // arbitrary high port for the temporary loopback listener
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

function fail(msg) {
  console.error(`\nError: ${msg}\n`);
  process.exit(1);
}

if (!CLIENT_ID || !CLIENT_SECRET) {
  fail(
    'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set in the environment.\n' +
    'Run: GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node get-google-token.mjs',
  );
}

// Best-effort "open the URL in the default browser". Falls back to printing it.
function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'cmd' :
    'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* ignore — the URL is printed below regardless */
  }
}

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Token exchange failed (${res.status}): ${data.error || 'unknown'} ${data.error_description || ''}`.trim(),
    );
  }
  return data;
}

function main() {
  const state = randomBytes(16).toString('hex');

  const authUrl =
    `${AUTH_URL}?` +
    new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',   // required to receive a refresh token
      prompt: 'consent',        // force the consent screen so a refresh token is always returned
      state,
    }).toString();

  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/oauth2callback')) {
      res.writeHead(404).end('Not found');
      return;
    }

    const url = new URL(req.url, REDIRECT_URI);
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');

    const finish = (statusText) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<html><body style="font-family:system-ui;padding:40px">` +
        `<h2>${statusText}</h2><p>You can close this tab and return to your terminal.</p>` +
        `</body></html>`,
      );
    };

    if (error) {
      finish('Authorization was denied.');
      server.close();
      fail(`Authorization denied: ${error}`);
      return;
    }
    if (returnedState !== state) {
      finish('State mismatch — aborted.');
      server.close();
      fail('State parameter did not match; possible CSRF. Aborted.');
      return;
    }
    if (!code) {
      finish('No authorization code received.');
      server.close();
      fail('No authorization code was returned.');
      return;
    }

    try {
      const tokens = await exchangeCodeForTokens(code);
      finish('Success! Refresh token minted.');
      server.close();

      if (!tokens.refresh_token) {
        fail(
          'No refresh token was returned. This usually means you have authorized this app\n' +
          'before. Remove JobBud from https://myaccount.google.com/permissions and re-run.',
        );
      }

      console.log('\n────────────────────────────────────────────────────────────');
      console.log('Your GOOGLE_REFRESH_TOKEN:\n');
      console.log(tokens.refresh_token);
      console.log('\n────────────────────────────────────────────────────────────');
      console.log('Set this as GOOGLE_REFRESH_TOKEN in BOTH:');
      console.log('  • your Vercel project environment variables, and');
      console.log('  • your GitHub repo → Settings → Secrets and variables → Actions.');
      console.log('Keep it secret — treat it like a password.\n');
      process.exit(0);
    } catch (err) {
      server.close();
      fail(err.message);
    }
  });

  server.listen(PORT, () => {
    console.log('\nJobBud — Google refresh token helper\n');
    console.log('Opening Google\'s consent screen in your browser...');
    console.log('If it does not open automatically, paste this URL into your browser:\n');
    console.log(authUrl + '\n');
    console.log(`Waiting for the redirect to ${REDIRECT_URI} ...`);
    openBrowser(authUrl);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      fail(`Port ${PORT} is already in use. Close whatever is using it and re-run.`);
    }
    fail(err.message);
  });
}

main();
