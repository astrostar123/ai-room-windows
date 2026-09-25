// Draws one project room as pixel art on a <canvas>.
//
// Layout (in art pixels, before zooming):
//
//   | shelf |  desk 0  |  desk 1  | ... |  door  |
//   |_______|__________|__________|_____|________|   <- wall ends at y=72
//   |                 floor                      |
//
// Robots sit at their desk with their back to you, so you can see their screen.
// When one needs permission it walks over to the door.

(function () {
  const { drawRobot, text, textWidth, STATE_COLORS } = window.Sprites;

  const H = 128;           // room height
  const WALL = 72;         // wall height; floor starts just below
  const LEFT = 32;         // space for the bookshelf and plant
  const SLOT = 62;         // width of one desk
  const RIGHT = 54;        // space for the door
  const DESK_Y = 70;       // top of the desks
  const SEAT_FEET = 92;    // where a robot stands when it gets up
  const LANE_FEET = 110;   // the "corridor" robots walk along
  const DOOR_FEET = 84;    // standing at the door
  const WALK_SPEED = 46;   // pixels per second

  const CODE_COLORS = ['#7fdbca', '#c792ea', '#ffcb6b', '#82aaff', '#c3e88d', '#f78c6c', '#89ddff', '#5c6773'];

  // ---- small helpers ----

  function hashStr(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // Seeded random numbers, so a room always gets the same furniture
  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  function rect(ctx, x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }

  // Straight pixel line (for clock hands)
  function line(ctx, x0, y0, x1, y1, color) {
    ctx.fillStyle = color;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      ctx.fillRect(x0, y0, 1, 1);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  function lightFor(s, now) {
    if (!s) return STATE_COLORS.off;
    if (s.state === 'idle') return s.alive ? STATE_COLORS.idle : STATE_COLORS.off;
    const base = STATE_COLORS[s.state];
    // Working lights flicker like a busy hard drive; others blink slowly
    if (s.state === 'working') return Math.sin(now / 90 + s.hue) > 0.6 ? '#1f8a52' : base;
    if (s.state === 'blocked') return Math.floor(now / 350) % 2 ? base : '#8c2530';
    return Math.floor(now / 800) % 2 ? base : '#b07a10';
  }

  function isNight(hour) {
    return hour >= 20 || hour < 6;
  }

  function skyColors(hour) {
    if (isNight(hour)) return ['#0b1030', '#18204d'];
    if (hour < 8) return ['#6b5aa8', '#f7a26b'];
    if (hour < 17) return ['#6fbbef', '#b7e3fb'];
    return ['#6a3d7a', '#f08a5d'];
  }

  // ---------------------------------------------------------------------------

  class RoomView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.room = null;
      this.sessions = {};
      this.desks = [];           // desk index -> session id (or null)
      this.actors = new Map();   // session id -> where its robot is
      this.hover = null;
      this.selected = null;
      this.width = 0;
      this.seed = 1;
    }

    // Called whenever new state arrives from the server.
    setRoom(room, sessionsById) {
      this.room = room;
      this.sessions = sessionsById;
      this.seed = hashStr(room.key);
      const ids = room.sessions;

      // Keep each robot at the same desk; newcomers take the first free desk
      this.desks = this.desks.map((id) => (ids.includes(id) ? id : null));
      for (const id of ids) {
        if (this.desks.includes(id)) continue;
        const free = this.desks.indexOf(null);
        if (free >= 0) this.desks[free] = id;
        else this.desks.push(id);
      }
      while (this.desks.length && this.desks[this.desks.length - 1] === null) this.desks.pop();

      const slots = Math.max(2, this.desks.length);
      const width = LEFT + slots * SLOT + RIGHT;
      if (width !== this.width) {
        this.width = width;
        this.canvas.width = width;
        this.canvas.height = H;
      }

      for (const id of [...this.actors.keys()]) if (!ids.includes(id)) this.actors.delete(id);
      const queue = this.doorQueue();
      this.desks.forEach((id, i) => {
        if (!id || this.actors.has(id)) return;
        // New robots appear where they belong (no walking on first sight)
        const q = queue.indexOf(id);
        this.actors.set(id, q >= 0
          ? { id, x: this.doorX() + 3 - q * 15, feet: DOOR_FEET, mode: 'door', goal: 'door', path: [] }
          : { id, x: this.seatX(i), feet: SEAT_FEET, mode: 'seat', goal: 'seat', path: [] });
      });
    }

    wantsDoor(s) {
      return !!s && s.state === 'blocked' && s.reason === 'permission';
    }

    deskCenter(i) { return LEFT + i * SLOT + SLOT / 2; }
    seatX(i) { return this.deskCenter(i) - 7; }
    doorX() { return this.width - RIGHT + 16; }

    // Robots queue at the door, oldest question first
    doorQueue() {
      return this.desks
        .filter((id) => id && this.wantsDoor(this.sessions[id]))
        .sort((a, b) => (this.sessions[a].since || 0) - (this.sessions[b].since || 0));
    }

    // Moves robots between their desk and the door.
    update(dt) {
      const queue = this.doorQueue();
      this.desks.forEach((id, i) => {
        if (!id) return;
        const a = this.actors.get(id);
        const s = this.sessions[id];
        if (!a || !s) return;
        const q = queue.indexOf(id);
        const want = q >= 0 ? 'door' : 'seat';
        const targetX = want === 'door' ? this.doorX() + 3 - q * 15 : this.seatX(i);
        const targetFeet = want === 'door' ? DOOR_FEET : SEAT_FEET;

        if (a.mode === 'door' && want === 'door' && Math.abs(a.x - targetX) > 0.5) {
          // Just shuffling along the queue
          a.mode = 'walk';
          a.path = [{ x: targetX, feet: DOOR_FEET }];
        } else if (a.goal !== want) {
          // Get up, walk along the corridor, then go to the door (or back to the desk)
          a.goal = want;
          a.mode = 'walk';
          a.path = [];
          if (Math.abs(a.feet - LANE_FEET) > 0.5) a.path.push({ x: a.x, feet: LANE_FEET });
          a.path.push({ x: targetX, feet: LANE_FEET }, { x: targetX, feet: targetFeet });
        }

        if (a.mode === 'walk') {
          let budget = WALK_SPEED * dt;
          while (budget > 0 && a.path.length) {
            const p = a.path[0];
            const dx = p.x - a.x, dy = p.feet - a.feet;
            const dist = Math.hypot(dx, dy);
            if (dist <= budget) {
              a.x = p.x; a.feet = p.feet; budget -= dist; a.path.shift();
            } else {
              a.x += (dx / dist) * budget; a.feet += (dy / dist) * budget; budget = 0;
            }
          }
          if (!a.path.length) a.mode = a.goal;
        }
      });
    }

    // Robot fully standing at the door (for the permission card)
    doorActor() {
      const first = this.doorQueue()[0];
      const a = first && this.actors.get(first);
      return a && a.mode === 'door' ? { id: first, x: a.x, top: a.feet - 22 } : null;
    }

    // Which session is at art pixel (x, y)?
    hitTest(x, y) {
      for (const a of this.actors.values()) {
        if (a.mode !== 'seat' && x >= a.x - 1 && x <= a.x + 16 && y >= a.feet - 24 && y <= a.feet + 1) return a.id;
      }
      if (y < 28 || y > 100) return null;
      const i = Math.floor((x - LEFT) / SLOT);
      return i >= 0 && i < this.desks.length ? this.desks[i] : null;
    }

    // -------------------------------------------------------------------------
    // Drawing
    // -------------------------------------------------------------------------

    draw(now) {
      if (!this.room) return;
      const ctx = this.ctx;
      const date = window.roomClock ? window.roomClock() : new Date(); // demo mode can fix the time
      const hour = date.getHours();
      const hue = this.room.hue;
      const W = this.width;

      ctx.imageSmoothingEnabled = false;
      this.drawWall(ctx, W, hue);
      this.drawWindows(ctx, now, hour);
      this.drawClock(ctx, W - RIGHT + 26, 13, date);
      this.drawFloor(ctx, W, hue);
      const doorOpen = [...this.actors.values()].some((a) => a.goal === 'door' && a.mode === 'door');
      this.drawDoor(ctx, doorOpen);
      this.drawShelf(ctx);

      // Desks (and seated robots)
      const slots = Math.max(2, this.desks.length);
      for (let i = 0; i < slots; i++) {
        const id = this.desks[i];
        if (id) this.drawDesk(ctx, i, this.sessions[id], this.actors.get(id), now);
        else this.drawSpare(ctx, i);
      }
      this.drawPlant(ctx);

      // Walking / waiting-at-door robots, back to front
      const standing = [...this.actors.values()].filter((a) => a.mode !== 'seat').sort((a, b) => a.feet - b.feet);
      for (const a of standing) this.drawStanding(ctx, a, this.sessions[a.id], now);

      // Night time: dim the room, then add the glowing screens back on top
      const night = isNight(hour);
      if (night) rect(ctx, 0, 0, W, H, 'rgba(10, 12, 40, 0.38)');
      for (let i = 0; i < this.desks.length; i++) {
        const id = this.desks[i];
        if (id) this.drawScreen(ctx, i, this.sessions[id], this.actors.get(id), now, night);
      }
      this.drawBulbs(ctx, now, night);

      // Speech bubbles on top of everything
      for (let i = 0; i < this.desks.length; i++) {
        const id = this.desks[i];
        if (id) this.drawBubble(ctx, i, this.sessions[id], this.actors.get(id), now);
      }
    }

    drawWall(ctx, W, hue) {
      rect(ctx, 0, 0, W, WALL, `hsl(${hue} 20% 29%)`);
      for (let x = 2; x < W; x += 8) rect(ctx, x, 3, 3, WALL - 3, `hsl(${hue} 20% 31%)`); // wallpaper stripes
      rect(ctx, 0, 0, W, 3, `hsl(${hue} 22% 20%)`);                                        // top trim
      rect(ctx, 0, WALL - 1, W, 1, `hsl(${hue} 18% 24%)`);
      rect(ctx, 0, WALL, W, 3, `hsl(${hue} 18% 15%)`);                                     // skirting board
      rect(ctx, 0, WALL, W, 1, `hsl(${hue} 18% 26%)`);
    }

    drawFloor(ctx, W, hue) {
      const top = WALL + 3;
      const kind = this.seed % 3;
      if (kind === 0) {
        // Wooden planks
        for (let y = top, row = 0; y < H; y += 7, row++) {
          rect(ctx, 0, y, W, 7, row % 2 ? '#654635' : '#6c4b39');
          rect(ctx, 0, y + 6, W, 1, '#4b3226');
          for (let x = (row * 23) % 44; x < W; x += 44) rect(ctx, x, y, 1, 6, '#523727');
        }
      } else if (kind === 1) {
        // Tiles
        for (let y = top, row = 0; y < H; y += 8, row++) {
          for (let x = 0, col = 0; x < W; x += 8, col++) rect(ctx, x, y, 8, 8, (row + col) % 2 ? '#3b4260' : '#434b6b');
        }
      } else {
        // Carpet
        rect(ctx, 0, top, W, H - top, `hsl(${(hue + 180) % 360} 18% 27%)`);
        const r = rng(this.seed);
        for (let i = 0; i < W * 0.8; i++) rect(ctx, Math.floor(r() * W), top + Math.floor(r() * (H - top)), 1, 1, `hsl(${(hue + 180) % 360} 18% 32%)`);
      }
      rect(ctx, 0, top, W, 2, 'rgba(0,0,0,0.25)'); // shadow where floor meets wall
    }

    drawWindows(ctx, now, hour) {
      const [top, bottom] = skyColors(hour);
      const slots = Math.max(2, this.desks.length);
      for (let i = 0; i < slots; i += 2) {
        const x = this.deskCenter(i) + SLOT / 2 - 14;
        const y = 8;
        const w = 28, h = 20;
        rect(ctx, x - 1, y - 1, w + 2, h + 2, '#1b1622');
        rect(ctx, x, y, w, h, '#8a6a4a');
        rect(ctx, x + 2, y + 2, w - 4, (h - 4) / 2, top);
        rect(ctx, x + 2, y + 2 + (h - 4) / 2, w - 4, (h - 4) / 2, bottom);
        if (isNight(hour)) {
          const r = rng(this.seed + i);
          for (let k = 0; k < 5; k++) {
            const sx = x + 3 + Math.floor(r() * (w - 6)), sy = y + 3 + Math.floor(r() * 7);
            if (Math.sin(now / 700 + k * 2 + i) > -0.6) rect(ctx, sx, sy, 1, 1, '#f5f1c8');
          }
          rect(ctx, x + w - 9, y + 4, 3, 3, '#f1ecc4'); // moon
        } else {
          // A cloud drifting past
          const cx = x + 2 + ((now / 1000) * 1.5 + this.seed % 40 + i * 13) % (w + 6) - 6;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x + 2, y + 2, w - 4, h - 4);
          ctx.clip();
          rect(ctx, cx, y + 6, 7, 2, 'rgba(255,255,255,0.85)');
          rect(ctx, cx + 2, y + 5, 3, 1, 'rgba(255,255,255,0.85)');
          ctx.restore();
        }
        rect(ctx, x + w / 2 - 1, y, 2, h, '#8a6a4a');       // window bars
        rect(ctx, x, y + h / 2 - 1, w, 2, '#8a6a4a');
        rect(ctx, x - 2, y + h, w + 4, 2, '#a07d58');       // sill
      }
      // A poster above every other desk
      const r = rng(this.seed * 3);
      for (let i = 1; i < slots; i += 2) {
        const x = this.deskCenter(i) + SLOT / 2 - 9;
        const y = 10;
        const c = `hsl(${Math.floor(r() * 360)} 45% 55%)`;
        rect(ctx, x - 1, y - 1, 16, 20, '#15161f');
        rect(ctx, x, y, 14, 18, '#e9e3d0');
        rect(ctx, x + 2, y + 2, 10, 9, c);
        rect(ctx, x + 5, y + 4, 4, 4, '#e9e3d0');
        rect(ctx, x + 2, y + 13, 10, 1, '#9a9486');
        rect(ctx, x + 2, y + 15, 7, 1, '#9a9486');
      }
    }

    drawClock(ctx, cx, cy, date) {
      const R = 5;
      for (let y = -R - 1; y <= R + 1; y++) {
        for (let x = -R - 1; x <= R + 1; x++) {
          const d = Math.hypot(x, y);
          if (d <= R + 1.2) rect(ctx, cx + x, cy + y, 1, 1, d > R ? '#15161f' : '#ece6d4');
        }
      }
      const m = date.getMinutes(), h = (date.getHours() % 12) + m / 60;
      const ma = (m / 60) * Math.PI * 2, ha = (h / 12) * Math.PI * 2;
      line(ctx, cx, cy, cx + Math.round(Math.sin(ma) * 4), cy - Math.round(Math.cos(ma) * 4), '#2b2d3c');
      line(ctx, cx, cy, cx + Math.round(Math.sin(ha) * 2.6), cy - Math.round(Math.cos(ha) * 2.6), '#c0392b');
    }

    drawDoor(ctx, open) {
      const x = this.doorX(), y = 34, w = 22, h = WALL - 34 + 1;
      // EXIT sign
      rect(ctx, x + 2, y - 9, 18, 7, '#15161f');
      rect(ctx, x + 3, y - 8, 16, 5, '#1f9a57');
      text(ctx, 'EXIT', x + 4, y - 8, '#e9fff1');
      // Frame
      rect(ctx, x - 2, y - 2, w + 4, h + 2, '#241c2c');
      if (open) {
        rect(ctx, x, y, w, h, '#f6e7a6');                 // light from outside
        rect(ctx, x, y, 12, h, '#7a5238');                // door swung open
        rect(ctx, x + 2, y + 3, 8, 12, '#6a4530');
        rect(ctx, x + 2, y + 19, 8, 13, '#6a4530');
        ctx.fillStyle = 'rgba(246,231,166,0.18)';          // light spilling onto the floor
        ctx.fillRect(x + 12, WALL + 3, 12, 14);
      } else {
        rect(ctx, x, y, w, h, '#7a5238');
        rect(ctx, x + 3, y + 3, w - 6, 12, '#6a4530');
        rect(ctx, x + 3, y + 19, w - 6, 13, '#6a4530');
        rect(ctx, x + w - 5, y + 18, 2, 2, '#e8c14a');    // door knob
      }
    }

    drawShelf(ctx) {
      const x = 4, y = 30, w = 24, h = WALL - 30;
      rect(ctx, x - 1, y - 1, w + 2, h + 1, '#15161f');
      rect(ctx, x, y, w, h, '#5a3f2b');
      const r = rng(this.seed * 7);
      for (let s = 0; s < 3; s++) {
        const sy = y + 2 + s * 13;
        rect(ctx, x + 1, sy, w - 2, 10, '#3a281c');
        let bx = x + 2;
        while (bx < x + w - 4) {
          const bw = 2 + Math.floor(r() * 2), bh = 6 + Math.floor(r() * 4);
          rect(ctx, bx, sy + 10 - bh, bw, bh, `hsl(${Math.floor(r() * 360)} 40% ${40 + Math.floor(r() * 20)}%)`);
          bx += bw + (r() < 0.25 ? 1 : 0);
        }
        rect(ctx, x, sy + 10, w, 2, '#6d4d35');
      }
    }

    drawPlant(ctx) {
      const x = 6, y = 104;
      rect(ctx, x, y, 14, 12, '#15161f');
      rect(ctx, x + 1, y + 1, 12, 10, '#b5653f');
      rect(ctx, x + 1, y + 1, 12, 2, '#cc7a52');
      const leaves = [[7, -14], [3, -10], [11, -11], [5, -6], [9, -5], [1, -4], [13, -6]];
      for (const [lx, ly] of leaves) {
        rect(ctx, x + lx - 1, y + ly, 3, 5, '#2f7a45');
        rect(ctx, x + lx, y + ly + 1, 1, 3, '#49a862');
      }
    }

    // An unused desk slot gets a water cooler
    drawSpare(ctx, i) {
      const cx = this.deskCenter(i);
      rect(ctx, cx - 6, 64, 12, 30, '#15161f');
      rect(ctx, cx - 5, 76, 10, 17, '#d7dbe6');
      rect(ctx, cx - 4, 65, 8, 11, '#7cc3ee');
      rect(ctx, cx - 3, 67, 2, 6, '#b4e1fb');
      rect(ctx, cx - 1, 80, 3, 2, '#3a3e55');
    }

    drawDesk(ctx, i, s, actor, now) {
      const cx = this.deskCenter(i);
      const mx = cx - 13, my = DESK_Y - 22;
      const on = s && !(s.state === 'idle' && !s.alive);
      const light = lightFor(s, now);

      // Glow on the wall behind a screen that's on
      if (s && s.state !== 'idle') {
        const pulse = s.state === 'blocked' ? 0.08 + 0.05 * Math.sin(now / 200) : 0.1;
        ctx.globalAlpha = pulse;
        rect(ctx, mx - 6, my - 6, 38, 30, STATE_COLORS[s.state]);
        ctx.globalAlpha = pulse * 0.6;
        rect(ctx, mx - 11, my - 10, 48, 38, STATE_COLORS[s.state]);
        ctx.globalAlpha = 1;
      }

      // Name plate on the wall, with a status light
      if (s) {
        const label = s.name;
        const tw = textWidth(label) + 9;
        const px = Math.round(cx - tw / 2), py = my - 11;
        const hot = this.selected === s.id || this.hover === s.id;
        rect(ctx, px - 1, py - 1, tw + 2, 9, hot ? '#ffffff' : '#0e0f16');
        rect(ctx, px, py, tw, 7, '#1d1f2e');
        rect(ctx, px + 2, py + 2, 2, 3, light);
        text(ctx, label, px + 6, py + 1, '#d9dcef');
        if (this.selected === s.id) {
          const bob = Math.floor(now / 300) % 2;
          rect(ctx, cx - 2, py - 6 + bob, 5, 1, '#ffffff');
          rect(ctx, cx - 1, py - 5 + bob, 3, 1, '#ffffff');
          rect(ctx, cx, py - 4 + bob, 1, 1, '#ffffff');
        }
      }

      // Monitor
      rect(ctx, mx - 1, my - 1, 28, 19, '#0e0f16');
      rect(ctx, mx, my, 26, 17, '#2a2d42');
      rect(ctx, mx + 1, my + 1, 24, 15, '#1c1e2d');
      rect(ctx, mx + 2, my + 2, 22, 13, on ? '#0b0d15' : '#08090e');
      rect(ctx, mx + 22, my + 15, 2, 1, on ? light : '#3a3e55'); // power light
      rect(ctx, cx - 2, my + 17, 4, 3, '#3a3e55');                // stand
      rect(ctx, cx - 6, my + 20, 12, 2, '#2a2d42');

      // Desk
      const dx = cx - 26;
      rect(ctx, dx - 1, DESK_Y - 1, 54, 19, '#15161f');
      rect(ctx, dx, DESK_Y, 52, 3, '#9c7650');
      rect(ctx, dx, DESK_Y, 52, 1, '#b89066');
      rect(ctx, dx, DESK_Y + 3, 52, 13, '#7d5b3d');
      rect(ctx, dx + 3, DESK_Y + 5, 14, 4, '#6d4f34');
      rect(ctx, dx + 3, DESK_Y + 10, 14, 4, '#6d4f34');
      rect(ctx, dx + 9, DESK_Y + 7, 2, 1, '#caa46a');
      rect(ctx, dx + 9, DESK_Y + 12, 2, 1, '#caa46a');
      rect(ctx, dx + 1, DESK_Y + 16, 3, 4, '#5a4029');
      rect(ctx, dx + 48, DESK_Y + 16, 3, 4, '#5a4029');
      rect(ctx, dx, DESK_Y + 20, 52, 1, 'rgba(0,0,0,0.25)');

      // Mug (steams while working) and a paper stack
      const r = rng(this.seed + i * 31);
      if (r() < 0.8) {
        rect(ctx, cx + 16, DESK_Y - 5, 5, 5, '#15161f');
        rect(ctx, cx + 17, DESK_Y - 4, 3, 4, ['#e0e0e0', '#d65b5b', '#5b8fd6', '#e8c14a'][Math.floor(r() * 4)]);
        rect(ctx, cx + 21, DESK_Y - 3, 1, 2, '#15161f');
        if (s && s.state === 'working') {
          const t = Math.floor(now / 250) % 3;
          ctx.globalAlpha = 0.6;
          rect(ctx, cx + 18 + (t === 1 ? 1 : 0), DESK_Y - 7 - t, 1, 1, '#ffffff');
          ctx.globalAlpha = 1;
        }
      }
      if (r() < 0.6) {
        rect(ctx, cx - 23, DESK_Y - 2, 8, 2, '#15161f');
        rect(ctx, cx - 22, DESK_Y - 2, 6, 1, '#f1efe6');
        rect(ctx, cx - 23, DESK_Y - 1, 8, 1, '#dcd8c8');
      }

      // Robot in its chair (if it's at the desk)
      const seated = !actor || actor.mode === 'seat';
      const rx = cx - 7, ry = DESK_Y - 1;
      if (!seated) {
        this.drawChair(ctx, cx, true);
        return;
      }
      const facingYou = s && (s.state === 'waiting' || s.state === 'blocked');
      if (facingYou) {
        this.drawChair(ctx, cx, false);
        drawRobot(ctx, this.frontPose(s, now), rx + this.shake(s, now), ry, s.hue, light);
      } else {
        drawRobot(ctx, this.backPose(s, now), rx, ry, s ? s.hue : 220, light);
        this.drawChair(ctx, cx, true);
      }
    }

    frontPose(s, now) {
      const beat = (now + s.hue * 37) % 4200;
      if (s.state === 'waiting' && beat < 700) return Math.floor(beat / 175) % 2 ? 'wave' : 'sitFront';
      return beat > 4000 ? 'sitFrontBlink' : 'sitFront';
    }

    backPose(s, now) {
      if (!s) return 'back';
      if (s.state === 'working') return ['back', 'backTypeL', 'back', 'backTypeR'][Math.floor(now / 130) % 4];
      if (s.state === 'idle' && !s.alive) return 'backSleep';
      // Idle but open: fidget now and then
      return (now + s.hue * 50) % 6000 < 200 ? 'backTypeL' : 'back';
    }

    shake(s, now) {
      return s.state === 'blocked' && Math.floor(now / 90) % 12 < 2 ? (Math.floor(now / 45) % 2 ? 1 : -1) : 0;
    }

    // Office chair; from behind (back = true) you see the backrest
    drawChair(ctx, cx, back) {
      const x = cx - 7, y = DESK_Y + 15; // low enough that the robot's back light shows
      if (back) {
        rect(ctx, x, y, 15, 7, '#15161f');
        rect(ctx, x + 1, y + 1, 13, 5, '#3b3350');
        rect(ctx, x + 2, y + 1, 11, 1, '#4d4468');
      } else {
        rect(ctx, x + 1, y + 2, 13, 5, '#15161f');
        rect(ctx, x + 2, y + 3, 11, 3, '#2a2439');
      }
      rect(ctx, cx - 1, y + 7, 3, 4, '#2a2d42');
      rect(ctx, cx - 6, y + 11, 13, 1, '#2a2d42');
      rect(ctx, cx - 6, y + 12, 2, 1, '#15161f');
      rect(ctx, cx, y + 12, 1, 1, '#15161f');
      rect(ctx, cx + 5, y + 12, 2, 1, '#15161f');
    }

    drawStanding(ctx, a, s, now) {
      const light = lightFor(s, now);
      const x = Math.round(a.x), y = Math.round(a.feet) - 22;
      rect(ctx, x + 2, Math.round(a.feet), 11, 1, 'rgba(0,0,0,0.3)'); // shadow
      let pose = 'front';
      if (a.mode === 'walk') pose = Math.floor(now / 140) % 2 ? 'walkL' : 'walkR';
      else if ((now + (s ? s.hue : 0) * 20) % 3000 > 2850) pose = 'frontBlink';
      drawRobot(ctx, pose, x, y, s ? s.hue : 220, light);
    }

    // The monitor picture: code, "YOUR TURN", "ALLOW?", or dark
    drawScreen(ctx, i, s, actor, now, night) {
      const cx = this.deskCenter(i);
      const sx = cx - 11, sy = DESK_Y - 20, w = 22, h = 13;
      if (!s) return;
      const blink = Math.floor(now / 500) % 2 === 0;

      if (s.state === 'working') {
        rect(ctx, sx, sy, w, h, '#08130d');
        const seed = (this.seed + i * 977) >>> 0;
        const offset = Math.floor((now / 1000) * 7);
        let lastRow = null;
        for (let yy = 0; yy < h - 1; yy++) {
          const v = offset + yy;
          if (v % 2) continue;
          const r = rng(seed * 31 + v * 7919);
          if (r() < 0.14) continue; // blank line
          let x = Math.floor(r() * 4) * 2;
          const parts = 1 + Math.floor(r() * 3);
          for (let k = 0; k < parts && x < w - 2; k++) {
            const pw = Math.min(2 + Math.floor(r() * 6), w - 1 - x);
            rect(ctx, sx + x, sy + yy, pw, 1, CODE_COLORS[Math.floor(r() * CODE_COLORS.length)]);
            x += pw + 1;
          }
          lastRow = { yy, x };
        }
        if (lastRow && blink) rect(ctx, sx + Math.min(lastRow.x, w - 2), sy + lastRow.yy, 2, 1, '#e6fff0');
      } else if (s.state === 'waiting') {
        rect(ctx, sx, sy, w, h, '#1d1404');
        text(ctx, 'YOUR', sx + 3, sy + 1, '#ffb627');
        text(ctx, 'TURN', sx + 3, sy + 7, '#ffb627');
        if (blink) rect(ctx, sx + 19, sy + 11, 2, 1, '#ffd98a');
      } else if (s.state === 'blocked') {
        rect(ctx, sx, sy, w, h, '#1f070b');
        const word = s.reason === 'permission' ? 'ALLOW' : s.reason === 'question' ? 'ASK' : 'ERROR';
        text(ctx, word, sx + Math.floor((w - textWidth(word)) / 2), sy + 1, '#ff4f5e');
        if (blink) text(ctx, s.reason === 'error' ? '!' : '?', sx + 10, sy + 7, '#ffb3ba');
      } else if (s.alive) {
        // Screensaver: a little square bouncing around
        rect(ctx, sx, sy, w, h, '#07080d');
        const t = now / 1000 + s.hue;
        const bx = Math.floor(Math.abs(((t * 5) % ((w - 3) * 2)) - (w - 3)));
        const by = Math.floor(Math.abs(((t * 3) % ((h - 2) * 2)) - (h - 2)));
        rect(ctx, sx + bx, sy + by, 3, 2, `hsl(${s.hue} 45% 45%)`);
      } else {
        rect(ctx, sx, sy, w, h, '#08090e');
        rect(ctx, sx + 3, sy + 1, 1, 4, '#151827'); // reflection on a switched-off screen
        rect(ctx, sx + 5, sy + 1, 1, 2, '#151827');
      }
      if (night && s.state !== 'idle') {
        ctx.globalAlpha = 0.12;
        rect(ctx, sx - 8, sy - 6, w + 16, h + 26, STATE_COLORS[s.state]);
        ctx.globalAlpha = 1;
      }
    }

    // Antenna lights glow, so you can read every robot's colour from across the room
    drawBulbs(ctx, now, night) {
      this.desks.forEach((id, i) => {
        const s = id && this.sessions[id];
        const a = id && this.actors.get(id);
        if (!s || !a) return;
        const light = lightFor(s, now);
        let bx, by;
        if (a.mode === 'seat') {
          const sleeping = s.state === 'idle' && !s.alive;
          bx = this.deskCenter(i) - 1;
          by = DESK_Y - 1 + (sleeping ? 1 : 0);
        } else {
          bx = Math.round(a.x) + 6;
          by = Math.round(a.feet) - 22;
        }
        if (s.state !== 'idle') {
          ctx.globalAlpha = 0.22;
          rect(ctx, bx - 3, by - 3, 9, 8, light);
          ctx.globalAlpha = 0.45;
          rect(ctx, bx - 1, by - 1, 5, 4, light);
          ctx.globalAlpha = 1;
        }
        if (night || s.state !== 'idle') rect(ctx, bx, by, 3, 2, light);
      });
    }

    drawBubble(ctx, i, s, actor, now) {
      if (!s || !actor) return;
      const cx = this.deskCenter(i);
      const bob = Math.floor(now / 400) % 2;
      if (actor.mode !== 'seat') {
        if (actor.mode === 'door') this.bubble(ctx, Math.round(actor.x) + 11, Math.round(actor.feet) - 33 + bob, '!', '#ff4f5e');
        return;
      }
      if (s.state === 'waiting') this.bubble(ctx, cx + 8, DESK_Y - 11 + bob, '?', '#e09a10');
      else if (s.state === 'blocked') this.bubble(ctx, cx + 8, DESK_Y - 11 + bob, '!', '#ff4f5e');
      else if (s.stopping) this.bubble(ctx, cx + 8, DESK_Y - 11 + bob, '.', '#5f6488');
      else if (s.state === 'idle' && !s.alive) {
        // Floating Zzz
        for (let k = 0; k < 3; k++) {
          const t = ((now / 1000 + k * 0.9 + s.hue) % 2.7) / 2.7;
          ctx.globalAlpha = 1 - t;
          text(ctx, 'Z', cx + 12 + Math.round(t * 6), DESK_Y - 2 - Math.round(t * 14), '#c9cde6');
        }
        ctx.globalAlpha = 1;
      }
    }

    bubble(ctx, x, y, glyph, color) {
      rect(ctx, x, y + 1, 9, 7, '#15161f');
      rect(ctx, x + 1, y, 7, 9, '#15161f');
      rect(ctx, x + 1, y + 1, 7, 7, '#ffffff');
      rect(ctx, x + 1, y + 9, 2, 1, '#15161f'); // tail
      rect(ctx, x, y + 10, 1, 1, '#15161f');
      if (glyph === '.') {
        rect(ctx, x + 2, y + 5, 1, 1, color);
        rect(ctx, x + 4, y + 5, 1, 1, color);
        rect(ctx, x + 6, y + 5, 1, 1, color);
      } else {
        text(ctx, glyph, x + 3, y + 2, color);
      }
    }
  }

  window.RoomView = RoomView;
  window.RoomLayout = { H, LEFT, SLOT, RIGHT, DESK_Y };
})();
