// Users tab (super admin only): add shop logins with a username and password, change roles, set new passwords,
// switch logins off or delete them. There is no sign-up page; every change goes through the staffUsers Cloud Function.
import { escapeHtml } from './lib/catalog.js';
import { makePassword, ROLES, suggestUsername, USERNAME_RE } from './lib/staff.js';

const $ = (sel) => document.querySelector(sel);
const U = { ctx: null, users: [], loading: false, editing: null, error: '' };
// ctx: { call(data) → Promise, toast, getStaff, openExternal }

function ago(iso) {
  if (!iso) return 'never signed in';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 2) return 'active now';
  if (mins < 60) return `active ${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `active ${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `active ${d} day${d > 1 ? 's' : ''} ago` : `last active ${new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
}

function friendlyError(err) {
  const code = String(err?.code ?? '');
  if (code.includes('not-found') && /function|not found/i.test(err?.message ?? '')) {
    return 'The user manager is not on the server yet. Run “firebase deploy --only functions” once, then try again.';
  }
  if (code.includes('unavailable') || !navigator.onLine) return 'No internet. Users can be managed only when online.';
  return err?.message || 'Something went wrong.';
}

const loginOf = (u) => (u.username ? `@${u.username}` : u.email || 'no login');
const ROLE_ORDER = { super: 0, admin: 1, sales: 2 };

function renderList() {
  const el = $('#user-list');
  if (U.loading && !U.users.length) {
    el.innerHTML = '<p class="muted">Loading users…</p>';
    return;
  }
  if (U.error) {
    el.innerHTML = `<p class="a-error">${escapeHtml(U.error)}</p><button type="button" class="btn btn-soft" data-act="reload">Try again</button>`;
    return;
  }
  const me = U.ctx.getStaff()?.uid;
  const list = [...U.users].sort((a, b) => (a.active === b.active ? 0 : a.active ? -1 : 1)
    || ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name));
  el.innerHTML = list.map((u) => `<button type="button" class="us-card${u.active ? '' : ' is-off'}" data-uid="${escapeHtml(u.uid)}">
      <span class="us-avatar role-${u.role}" aria-hidden="true">${escapeHtml((u.name || '?').trim().charAt(0).toUpperCase())}</span>
      <span class="us-info"><strong>${escapeHtml(u.name || 'No name')}${u.uid === me ? ' <small>(you)</small>' : ''}</strong>
        <small>${escapeHtml(loginOf(u))} · ${u.noLogin ? 'login missing' : ago(u.lastActive || u.lastSignIn)}</small></span>
      <span class="us-tags"><span class="badge role-${u.role}">${ROLES[u.role].label}</span>${u.active ? '' : '<span class="badge bill-void">Off</span>'}</span>
    </button>`).join('') || '<p class="muted">No users yet.</p>';
  $('#user-count').textContent = U.users.length ? `${U.users.filter((u) => u.active).length} active · ${U.users.length} in total` : '';
}

async function load() {
  U.loading = true;
  U.error = '';
  renderList();
  try {
    U.users = (await U.ctx.call({ action: 'list' })).users;
  } catch (err) {
    U.error = friendlyError(err);
  } finally {
    U.loading = false;
    renderList();
  }
}

export function openUsersTab() {
  load();
}

// ── Add / edit dialog ───────────────────────────────────
function roleField(current) {
  return `<fieldset class="us-roles"><legend>Role</legend>
      ${['sales', 'admin', 'super'].map((r) => `<label class="us-role">
          <input type="radio" name="role" value="${r}" ${current === r ? 'checked' : ''} />
          <span><strong>${ROLES[r].label}</strong><small>${ROLES[r].blurb}</small></span>
        </label>`).join('')}
    </fieldset>`;
}

function passwordField(label, required) {
  return `<label>${label}
      <span class="us-pass"><input name="password" type="text" minlength="6" maxlength="64" autocomplete="new-password" autocapitalize="none" spellcheck="false" ${required ? 'required' : ''} />
      <button type="button" class="btn btn-sm btn-soft" data-act="gen">Make one</button></span>
    </label>`;
}

function openAdd() {
  U.editing = null;
  const dlg = $('#user-dialog');
  dlg.innerHTML = `<form id="user-form" novalidate>
      <div class="d-head"><h2>Add user</h2><button class="close" type="button" data-act="close" aria-label="Close">✕</button></div>
      <div class="d-body a-form">
        <label>Name <input name="name" maxlength="60" autocomplete="off" required placeholder="e.g. Ravi Kumar" /></label>
        <label>Username <small>(they type this to sign in; small letters and numbers)</small>
          <input name="username" maxlength="24" autocomplete="off" autocapitalize="none" spellcheck="false" required placeholder="e.g. ravi" /></label>
        ${passwordField('Password <small>(6 or more characters)</small>', true)}
        ${roleField('sales')}
        <p class="a-error" id="user-error" hidden></p>
        <button class="btn btn-primary" type="submit">Add user</button>
      </div>
    </form>`;
  dlg.showModal();
  dlg.querySelector('[name=name]').focus();
}

function openEdit(uid) {
  const u = U.users.find((x) => x.uid === uid);
  if (!u) return;
  U.editing = uid;
  const me = U.ctx.getStaff()?.uid === uid;
  const dlg = $('#user-dialog');
  dlg.innerHTML = `<form id="user-form" novalidate>
      <div class="d-head"><h2>${escapeHtml(u.name || 'User')}</h2><button class="close" type="button" data-act="close" aria-label="Close">✕</button></div>
      <div class="d-body a-form">
        <p class="o-sub">Signs in as <strong>${escapeHtml(u.username || u.email || '—')}</strong> · ${u.noLogin ? 'login missing' : ago(u.lastActive || u.lastSignIn)}</p>
        <label>Name <input name="name" maxlength="60" autocomplete="off" required value="${escapeHtml(u.name)}" /></label>
        ${me ? `<p class="hint">This is you. Another super admin has to change your role or switch you off.</p>` : roleField(u.role)}
        ${me ? '' : `<label class="switch"><input type="checkbox" name="active" ${u.active ? 'checked' : ''} /> Can sign in <small>(untick to switch this login off straight away)</small></label>`}
        ${passwordField('New password <small>(leave empty to keep the current one)</small>', false)}
        <p class="a-error" id="user-error" hidden></p>
        <button class="btn btn-primary" type="submit">Save</button>
        ${me ? '' : '<button class="btn btn-sm btn-danger" type="button" data-act="delete">Delete user</button>'}
      </div>
    </form>`;
  dlg.showModal();
}

function shareLogin({ name, username, password }) {
  const text = `Hi ${name.split(' ')[0]}, your Best FireWorks app login:\nUsername: ${username}\nPassword: ${password}\n\nOpen the Best FireWorks app, type these and tap Sign in.`;
  const dlg = $('#user-dialog');
  dlg.innerHTML = `<div class="d-head"><h2>User added ✓</h2><button class="close" type="button" data-act="close" aria-label="Close">✕</button></div>
    <div class="d-body">
      <div class="us-done">
        <span>Username</span><strong>${escapeHtml(username)}</strong>
        <span>Password</span><strong>${escapeHtml(password)}</strong>
      </div>
      <p class="muted">Give these to ${escapeHtml(name)}. You can set a new password any time.</p>
      <div class="d-row-btns">
        <a class="btn btn-wa" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">💬 Send on WhatsApp</a>
        <button type="button" class="btn btn-soft" data-act="copy">Copy</button>
        <button type="button" class="btn btn-primary" data-act="close">Done</button>
      </div>
    </div>`;
  dlg.querySelector('[data-act="copy"]').addEventListener('click', () => {
    navigator.clipboard?.writeText(text).then(() => U.ctx.toast('Copied'), () => U.ctx.toast('Could not copy'));
  });
}

async function submit(f) {
  const err = $('#user-error');
  const fail = (msg, field) => {
    err.textContent = msg;
    err.hidden = false;
    field?.focus();
  };
  err.hidden = true;
  const name = f.name.value.trim().replace(/\s+/g, ' ');
  const password = f.password.value;
  if (name.length < 2) return fail('Enter the person’s name.', f.name);
  if ((password || !U.editing) && password.length < 6) return fail('The password needs at least 6 characters.', f.password);
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    if (!U.editing) {
      const username = f.username.value.trim().toLowerCase();
      if (!USERNAME_RE.test(username)) return fail('Username: 3 to 24 small letters or numbers (. - _ allowed), no spaces.', f.username);
      const role = f.role.value;
      await U.ctx.call({ action: 'create', name, username, password, role });
      U.ctx.toast(`${name} can now sign in`);
      shareLogin({ name, username, password });
    } else {
      const u = U.users.find((x) => x.uid === U.editing);
      const patch = { action: 'update', uid: U.editing };
      if (name !== u.name) patch.name = name;
      if (f.role && f.role.value !== u.role) patch.role = f.role.value;
      if (f.active && f.active.checked !== u.active) patch.active = f.active.checked;
      if (patch.role === 'super' && !confirm(`Make ${name} a super admin? They will be able to add and remove users, including you.`)) return;
      if (patch.active === false && !confirm(`Switch off ${name}? They are signed out and cannot sign in until you switch them on again.`)) return;
      if (Object.keys(patch).length > 2) await U.ctx.call(patch);
      if (password) await U.ctx.call({ action: 'password', uid: U.editing, password });
      U.ctx.toast(password ? `Saved. New password for ${name}: ${password}` : 'Saved');
      $('#user-dialog').close();
    }
    await load();
  } catch (e) {
    fail(friendlyError(e));
  } finally {
    btn.disabled = false;
  }
}

export function setupUsersTab(ctx) {
  U.ctx = ctx;
  $('#user-add').addEventListener('click', openAdd);
  $('#user-list').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="reload"]')) return load();
    const card = e.target.closest('[data-uid]');
    if (card) openEdit(card.dataset.uid);
  });
  const dlg = $('#user-dialog');
  dlg.addEventListener('click', async (e) => {
    if (e.target === dlg || e.target.closest('[data-act="close"]')) return dlg.close();
    if (e.target.closest('[data-act="gen"]')) {
      const f = $('#user-form');
      f.password.value = makePassword();
      return;
    }
    if (e.target.closest('[data-act="delete"]')) {
      const u = U.users.find((x) => x.uid === U.editing);
      if (!u || !confirm(`Delete ${u.name}'s login? Their bills stay in the records.`)) return;
      try {
        await U.ctx.call({ action: 'delete', uid: u.uid });
        U.ctx.toast(`${u.name} deleted`);
        dlg.close();
        load();
      } catch (err) {
        $('#user-error').textContent = friendlyError(err);
        $('#user-error').hidden = false;
      }
    }
  });
  dlg.addEventListener('input', (e) => {
    const f = e.target.form;
    if (!f || U.editing) return;
    if (e.target.name === 'name' && !f.username.dataset.touched) f.username.value = suggestUsername(e.target.value);
    if (e.target.name === 'username') {
      f.username.dataset.touched = '1';
      e.target.value = e.target.value.toLowerCase().replace(/\s/g, '');
    }
  });
  dlg.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(e.target);
  });
}
