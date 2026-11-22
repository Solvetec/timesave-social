/* TimeSave Social V18 · Multi-User Auth, Role-Aware Workspace, Invite Management & Theme Switcher */
'use strict';

let v18CurrentUser = null;

// 1. Dark / Light Studio Theme Toggle
function v18ApplyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const btn = $('v18ThemeToggle');
  if (btn) btn.textContent = dark ? '☀ Hell' : '🌙 Studio';
}

function v18ToggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('timesave_theme', next); } catch {}
  v18ApplyTheme(next);
}

// 2. Auth Tabs (Email Login / Invite Registration / Admin Key)
function v18AuthTab(tab) {
  const active = ['email', 'register', 'token'].includes(tab) ? tab : 'email';
  document.querySelectorAll('.v18-auth-tabs button').forEach(b => {
    const selected = b.dataset.authTab === active;
    b.classList.toggle('selected', selected);
    b.setAttribute('aria-pressed', String(selected));
  });
  if ($('v18AuthEmailPane')) $('v18AuthEmailPane').hidden = active !== 'email';
  if ($('v18AuthRegisterPane')) $('v18AuthRegisterPane').hidden = active !== 'register';
  if ($('v18AuthTokenPane')) $('v18AuthTokenPane').hidden = active !== 'token';
  if ($('loginMessage')) $('loginMessage').textContent = '';
}

async function v18FinishSession(token) {
  auth = token;
  try { sessionStorage.setItem(V1725_SESSION_KEY, auth); } catch {}
  await v18SyncCurrentUser();
  if ($('loginScreen')) $('loginScreen').hidden = true;
  if ($('appShell')) $('appShell').hidden = false;
  await refresh();
  nav('dashboard');
}

