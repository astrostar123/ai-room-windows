// AI Room — the page.
// Listens to the server for live state, draws every room, and handles clicks:
// open a conversation, reply, stop, Allow/Deny, settings.

(function () {
  const TOKEN = window.ROOM_TOKEN;
  const CLIENT_ID = Math.random().toString(36).slice(2, 10);
  const PARAMS = new URLSearchParams(location.search);
  const DEMO = PARAMS.has('demo'); // ?demo shows a pretend office (see the bottom of this file)
  const { STATE_COLORS, spriteCanvas, robotPalette, drawRobot } = window.Sprites;
  const { H } = window.RoomLayout;

  const LABELS = { working: 'Working', waiting: 'Your turn', blocked: 'Blocked', idle: 'Idle' };
  const ORDER = ['blocked', 'waiting', 'working', 'idle'];

  let state = null;              // latest state from the server
  const rooms = new Map();       // room key -> { el, view, canvas, ... }
  let roomOrder = [];            // keeps rooms from jumping around
  let selectedId = null;         // session open in the side panel
  let messagesStamp = null;      // when the panel's messages were last loaded
  let prevSessions = null;       // for spotting changes (sounds, notifications)
  let offline = false;
  let hooksJustInstalled = false;
  const chipCursor = {};         // chip -> last session jumped to

  const $ = (sel, root = document) => root.querySelector(sel);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------------------------------------------------------------------
  // Talking to the server
  // ---------------------------------------------------------------------------

  async function api(path, body) {
    if (DEMO) return demoApi(path, body);
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-room-token': TOKEN, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function connect() {
    const es = new EventSource(`/api/events?token=${TOKEN}&client=${CLIENT_ID}&visible=${document.hidden ? 0 : 1}`);
    es.addEventListener('state', (e) => onState(JSON.parse(e.data)));
    es.onopen = () => {
      setOffline(false);
      sendPresence();
    };
    es.onerror = () => {
      setOffline(true);
      // The browser gives up for good on some errors; then we reconnect ourselves
      if (es.readyState === EventSource.CLOSED) setTimeout(() => recover(), 2000);
    };
  }

  // AI Room went away and maybe came back: reconnect, or reload if it no longer
  // knows this page's secret
  async function recover() {
    try {
      const ping = await fetch('/api/ping', { cache: 'no-store' });
      if (!ping.ok) throw new Error('not up');
      const check = await fetch('/api/state', { headers: { 'x-room-token': TOKEN }, cache: 'no-store' });
      if (check.status === 401) return location.reload();
      connect();
    } catch {
      setTimeout(recover, 3000);
    }
  }

  function setOffline(value) {
    if (offline === value) return;
    offline = value;
    if (state) renderBanners(state);
  }

  // Tell the server whether the Room is on screen. It only holds permission
  // questions for you while you can actually see them.
  function sendPresence() {
    api('/api/presence', { clientId: CLIENT_ID, visible: !document.hidden }).catch(() => {});
  }
  document.addEventListener('visibilitychange', sendPresence);

  let buildId = null;
  function onState(s) {
    // AI Room was updated: reload to get the new page
    if (s.buildId && buildId && s.buildId !== buildId) return location.reload();
    buildId = s.buildId || buildId;
    state = s;
    noticeChanges(s);
    renderFleet(s);
    renderBanners(s);
    renderRooms(s);
    if (selectedId) renderPanel();
    updateTitle(s);
  }

  // ---------------------------------------------------------------------------
  // Top bar
  // ---------------------------------------------------------------------------

  function renderFleet(s) {
    const labels = { blocked: 'blocked', waiting: 'your turn', working: 'working', idle: 'idle' };
    $('#fleet').innerHTML = ORDER.map((st) => {
      const n = s.counts[st] || 0;
      return `<button class="chip s-${st}${n ? '' : ' zero'}" data-state="${st}" title="Jump to the next ${labels[st]} robot">
        <span class="dot"></span><b>${n}</b> ${labels[st]}</button>`;
    }).join('');
  }

  $('#fleet').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || !state) return;
    const st = chip.dataset.state;
    const ids = allSessionsInOrder().filter((id) => state.sessions[id].state === st);
    if (!ids.length) return;
    const next = ids[(ids.indexOf(chipCursor[st]) + 1) % ids.length];
    chipCursor[st] = next;
    openPanel(next);
    const room = rooms.get(state.sessions[next].room);
    if (room) room.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  function allSessionsInOrder() {
    const out = [];
    for (const key of roomOrder) {
      const r = rooms.get(key);
      if (r) out.push(...r.view.desks.filter(Boolean));
    }
    return out;
  }

  function updateTitle(s) {
    const n = s.counts.blocked + s.counts.waiting;
    document.title = n ? `(${n}) AI Room` : 'AI Room';
    const worst = s.counts.blocked ? 'blocked' : s.counts.waiting ? 'waiting' : s.counts.working ? 'working' : 'idle';
    drawHeadIcon($('#favicon'), STATE_COLORS[worst], true);
  }

  // A robot head, used for the favicon and the logo
  function drawHeadIcon(target, light, isFavicon) {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const sprite = spriteCanvas('front', robotPalette(222, light), 'icon' + light);
    ctx.drawImage(sprite, 0, 0, 15, 11, 1, 5, 30, 22);
    if (isFavicon) target.href = c.toDataURL();
    else {
      const t = target.getContext('2d');
      t.imageSmoothingEnabled = false;
      t.clearRect(0, 0, target.width, target.height);
      t.drawImage(sprite, 0, 0, 15, 11, 0, 1, 30, 22);
    }
  }
  drawHeadIcon($('#brand-bot'), STATE_COLORS.working, false);

  // ---------------------------------------------------------------------------
  // Banners (hooks, sign-in, connection)
  // ---------------------------------------------------------------------------

  function dismissed(key) {
    try { return localStorage.getItem('dismiss:' + key) === '1'; } catch { return false; }
  }
  function dismiss(key) {
    try { localStorage.setItem('dismiss:' + key, '1'); } catch { /* private mode */ }
  }

  function renderBanners(s) {
    const out = [];
    if (offline) {
      out.push(`<div class="banner bad"><span class="grow"><b>AI Room has stopped.</b> Start it again with <code>Start AI Room.bat</code>. It reconnects by itself.</span></div>`);
    }
    if (hooksJustInstalled) {
      out.push(`<div class="banner info"><span class="grow"><b>Hooks connected.</b> Sessions you start from now on report to the Room instantly. Already-open sessions pick them up after a restart.</span>
        <button class="btn small ghost" data-act="close-hooks-note">OK</button></div>`);
    } else if (!s.hooks.installed && !dismissed('hooks')) {
      out.push(`<div class="banner warn"><span class="grow"><b>Connect hooks</b> so robots update instantly, <b>Stop</b> works, and robots bring permission questions to the Room door.
        This adds a few lines to <code>~/.claude/settings.json</code> (a backup is saved first).</span>
        <button class="btn small warn" data-act="install-hooks">Connect hooks</button>
        <button class="btn small ghost" data-act="dismiss" data-key="hooks">Not now</button></div>`);
    }
    if (s.hooks.error) out.push(`<div class="banner bad"><span class="grow">${esc(s.hooks.error)}</span></div>`);
    if (!s.cli.found) {
      out.push(`<div class="banner bad"><span class="grow"><b>The <code>claude</code> command wasn't found.</b> Watching still works, but Reply and New robot need Claude Code installed for the terminal.</span></div>`);
    } else if (s.cli.loggedIn === false && !dismissed('cli')) {
      out.push(`<div class="banner warn"><span class="grow"><b>Terminal Claude isn't signed in.</b> Watching and Allow/Deny work, but Reply and New robot need it.
        Open a terminal, run <code>claude</code>, then type <code>/login</code>.</span>
        <button class="btn small" data-act="open-terminal-home">Open terminal</button>
        <button class="btn small ghost" data-act="recheck-cli">Recheck</button>
        <button class="btn small ghost" data-act="dismiss" data-key="cli">Hide</button></div>`);
    }
    const html = out.join('');
    const box = $('#banners');
    if (box.dataset.html !== html) {
      box.innerHTML = html;
      box.dataset.html = html;
    }
  }

  $('#banners').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    try {
      if (act === 'dismiss') { dismiss(btn.dataset.key); renderBanners(state); }
      if (act === 'install-hooks') await installHooks();
      if (act === 'close-hooks-note') { hooksJustInstalled = false; renderBanners(state); }
      if (act === 'recheck-cli') { await api('/api/cli/recheck', {}); toast('Checking sign-in…'); }
      if (act === 'open-terminal-home') await api('/api/room/terminal', { cwd: firstRoomCwd() });
    } catch (err) {
      toast(err.message, true);
    }
  });

  function firstRoomCwd() {
    return (state && state.rooms[0] && state.rooms[0].cwd) || 'C:\\';
  }

  async function installHooks() {
    const r = await api('/api/hooks', { action: 'install' });
    hooksJustInstalled = true;
    toast('Hooks connected. Backup saved to ' + (r.backupFile || '~/.claude/ai-room'));
  }

  // ---------------------------------------------------------------------------
  // Rooms
  // ---------------------------------------------------------------------------

  function renderRooms(s) {
    const floor = $('#floor');
    const keys = s.rooms.map((r) => r.key);
    roomOrder = roomOrder.filter((k) => keys.includes(k));
    for (const r of s.rooms) if (!roomOrder.includes(r.key)) roomOrder.push(r.key);

    for (const [key, r] of rooms) {
      if (!keys.includes(key)) {
        r.el.remove();
        rooms.delete(key);
      }
    }
    roomOrder.forEach((key, i) => {
      const data = s.rooms.find((r) => r.key === key);
      let r = rooms.get(key);
      if (!r) {
        r = createRoom(data);
        rooms.set(key, r);
      }
      if (floor.children[i] !== r.el) floor.insertBefore(r.el, floor.children[i] || null);
      updateRoom(r, data, s);
    });

    $('#empty').hidden = s.rooms.length > 0;
    $('#empty-hours').textContent = s.settings.showHours;
  }

  function createRoom(data) {
    const el = document.createElement('section');
    el.className = 'room';
    el.innerHTML = `
      <header class="room-head">
        <div class="room-names"><h2 class="room-name"></h2><span class="room-path"></span></div>
        <div class="room-actions">
          <button class="btn small ghost" data-act="style">Style</button>
          <button class="btn small" data-act="new" title="Start a new robot in this folder">+ Robot</button>
          <button class="btn small ghost" data-act="term" title="Open Windows Terminal with claude in this folder">Terminal</button>
        </div>
      </header>
      <div class="stage"><canvas></canvas></div>
      <ul class="desk-list"></ul>`;
    const canvas = $('canvas', el);
    const r = { el, canvas, view: new window.RoomView(canvas), key: data.key, scale: 3, card: null, tail: null };

    // Hovering and clicking robots
    canvas.addEventListener('mousemove', (e) => {
      const id = r.view.hitTest(e.offsetX / r.scale, e.offsetY / r.scale);
      r.view.hover = id;
      canvas.classList.toggle('pointing', !!id);
      showTip(id, e.clientX, e.clientY);
    });
    canvas.addEventListener('mouseleave', () => {
      r.view.hover = null;
      showTip(null);
    });
    canvas.addEventListener('click', (e) => {
      const id = r.view.hitTest(e.offsetX / r.scale, e.offsetY / r.scale);
      if (id) openPanel(id);
    });

    el.addEventListener('click', async (e) => {
      const row = e.target.closest('.desk-row');
      if (row) return openPanel(row.dataset.id);
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const room = state.rooms.find((x) => x.key === r.key);
      if (btn.dataset.act === 'style') {
        // Next style for just this room
        const order = window.RoomThemes.ORDER;
        const now = r.view.theme().name;
        const next = order[(order.indexOf(now) + 1) % order.length];
        try { localStorage.setItem('style:' + r.key, next); } catch { /* private mode */ }
        updateRoom(r, room, state);
        toast(`${room.name}: ${window.RoomThemes.labels[next]}`);
      }
      if (btn.dataset.act === 'new') openNewRobot(room && room.cwd);
      if (btn.dataset.act === 'term') {
        try {
          await api('/api/room/terminal', { cwd: room.cwd });
          toast('Opening Windows Terminal…');
        } catch (err) {
          toast(err.message, true);
        }
      }
    });
    return r;
  }

  // A room's own style (picked with its Style button) beats the one in Settings
  function styleFor(key) {
    if (DEMO && PARAMS.get('style')) {
      // ?demo&style=neon,cabin gives the first demo room neon and the second cabin
      const list = PARAMS.get('style').split(',');
      return list[Math.max(0, ['game', 'site'].indexOf(key)) % list.length];
    }
    let own = null;
    try { own = localStorage.getItem('style:' + key); } catch { /* private mode */ }
    return own || (state && state.settings.roomStyle) || 'mixed';
  }

  function forgetRoomStyles() {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('style:')) localStorage.removeItem(k);
    } catch { /* private mode */ }
  }

  function updateRoom(r, data, s) {
    r.view.setRoom(data, s.sessions, styleFor(data.key));
    r.view.selected = selectedId;
    $('[data-act="style"]', r.el).title = `Style: ${window.RoomThemes.labels[r.view.theme().name]} (click for the next one)`;
    r.canvas.setAttribute('role', 'img');
    r.canvas.setAttribute('aria-label', `${data.name} room: ` + data.sessions.map((id) => `${s.sessions[id].name} ${LABELS[s.sessions[id].state]}`).join(', '));
    $('.room-name', r.el).textContent = data.name;
    const path = $('.room-path', r.el);
    path.textContent = data.cwd;
    path.title = data.cwd;

    // Glow the room frame when someone in it needs you
    const sess = data.sessions.map((id) => s.sessions[id]);
    const worst = sess.some((x) => x.state === 'blocked') ? 'blocked' : sess.some((x) => x.state === 'waiting') ? 'waiting' : null;
    r.el.classList.toggle('attention', !!worst);
    r.el.classList.toggle('s-blocked', worst === 'blocked');
    r.el.classList.toggle('s-waiting', worst === 'waiting');

    fitRoom(r);
    placeCard(r); // show a permission card straight away (the animation keeps it in place)

    // Robots listed under the room, in desk order (only redrawn when it changes)
    const list = $('.desk-list', r.el);
    const html = r.view.desks
      .filter(Boolean)
      .map((id) => {
        const x = s.sessions[id];
        return `<li class="desk-row s-${x.state}${id === selectedId ? ' selected' : ''}" data-id="${esc(id)}" title="${esc(x.title)}">
          <span class="dot"></span>
          <span class="d-name">${esc(x.name)}</span>
          <span class="d-title">${esc(x.title)}</span>
          <span class="d-detail">${esc(x.detail)}</span>
          <span class="d-time">${ago(x.lastActivity)}</span></li>`;
      })
      .join('');
    if (list.dataset.html !== html) {
      list.innerHTML = html;
      list.dataset.html = html;
    }
  }

  // Pick the biggest whole-number zoom that fits the window
  function fitRoom(r) {
    const want = (state && state.settings.scale) || 3;
    const room = r.view.width || 200;
    const panelOpen = selectedId && window.innerWidth >= 1100 ? 500 : 0;
    const avail = Math.max(200, window.innerWidth - panelOpen - 46);
    const scale = Math.max(1, Math.min(want, Math.floor(avail / room)));
    if (scale === r.scale && r.canvas.style.width) return;
    r.scale = scale;
    r.canvas.style.width = room * scale + 'px';
    r.canvas.style.height = H * scale + 'px';
    r.el.style.width = room * scale + 6 + 'px';
  }
  window.addEventListener('resize', () => {
    for (const r of rooms.values()) {
      r.canvas.style.width = '';
      fitRoom(r);
    }
  });

  function ago(t) {
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  function showTip(id, x, y) {
    const tip = $('#tip');
    const s = id && state && state.sessions[id];
    if (!s) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = `<b>${esc(s.name)}</b> · <span style="color:${STATE_COLORS[s.state]}">${LABELS[s.state]}</span><br>${esc(s.title)}<br><span class="muted">${esc(s.detail)}</span>`;
    tip.hidden = false;
    const w = tip.offsetWidth;
    tip.style.left = Math.min(x + 14, window.innerWidth - w - 8) + 'px';
    tip.style.top = y + 16 + 'px';
  }

  // ---------------------------------------------------------------------------
  // Permission cards
  // ---------------------------------------------------------------------------

  function permCardHtml(s, p, compact) {
    const verbText = p.answerable ? `wants to <b>${esc(p.verb)}</b>` : `is asking in the <b>${esc(s.where)}</b> to ${esc(p.verb)}`;
    let code = esc(p.preview);
    if (p.kind === 'diff') {
      code = p.preview.split('\n').map((l) => `<span class="${l.startsWith('- ') ? 'del' : l.startsWith('+ ') ? 'add' : ''}">${esc(l)}</span>`).join('\n');
    }
    const buttons = p.answerable
      ? `<div class="perm-btns">
          <button class="btn primary" data-perm="${p.id}" data-decision="allow">Allow</button>
          <button class="btn danger" data-perm="${p.id}" data-decision="deny">Deny</button>
        </div>
        <div class="perm-foot">
          ${p.source === 'hook' ? `<button class="linkish" data-perm="${p.id}" data-decision="pass">Ask in the ${esc(s.where)} instead</button>` : '<span>Started from the Room</span>'}
          <span class="perm-timer" data-expires="${p.expiresAt || ''}"></span>
        </div>`
      : `<div class="perm-note">${esc(p.reason || 'Answer it there.')}</div>`;
    return `<div class="perm-card${p.answerable ? '' : ' notice'}" data-card="${p.id}">
      <div class="perm-top"><b>${esc(s.name)}</b> ${verbText}${compact ? '' : ':'}</div>
      ${p.target ? `<div class="perm-target">${esc(p.target)}</div>` : ''}
      ${p.preview ? `<pre class="perm-code">${code}</pre>` : ''}
      ${p.note ? `<div class="perm-note">${esc(p.note)}</div>` : ''}
      ${buttons}
      ${p.more ? `<div class="perm-more">+${p.more} more waiting</div>` : ''}
    </div>`;
  }

  // Keeps the card next to the robot standing at the door (called every frame)
  function placeCard(r) {
    const at = r.view.doorActor();
    const s = at && state.sessions[at.id];
    const p = s && s.permission;
    if (!p) {
      if (r.card) { r.card.remove(); r.tail.remove(); r.card = r.tail = null; }
      return;
    }
    const stage = $('.stage', r.el);
    const cardKey = p.id + ':' + p.answerable;
    if (!r.card || r.card.dataset.key !== cardKey) {
      if (r.card) { r.card.remove(); r.tail.remove(); }
      const holder = document.createElement('div');
      holder.innerHTML = permCardHtml(s, p, true);
      r.card = holder.firstElementChild;
      r.card.dataset.key = cardKey;
      r.tail = document.createElement('div');
      r.tail.className = 'perm-tail';
      stage.append(r.card, r.tail);
    }
    const S = r.scale;
    const right = (r.view.width - at.x + 1) * S;
    const stageH = H * S;
    r.card.style.right = right + 10 + 'px';
    r.card.style.top = '8px';
    r.card.style.maxHeight = stageH - 16 + 'px';
    const headY = (at.top + 8) * S;
    r.tail.style.right = right + 1 + 'px';
    r.tail.style.top = Math.min(Math.max(headY - 7, 16), stageH - 30) + 'px';
  }

  function tickTimers() {
    for (const el of document.querySelectorAll('.perm-timer[data-expires]')) {
      const t = Number(el.dataset.expires);
      if (!t) continue;
      const left = Math.max(0, Math.round((t - Date.now()) / 1000));
      const text = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      if (el.textContent !== text) el.textContent = text;
      el.title = 'Time left before the question goes back to the app';
    }
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-perm][data-decision]');
    if (!btn) return;
    const card = btn.closest('.perm-card');
    card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await api(`/api/permission/${btn.dataset.perm}`, { decision: btn.dataset.decision });
      const words = { allow: 'Allowed', deny: 'Denied', pass: 'Sent back to the app' };
      toast(words[btn.dataset.decision]);
    } catch (err) {
      toast(err.message, true);
      card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  });

  // ---------------------------------------------------------------------------
  // Side panel: one robot's conversation
  // ---------------------------------------------------------------------------

  function openPanel(id) {
    if (!state || !state.sessions[id]) return;
    selectedId = id;
    messagesStamp = null;
    $('#panel').hidden = false;
    document.body.classList.add('panel-open');
    $('#p-reply').value = '';
    for (const r of rooms.values()) {
      r.view.selected = id;
      r.canvas.style.width = '';
      fitRoom(r);
    }
    for (const row of document.querySelectorAll('.desk-row')) row.classList.toggle('selected', row.dataset.id === id);
    renderPanel();
    markSeen(id);
  }

  function closePanel() {
    selectedId = null;
    $('#panel').hidden = true;
    document.body.classList.remove('panel-open');
    for (const r of rooms.values()) {
      r.view.selected = null;
      r.canvas.style.width = '';
      fitRoom(r);
    }
    for (const row of document.querySelectorAll('.desk-row.selected')) row.classList.remove('selected');
  }

  function markSeen(id) {
    const s = state && state.sessions[id];
    if (s && (s.state === 'waiting' || (s.state === 'blocked' && s.reason === 'error'))) {
      api(`/api/session/${id}/seen`, {}).catch(() => {});
    }
  }

  function renderPanel() {
    const s = state.sessions[selectedId];
    const panel = $('#panel');
    if (!s) {
      $('#p-title').textContent = 'This robot has left the room.';
      $('#p-meta').textContent = '';
      $('#p-detail').textContent = '';
      $('#p-perm').innerHTML = '';
      panel.querySelectorAll('.panel-actions .btn').forEach((b) => { b.disabled = true; });
      return;
    }
    panel.className = 's-' + s.state;
    panel.style.setProperty('--robot', `hsl(${s.hue} 38% 64%)`);
    $('#p-name').textContent = s.name;
    $('#p-state').textContent = LABELS[s.state];
    $('#p-title').textContent = s.title;
    const bits = [s.alive ? `Open in ${s.where}` : `${s.where} · closed`, s.cwd];
    if (s.branch) bits.push('⎇ ' + s.branch);
    if (s.model) bits.push(s.model.replace(/^claude-/, ''));
    $('#p-meta').textContent = bits.join('  ·  ');
    $('#p-detail').textContent = s.detail;

    // Permission card (same as the one at the door)
    const permBox = $('#p-perm');
    const key = s.permission ? s.permission.id + ':' + s.permission.answerable : '';
    if (permBox.dataset.key !== key) {
      permBox.dataset.key = key;
      permBox.innerHTML = s.permission ? permCardHtml(s, s.permission, false) : '';
    }

    // Reply box
    const reply = $('#p-reply');
    const send = $('#p-send');
    let note = '';
    if (s.managed) note = 'Working on it… you can reply when it finishes.';
    else if (!state.cli.found) note = 'Replying needs the claude command (Claude Code for the terminal).';
    else if (state.cli.loggedIn === false) note = 'Replying needs the terminal Claude signed in (see the banner at the top).';
    else if (s.busy) note = `It's busy${s.openElsewhere ? ` in the ${s.where}` : ''}. You can reply when it has finished.`;
    else if (s.openElsewhere) note = `Also open in the ${s.where}. Your reply runs here in the Room; that window won't show it until you reopen the chat.`;
    else note = 'Your reply continues this conversation right here.';
    $('#p-note').textContent = note;
    reply.disabled = !s.canReply;
    send.disabled = !s.canReply;
    $('#p-stop').hidden = !s.canStop;
    $('#p-stop').disabled = s.stopping;
    $('#p-stop').textContent = s.stopping ? 'Stopping…' : 'Stop';
    $('#p-term').disabled = s.alive || s.placeholder;
    $('#p-term').title = s.alive ? `Already open in the ${s.where}` : 'Continue this conversation in Windows Terminal';

    // Reload messages when something changed
    const stamp = s.lastActivity + ':' + s.state;
    if (stamp !== messagesStamp) {
      messagesStamp = stamp;
      loadMessages(selectedId);
    }
  }

  async function loadMessages(id) {
    const box = $('#p-messages');
    const firstLoad = box.dataset.id !== id;
    if (firstLoad) {
      box.innerHTML = '<div class="m-note">Loading…</div>';
      box.dataset.id = id;
    }
    try {
      const data = await api(`/api/session/${id}/messages`);
      if (selectedId !== id) return;
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      box.innerHTML = (data.trimmed ? '<div class="m-note">Earlier messages are hidden</div>' : '') +
        (data.items.length ? data.items.map(renderItem).join('') : '<div class="m-note">No messages yet.</div>');
      if (firstLoad || atBottom) box.scrollTop = box.scrollHeight;
    } catch (err) {
      box.innerHTML = `<div class="m-error">${esc(err.message)}</div>`;
    }
  }

  function renderItem(m) {
    switch (m.kind) {
      case 'you':
        return `<div class="m m-you">${md(m.text)}</div>`;
      case 'claude':
        return `<div class="m m-claude">${md(m.text)}</div>`;
      case 'tool':
        return `<details class="m-tool${m.isError ? ' err' : ''}"><summary><span class="t-name">${esc(m.pretty)}</span> ${esc(m.summary)}</summary>${m.result ? `<pre>${esc(m.result)}</pre>` : ''}</details>`;
      case 'error':
        return `<div class="m-error">${esc(m.text)}</div>`;
      default:
        return `<div class="m-note">${esc(m.text)}</div>`;
    }
  }

  // Tiny Markdown: code blocks, `code`, **bold**, headings, line breaks
  function md(text) {
    return String(text)
      .split(/```/)
      .map((part, i) => {
        if (i % 2) return `<pre><code>${esc(part.replace(/^[\w+-]*\n/, ''))}</code></pre>`;
        return esc(part)
          .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<u title="$2">$1</u>')
          .replace(/`([^`\n]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
          .replace(/^#{1,6} (.*)$/gm, '<b class="h">$1</b>')
          .replace(/\n/g, '<br>');
      })
      .join('')
      .replace(/^(<br>)+|(<br>)+$/g, '');
  }

  $('#p-close').addEventListener('click', closePanel);

  $('#p-send').addEventListener('click', sendReply);
  $('#p-reply').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendReply();
  });

  const okToReplyHere = new Set(); // chats open elsewhere that you said yes to

  async function sendReply() {
    const text = $('#p-reply').value.trim();
    if (!text || !selectedId) return;
    const s = state.sessions[selectedId];
    if (s && s.openElsewhere && !okToReplyHere.has(selectedId)) {
      const yes = confirm(
        `${s.name}'s chat is also open in the ${s.where}.\n\n` +
        `Your reply will run here in the Room. The ${s.where} window won't show it until you close and reopen that chat. ` +
        `If you type in that window before reopening it, it won't know what happened here.\n\nSend it from the Room?`,
      );
      if (!yes) return;
      okToReplyHere.add(selectedId);
    }
    $('#p-send').disabled = true;
    try {
      const r = await api(`/api/session/${selectedId}/reply`, { text });
      $('#p-reply').value = '';
      toast('Sent — the robot is on it.');
      if (r.sessionId && r.sessionId !== selectedId) setTimeout(() => openPanel(r.sessionId), 300);
    } catch (err) {
      toast(err.message, true);
      $('#p-send').disabled = false;
    }
  }

  $('#p-stop').addEventListener('click', async () => {
    if (!selectedId) return;
    try {
      const r = await api(`/api/session/${selectedId}/stop`, {});
      if (r.did.includes('flagged-no-hooks')) toast('Stop needs hooks connected for sessions opened elsewhere. Stop it in its own window.', true);
      else if (r.did.includes('flagged')) toast('Stopping at its next step…');
      else toast('Stopped.');
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#p-term').addEventListener('click', async () => {
    try {
      await api(`/api/session/${selectedId}/terminal`, {});
      toast('Opening Windows Terminal…');
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Robot portrait in the panel header
  function drawPortrait(now) {
    const s = state && state.sessions[selectedId];
    const c = $('#p-bot');
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    if (!s) return;
    const light = s.state === 'idle' ? (s.alive ? STATE_COLORS.idle : STATE_COLORS.off) : STATE_COLORS[s.state];
    const pose = (now + s.hue * 20) % 3200 > 3050 ? 'frontBlink' : 'front';
    drawRobot(ctx, pose, 0, 0, s.hue, light);
  }

  // ---------------------------------------------------------------------------
  // New robot + settings dialogs
  // ---------------------------------------------------------------------------

  function openModal(html, onReady) {
    $('#modal').innerHTML = html;
    $('#modal-back').hidden = false;
    onReady($('#modal'));
    const first = $('#modal').querySelector('textarea, input, button');
    if (first) first.focus();
  }
  function closeModal() {
    $('#modal-back').hidden = true;
    $('#modal').innerHTML = '';
  }
  $('#modal-back').addEventListener('click', (e) => {
    if (e.target.id === 'modal-back' || e.target.closest('[data-close]')) closeModal();
  });

  function openNewRobot(cwd) {
    const folders = state ? state.rooms.map((r) => `<option value="${esc(r.cwd)}">`).join('') : '';
    const cliOk = state && state.cli.found && state.cli.loggedIn !== false;
    openModal(`
      <h3>New robot</h3>
      <label class="field"><span>Project folder</span>
        <input id="n-cwd" list="n-folders" value="${esc(cwd || '')}" placeholder="C:\\Users\\you\\my-project" spellcheck="false"></label>
      <datalist id="n-folders">${folders}</datalist>
      <label class="field"><span>What should it do?</span>
        <textarea id="n-text" rows="5" placeholder="e.g. Fix the failing tests and explain what was wrong"></textarea></label>
      <p class="note">${cliOk
        ? 'It works in the background (<code>claude -p</code>). When it needs permission it walks to the door and asks you.'
        : 'Background robots need the terminal Claude signed in. You can still open a normal terminal session there.'}</p>
      <div class="modal-actions">
        <button class="btn ghost" data-close>Cancel</button>
        <button class="btn ghost" id="n-term">Open terminal there</button>
        <button class="btn primary" id="n-go" ${cliOk ? '' : 'disabled'}>Start robot</button>
      </div>`, (m) => {
      if (cwd) setTimeout(() => $('#n-text', m).focus(), 0);
      $('#n-go', m).addEventListener('click', async () => {
        try {
          const r = await api('/api/new', { cwd: $('#n-cwd', m).value, text: $('#n-text', m).value });
          closeModal();
          toast('A robot is walking in…');
          setTimeout(() => openPanel(r.sessionId), 400);
        } catch (err) {
          toast(err.message, true);
        }
      });
      $('#n-term', m).addEventListener('click', async () => {
        try {
          await api('/api/room/terminal', { cwd: $('#n-cwd', m).value });
          closeModal();
          toast('Opening Windows Terminal…');
        } catch (err) {
          toast(err.message, true);
        }
      });
      $('#n-text', m).addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) $('#n-go', m).click();
      });
    });
  }

  $('#btn-new').addEventListener('click', () => openNewRobot(''));
  $('#btn-new-empty').addEventListener('click', () => openNewRobot(''));
  $('#btn-seen').addEventListener('click', () => api('/api/seen-all', {}).then(() => toast('All caught up.')).catch((e) => toast(e.message, true)));

  $('#btn-settings').addEventListener('click', () => {
    const st = state.settings;
    const hooks = state.hooks;
    const cli = state.cli;
    openModal(`
      <h3>Settings</h3>
      <h4>Hooks</h4>
      <div class="status-line s-${hooks.installed ? 'working' : 'waiting'}"><span class="dot"></span>
        ${hooks.installed ? 'Connected. Claude sessions report to the Room.' : hooks.partial ? 'Partly connected — reconnect to fix.' : 'Not connected.'}</div>
      <p class="note">Hooks live in <code>~/.claude/settings.json</code>. They do nothing when the Room isn't running.</p>
      <div class="modal-actions" style="justify-content:flex-start;margin-top:0">
        ${hooks.installed ? '<button class="btn small ghost" id="s-unhook">Disconnect hooks</button>' : '<button class="btn small warn" id="s-hook">Connect hooks</button>'}
      </div>

      <h4>Permission questions</h4>
      <label class="check"><input type="checkbox" id="s-catch" ${st.catchPermissions ? 'checked' : ''}>
        <span>Answer them in the Room<small>While this window is on screen, robots bring questions to the door. Otherwise the app asks as usual.</small></span></label>
      <label class="field"><span>Hand back to the app after (seconds)</span>
        <input type="number" id="s-timeout" min="10" max="540" value="${st.permissionTimeoutSec}"></label>

      <h4>Room</h4>
      <label class="field"><span>Room style</span>
        <select id="s-style">
          ${[['mixed', 'Mixed — every room gets its own style'], ...window.RoomThemes.ORDER.map((k) => [k, window.RoomThemes.labels[k]])]
            .map(([v, l]) => `<option value="${v}"${st.roomStyle === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select></label>
      <p class="note" style="margin-top:-6px">Each room's <b>Style</b> button changes just that room. Saving a new style here resets those.</p>
      <div class="row2">
        <label class="field"><span>Show sessions from the last (hours)</span><input type="number" id="s-hours" min="1" max="336" value="${st.showHours}"></label>
        <label class="field"><span>"Your turn" fades after (hours)</span><input type="number" id="s-amber" min="0.1" max="336" step="0.5" value="${st.amberHours}"></label>
      </div>
      <label class="field"><span>Pixel zoom</span><input type="number" id="s-scale" min="1" max="5" value="${st.scale}"></label>
      <label class="check"><input type="checkbox" id="s-sound" ${st.sound ? 'checked' : ''}><span>8-bit bleeps when a robot needs you</span></label>
      <label class="check"><input type="checkbox" id="s-notify" ${st.notify ? 'checked' : ''}><span>Windows notifications<small>Pop up when a robot needs you, even if this window is hidden.</small></span></label>

      <h4>Terminal Claude</h4>
      <div class="status-line s-${cli.loggedIn ? 'working' : cli.found ? 'waiting' : 'blocked'}"><span class="dot"></span>
        ${!cli.found ? 'Not installed.' : cli.loggedIn ? 'Signed in — Reply and New robot work.' : cli.loggedIn === false ? 'Not signed in. Run claude in a terminal and type /login.' : 'Checking…'}</div>

      <div class="modal-actions">
        <button class="btn danger" id="s-quit">Quit AI Room</button>
        <span class="spacer"></span>
        <button class="btn ghost" data-close>Cancel</button>
        <button class="btn primary" id="s-save">Save</button>
      </div>`, (m) => {
      const hookBtn = $('#s-hook', m) || $('#s-unhook', m);
      hookBtn.addEventListener('click', async () => {
        try {
          if (hookBtn.id === 's-hook') await installHooks();
          else {
            await api('/api/hooks', { action: 'uninstall' });
            toast('Hooks disconnected. Backup saved in ~/.claude/ai-room.');
          }
          closeModal();
        } catch (err) {
          toast(err.message, true);
        }
      });
      $('#s-save', m).addEventListener('click', async () => {
        const notify = $('#s-notify', m).checked;
        if (notify && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
        try {
          const roomStyle = $('#s-style', m).value;
          if (roomStyle !== st.roomStyle) forgetRoomStyles();
          await api('/api/settings', {
            roomStyle,
            catchPermissions: $('#s-catch', m).checked,
            permissionTimeoutSec: $('#s-timeout', m).value,
            showHours: $('#s-hours', m).value,
            amberHours: $('#s-amber', m).value,
            scale: $('#s-scale', m).value,
            sound: $('#s-sound', m).checked,
            notify,
          });
          closeModal();
          for (const r of rooms.values()) r.canvas.style.width = '';
          toast('Saved.');
        } catch (err) {
          toast(err.message, true);
        }
      });
      $('#s-quit', m).addEventListener('click', async () => {
        if (!confirm('Stop the AI Room server? Claude sessions keep running; they just stop reporting here.')) return;
        await api('/api/quit', {}).catch(() => {});
        closeModal();
      });
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#modal-back').hidden) closeModal();
    else if (selectedId) closePanel();
  });

  // ---------------------------------------------------------------------------
  // Sounds and notifications when a robot starts needing you
  // ---------------------------------------------------------------------------

  let audio = null;
  document.addEventListener('pointerdown', () => {
    try {
      audio = audio || new AudioContext();
      if (audio.state === 'suspended') audio.resume();
    } catch { /* no audio */ }
  });

  function beep(notes) {
    if (!state || !state.settings.sound || !audio) return;
    const t0 = audio.currentTime + 0.01;
    notes.forEach(([freq, len], i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const at = t0 + i * 0.09;
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.035, at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + len);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + len + 0.02);
    });
  }

  function notify(s, text) {
    if (!state.settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden && document.hasFocus()) return;
    const n = new Notification(`${s.name} · ${text}`, { body: `${s.title}\n${s.detail}`, tag: s.id, silent: true });
    n.onclick = () => {
      window.focus();
      openPanel(s.id);
      n.close();
    };
  }

  function noticeChanges(s) {
    const now = {};
    for (const [id, x] of Object.entries(s.sessions)) now[id] = { state: x.state, perm: x.permission && x.permission.id };
    if (prevSessions) {
      for (const [id, x] of Object.entries(s.sessions)) {
        const before = prevSessions[id];
        if (x.state === 'blocked' && (!before || before.state !== 'blocked' || (x.permission && before.perm !== x.permission.id))) {
          beep([[880, 0.07], [660, 0.07], [880, 0.1]]);
          notify(x, x.reason === 'permission' ? 'needs permission' : 'is stuck');
        } else if (x.state === 'waiting' && (!before || before.state !== 'waiting')) {
          beep([[660, 0.07], [990, 0.12]]);
          notify(x, 'your turn');
          // You're looking right at it: count it as seen
          if (id === selectedId && !document.hidden) setTimeout(() => selectedId === id && markSeen(id), 2500);
        }
      }
    }
    prevSessions = now;
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------

  let toastTimer = null;
  function toast(text, isError) {
    const t = $('#toast');
    t.textContent = text;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 2600);
  }

  // ---------------------------------------------------------------------------
  // Animation loop (~15 frames a second is plenty for pixel art)
  // ---------------------------------------------------------------------------

  let lastFrame = 0;
  let lastSecond = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!state || now - lastFrame < 66) return;
    const dt = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    const wall = Date.now();
    for (const r of rooms.values()) {
      r.view.update(dt);
      r.view.draw(wall);
      placeCard(r);
    }
    if (selectedId) drawPortrait(wall);
    if (now - lastSecond > 1000) {
      lastSecond = now;
      tickTimers();
    }
  }
  requestAnimationFrame(frame);

  // Refresh "5m ago" labels now and then
  setInterval(() => { if (state) renderRooms(state); }, 15000);

  // Empty-state robot
  (function () {
    const c = $('#empty-bot');
    drawRobot(c.getContext('2d'), 'front', 0, 0, 222, STATE_COLORS.idle);
  })();

  // ---------------------------------------------------------------------------
  // Demo mode:  http://127.0.0.1:4777/?demo   (add &time=15:20 to fix the clock)
  // A pretend office with fake robots, for screenshots and trying things out.
  // ---------------------------------------------------------------------------

  let demo = null;

  function startDemo() {
    const t = /^(\d{1,2}):(\d{2})$/.exec(PARAMS.get('time') || '');
    if (t) {
      window.roomClock = () => {
        const d = new Date();
        d.setHours(Number(t[1]), Number(t[2]));
        return d;
      };
    }
    const now = Date.now();
    const game = 'C:\\Projects\\space-game';
    const site = 'C:\\Projects\\portfolio-site';
    const bot = (id, name, hue, room, title, state, detail, extra) => ({
      id, name, hue, room, cwd: room === 'game' ? game : site, title, state, detail, reason: null, since: now - 90e3,
      permission: null, lastActivity: now - 60e3, createdAt: now - hue * 1000, alive: true, where: 'Claude app',
      model: 'claude-opus-5-5', branch: 'main', lastPrompt: title, managed: false, placeholder: false, stopping: false,
      runError: null, canReply: false, canStop: state === 'working' || state === 'blocked', ...extra,
    });
    demo = {
      sessions: {
        a1: bot('a1', 'BOLT', 25, 'game', 'Add a boss fight', 'working', 'Editing Boss.js'),
        a2: bot('a2', 'PIXEL', 190, 'game', 'Fix the double-jump bug', 'waiting', 'Finished — your turn'),
        a3: bot('a3', 'COG', 130, 'game', 'Set up the game engine', 'blocked', 'Wants to run: npm install phaser', {
          reason: 'permission', where: 'Terminal',
          permission: { id: 'd1', toolName: 'Bash', pretty: 'Bash', verb: 'run', target: '', preview: 'npm install phaser@3 --save',
            kind: 'cmd', note: 'Install the Phaser game engine', answerable: true, source: 'hook', expiresAt: now + 110e3, reason: '', more: 0 },
        }),
        b1: bot('b1', 'NOVA', 280, 'site', 'Make the site work on phones', 'working', 'Running npm run build', { where: 'Terminal' }),
        b2: bot('b2', 'BYTE', 50, 'site', 'Write the About page', 'idle', 'Idle — session open', { lastActivity: now - 25 * 60e3 }),
        b3: bot('b3', 'ZIP', 330, 'site', 'Deploy to GitHub Pages', 'idle', 'Closed', { alive: false, lastActivity: now - 3 * 3600e3, canReply: true }),
      },
    };
    demoPublish();
    // &petnap puts every pet to sleep on the first computer (for screenshots)
    if (PARAMS.has('petnap')) {
      for (const r of rooms.values()) {
        const cx = r.view.deskCenter(0);
        r.view.pet = { x: cx - 6, y: 47, dir: 1, mode: 'sleep', surface: 'monitor', desk: 0, plan: [], step: { do: 'rest', mode: 'sleep', secs: 99 } };
      }
    }
  }

  // Sends the pretend state through the normal drawing code
  function demoPublish() {
    const counts = { working: 0, waiting: 0, blocked: 0, idle: 0 };
    for (const s of Object.values(demo.sessions)) counts[s.state]++;
    onState(JSON.parse(JSON.stringify({
      rooms: [
        { key: 'game', cwd: 'C:\\Projects\\space-game', name: 'space-game', hue: 205, sessions: ['a1', 'a2', 'a3'], lastActivity: 2 },
        { key: 'site', cwd: 'C:\\Projects\\portfolio-site', name: 'portfolio-site', hue: 140, sessions: ['b1', 'b2', 'b3'], lastActivity: 1 },
      ],
      sessions: demo.sessions,
      counts,
      hooks: { installed: true, partial: false, error: null },
      cli: { found: true, loggedIn: true, error: null },
      presence: { windows: 1, onScreen: 1 },
      settings: { showHours: 12, amberHours: 6, catchPermissions: true, permissionTimeoutSec: 120, sound: true, notify: false, scale: Number(PARAMS.get('scale')) || 3, roomStyle: 'mixed' },
    })));
  }

  function demoApi(path, body) {
    const s = demo.sessions;
    if (path.startsWith('/api/permission/')) {
      // Allowed/denied: COG walks back to its desk, works, then finishes
      Object.assign(s.a3, { state: 'working', reason: null, permission: null, detail: body.decision === 'allow' ? 'Running npm install phaser@3 --save' : 'Thinking…' });
      setTimeout(() => { Object.assign(s.a3, { state: 'waiting', detail: 'Finished — your turn', canStop: false }); demoPublish(); }, 6000);
      setTimeout(demoPublish, 50);
      return Promise.resolve({ ok: true });
    }
    const m = /^\/api\/session\/(\w+)\/(messages|seen)$/.exec(path);
    if (m && m[2] === 'seen') {
      if (s[m[1]] && s[m[1]].state === 'waiting') Object.assign(s[m[1]], { state: 'idle', detail: 'Idle — session open' });
      setTimeout(demoPublish, 50);
      return Promise.resolve({ ok: true });
    }
    if (m) {
      const x = s[m[1]];
      return Promise.resolve({ trimmed: false, items: [
        { kind: 'you', text: x.title + ', please.' },
        { kind: 'tool', pretty: 'Read', summary: 'src/game.js', result: '// (file contents)' },
        { kind: 'claude', text: `On it! I looked at **src/game.js** first.\n\nThis is the demo office, so nothing real happens here. Start AI Room normally to see your own Claude sessions.` },
      ] });
    }
    if (path === '/api/presence') return Promise.resolve({ ok: true });
    return Promise.reject(new Error('This is the demo office — start AI Room normally to use this button.'));
  }

  if (DEMO) startDemo();
  else connect();
})();