async function v18EmailLogin() {
  const email = ($('v18LoginEmail')?.value || '').trim();
  const password = $('v18LoginPass')?.value || '';
  const btn = $('v18EmailLoginBtn');
  if (!email || !password) { if ($('loginMessage')) $('loginMessage').textContent = 'Bitte E-Mail und Passwort eingeben.'; return; }
  if (btn) btn.disabled = true;
  if ($('loginMessage')) $('loginMessage').textContent = '';
  try {
    const resp = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, remember: !!$('v186RememberEmail')?.checked }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Anmeldung fehlgeschlagen.');
    if ($('v18LoginPass')) $('v18LoginPass').value = '';
    await v18FinishSession(body.token);
  } catch (e) {
    if ($('loginMessage')) $('loginMessage').textContent = e.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function v18Register() {
  const invite_code = ($('v18RegCode')?.value || '').trim();
  const display_name = ($('v18RegName')?.value || '').trim();
  const email = ($('v18RegEmail')?.value || '').trim();
  const password = $('v18RegPass')?.value || '';
  const btn = $('v18RegBtn');
  if (!display_name || !email || password.length < 8) {
    if ($('loginMessage')) $('loginMessage').textContent = 'Bitte Name, gültige E-Mail und Passwort (mind. 8 Zeichen) eingeben.';
    return;
  }
  if (btn) btn.disabled = true;
  if ($('loginMessage')) $('loginMessage').textContent = '';
  try {
    const resp = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invite_code, display_name, email, password }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Registrierung fehlgeschlagen.');
    if ($('v18RegPass')) $('v18RegPass').value = '';
    await v18FinishSession(body.token);
    toast('Willkommen im Studio, ' + (body.user?.display_name || '') + '!');
  } catch (e) {
    if ($('loginMessage')) $('loginMessage').textContent = e.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 3. Sync logged-in user profile & enforce clean role-based UI
async function v18SyncCurrentUser() {
  if (!auth) return null;
  const me = await api('/api/auth/me');
  v18CurrentUser = me;
  const isAdmin = me.role === 'admin';
  const name = me.display_name || 'Benutzer';
  if ($('v18UserAvatar')) $('v18UserAvatar').textContent = name.trim().charAt(0).toUpperCase() || 'U';
  if ($('v18UserName')) $('v18UserName').textContent = name;
  if ($('v18UserEmail')) $('v18UserEmail').textContent = me.email || '';
  if ($('v18UserRole')) $('v18UserRole').textContent = isAdmin ? 'Admin' : 'Mitglied';
  if ($('v18DbBadge')) $('v18DbBadge').textContent = 'Datenbank: ' + String(me.db_backend || 'sqlite').toUpperCase();
  if ($('v18ProfileInfo')) {
    $('v18ProfileInfo').textContent = 'Angemeldet als ' + name + ' (' + me.email + ') · Rolle: ' + (isAdmin ? 'Administrator' : 'Mitglied') + '. Dein Arbeitsbereich (Medien, Entwürfe, Konten, Planung) ist vollständig isoliert.';
  }
  if ($('v18PasswordBox')) $('v18PasswordBox').hidden = me.auth_type !== 'session';
  document.querySelectorAll('.v18-admin-only').forEach(el => { el.hidden = !isAdmin; });
  // Hide admin-only Telegram Render-ENV button & Backup/Restore controls for regular members
  const envBtn = document.querySelector('button[onclick="v1722ConnectTelegramEnv()"]');
  if (envBtn?.parentElement) envBtn.parentElement.hidden = !isAdmin;
  const backupBtn = document.querySelector('button[onclick="v1723Backup()"]');
  if (backupBtn) backupBtn.hidden = !isAdmin;
  const restoreBox = document.querySelector('.v1723-restore');
  if (restoreBox) restoreBox.hidden = !isAdmin;
  return me;
}

// Wrap login & logout so both ADMIN_TOKEN and session logins stay 100% synced
const v18PrevLogin = login;
login = async function() {
  const btn = $('loginButton');
  auth = ($('admin')?.value || '').trim();
  if (!auth) { if ($('loginMessage')) $('loginMessage').textContent = 'Bitte Zugangsschlüssel eingeben.'; return; }
  if ($('loginMessage')) $('loginMessage').textContent = '';
  if (btn) btn.disabled = true;
  try {
    await v18SyncCurrentUser();
    if ($('v186RememberAdmin')?.checked && v18CurrentUser?.auth_type === 'admin_token') {
      const result = await api('/api/auth/remember-admin', {method:'POST'});
      auth = result.token;
    }
    else { await api('/api/auth/forget', {method:'POST'}); }
    if ($('admin')) $('admin').value = '';
    try { sessionStorage.setItem(V1725_SESSION_KEY, auth); } catch {}
    if ($('loginScreen')) $('loginScreen').hidden = true;
    if ($('appShell')) $('appShell').hidden = false;
    await refresh();
    nav('dashboard');
  } catch (e) {
    auth = '';
    if ($('loginMessage')) $('loginMessage').textContent = e.message;
  } finally {
    if (btn) btn.disabled = false;
  }
};

const v18PrevLogout = v1725Logout;
v1725Logout = async function() {
  if (auth) {
    try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Admin-Token': auth } }); } catch {}
  }
  v18CurrentUser = null;
  v18PrevLogout();
};

// Only call /api/config for admins on Settings page so regular members never get 403!
const v18PrevLoadConfig = loadConfig;
loadConfig = async function() {
  if (!v18CurrentUser) {
    try { await v18SyncCurrentUser(); } catch {}
  }
  if (v18CurrentUser?.role !== 'admin') return;
  await v18PrevLoadConfig();
  await v18LoadUsers();
};

async function v18ChangePassword() {
  const cur = $('v18CurPass')?.value || '';
  const nxt = $('v18NewPass')?.value || '';
  if (!cur || nxt.length < 8) { toast('Bitte aktuelles Passwort und ein neues Passwort (mind. 8 Zeichen) eingeben.', true); return; }
  try {
    const res = await json('/api/auth/password', { current_password: cur, new_password: nxt });
    if ($('v18CurPass')) $('v18CurPass').value = '';
    if ($('v18NewPass')) $('v18NewPass').value = '';
    toast(res.message || 'Passwort geändert.');
  } catch (e) {
    toast(e.message, true);
  }
}

// 4. Admin User & Invite Management
async function v18LoadUsers() {
  if (v18CurrentUser?.role !== 'admin') return;
  try {
    const data = await api('/api/admin/users');
    if ($('v18OwnerClaimBox')) $('v18OwnerClaimBox').hidden = !!data.owner_claimed;
    const uList = $('v18UserList');
    if (uList) {
      uList.innerHTML = (data.users || []).map(u => {
        const isProtected = u.id === 'owner' || u.id === v18CurrentUser?.id;
        return `<div class="v18-user-row"><div><strong>${esc(u.display_name)} <span class="pill ${u.role === 'admin' ? 'amber' : ''}">${u.role === 'admin' ? 'Admin' : 'Mitglied'}</span> ${u.active ? '<span class="pill green">Aktiv</span>' : '<span class="pill red">Gesperrt</span>'}</strong>` +
          `<small>${esc(u.email)} · ${u.media_count} Medien · ${u.connection_count} Konten · ${u.scheduled_count} geplant</small></div>` +
          `<div class="row"><button type="button" class="outline tiny" onclick="v18ResetUserPass('${esc(u.id)}','${esc(u.display_name)}')">🔑 Passwort</button>` +
          (isProtected ? '' : `<button type="button" class="${u.active ? 'danger' : 'outline'} tiny" onclick="v18ToggleUserActive('${esc(u.id)}',${u.active ? 'false' : 'true'})">${u.active ? 'Sperren' : 'Freischalten'}</button>`) +
          `</div></div>`;
      }).join('') || '<p class="hint">Noch keine E-Mail-Benutzer angelegt. Erstelle oben dein eigenes Admin-Login oder lade jemanden ein.</p>';
    }
    const iList = $('v18InviteList');
    if (iList) {
      const openInvites = (data.invites || []).filter(i => !i.used_by);
      iList.innerHTML = openInvites.map(inv => {
        const link = location.origin + '/?invite=' + encodeURIComponent(inv.code);
        return `<div class="v18-user-row"><div><strong><code>${esc(inv.code)}</code> · ${esc(inv.note || 'Einladung')}</strong>` +
          `<small>Rolle: ${inv.role === 'admin' ? 'Admin' : 'Mitglied'} · Gültig bis ${new Date(inv.expires_at).toLocaleDateString('de-DE')}</small></div>` +
          `<div class="row"><button type="button" class="outline tiny" onclick="v18CopyText('${esc(link)}')">📋 Link kopieren</button>` +
          `<button type="button" class="danger tiny" onclick="v18RevokeInvite('${esc(inv.code)}')">Widerrufen</button></div></div>`;
      }).join('') || '<p class="hint">Keine offenen Einladungen.</p>';
    }
  } catch (e) {
    if ($('v18UserList')) $('v18UserList').textContent = '⚠ ' + e.message;
  }
}

async function v18ClaimOwner() {
  const display_name = ($('v18OwnerName')?.value || '').trim();
  const email = ($('v18OwnerEmail')?.value || '').trim();
  const password = $('v18OwnerPass')?.value || '';
  if (!display_name || !email || password.length < 8) { toast('Bitte Name, E-Mail und Passwort (mind. 8 Zeichen) eingeben.', true); return; }
  try {
    await json('/api/admin/users', { display_name, email, password, role: 'admin', claim_owner: true });
    if ($('v18OwnerPass')) $('v18OwnerPass').value = '';
    await v18LoadUsers();
    toast('Dein Admin-E-Mail-Login ist aktiv! Du kannst dich künftig per E-Mail & Passwort anmelden.');
  } catch (e) {
    toast(e.message, true);
  }
}

async function v18CreateUserDirect() {
  const display_name = ($('v18NewUserName')?.value || '').trim();
  const email = ($('v18NewUserEmail')?.value || '').trim();
  const password = $('v18NewUserPass')?.value || '';
  if (!display_name || !email || password.length < 8) { toast('Bitte Name, gültige E-Mail und Startpasswort (mind. 8 Zeichen) eingeben.', true); return; }
  try {
    await json('/api/admin/users', { display_name, email, password, role: 'user' });
    if ($('v18NewUserName')) $('v18NewUserName').value = '';
    if ($('v18NewUserEmail')) $('v18NewUserEmail').value = '';
    if ($('v18NewUserPass')) $('v18NewUserPass').value = '';
    await v18LoadUsers();
    toast('Benutzerkonto angelegt und sofort einsatzbereit.');
  } catch (e) {
    toast(e.message, true);
  }
}

async function v18CreateInvite() {
  const note = ($('v18InviteNote')?.value || '').trim();
  const role = $('v18InviteRole')?.value || 'user';
  try {
    const res = await json('/api/admin/invites', { note, role, days: 7 });
    const fullUrl = res.invite_url.startsWith('http') ? res.invite_url : (location.origin + res.invite_url);
    if ($('v18InviteResult')) {
      $('v18InviteResult').innerHTML = `<div class="v18-invite-link-box"><b>Einladungslink bereit:</b><br><code>${esc(fullUrl)}</code><br><button type="button" class="outline tiny" style="margin-top:6px" onclick="v18CopyText('${esc(fullUrl)}')">📋 Link kopieren</button></div>`;
    }
    if ($('v18InviteNote')) $('v18InviteNote').value = '';
    await v18LoadUsers();
    toast('Einladungslink erstellt.');
  } catch (e) {
    toast(e.message, true);
  }
}

async function v18RevokeInvite(code) {
  try {
    await api('/api/admin/invites/' + encodeURIComponent(code), { method: 'DELETE' });
    await v18LoadUsers();
    toast('Einladung widerrufen.');
  } catch (e) { toast(e.message, true); }
}

async function v18ToggleUserActive(uid, active) {
  try {
    await json('/api/admin/users/' + encodeURIComponent(uid), { active }, 'PATCH');
    await v18LoadUsers();
    toast(active ? 'Benutzer wieder freigeschaltet.' : 'Benutzer gesperrt und abgemeldet.');
  } catch (e) { toast(e.message, true); }
}

async function v18ResetUserPass(uid, name) {
  const pw = prompt('Neues Passwort für ' + name + ' (mindestens 8 Zeichen):');
  if (!pw) return;
  if (pw.length < 8) { toast('Passwort muss mindestens 8 Zeichen haben.', true); return; }
  try {
    await json('/api/admin/users/' + encodeURIComponent(uid), { password: pw }, 'PATCH');
    toast('Neues Passwort für ' + name + ' gespeichert.');
  } catch (e) { toast(e.message, true); }
}

async function v18CopyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Link in die Zwischenablage kopiert.'); }
  catch { prompt('Link kopieren:', text); }
}

// 5. Initialize Theme + Check ?invite=CODE URL param + Smart Default Login Tab
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const savedTheme = localStorage.getItem('timesave_theme') || 'light';
    v18ApplyTheme(savedTheme);
  } catch {}

  const params = new URLSearchParams(location.search);
  const invite = params.get('invite');
  if (invite) {
    if ($('v18RegCode')) $('v18RegCode').value = invite.trim().toUpperCase();
    v18AuthTab('register');
    return;
  }
  try {
    const r = await fetch('/api/branding');
    if (r.ok) {
      const b = await r.json();
      v18AuthTab(b.has_users ? 'email' : 'token');
    }
  } catch {}
});
