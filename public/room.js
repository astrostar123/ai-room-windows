// Draws one project room as pixel art on a <canvas>.
//
// Layout (in art pixels, before zooming):
//
//   | corner |  desk 0  |  desk 1  |  desk 2  |  desk 3  |  door  |   <- back wall
//   |________|__________|__________|__________|__________|        |
//   |           row 2 of desks (desk 4, 5, …)            |  aisle |   <- more robots,
//   |                                                    |        |      more rows
//
// At most 4 desks sit in a row. More robots get another row and the room grows
// taller, so nothing has to shrink.
//
// The walls, floor and decorations come from the room's style (themes.js).
// This file draws the desks, the robots and their screens, and moves robots
// around: when one needs permission it walks over to the door.

(function () {
  const { drawRobot, text, textWidth, STATE_COLORS } = window.Sprites;
  const Themes = window.RoomThemes;

  const BASE_H = 128;      // height of a room with one row of desks
  const ROW_H = 70;        // extra height for every extra row
  const MAX_COLS = 4;      // desks per row
  const WALL = 72;         // wall height; floor starts just below
  const LEFT = 32;         // space for the corner furniture
  const SLOT = 62;         // width of one desk
  const RIGHT = 54;        // space for the door (and the aisle to it)
  const DESK_Y = 70;       // top of the first row of desks
  const DOOR_FEET = 84;    // standing at the door
  const WALK_SPEED = 46;   // pixels per second

  const CODE_COLORS = ['#7fdbca', '#c792ea', '#ffcb6b', '#82aaff', '#c3e88d', '#f78c6c', '#89ddff', '#5c6773'];

  // Tiny helper robot (for sub-agents), 5 x 6 pixels
  const HELPER = ['..s..', '.ooo.', 'obebo', 'obbbo', '.ooo.', '.o.o.'];

  // ---- small helpers ----

  function hashStr(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // Seeded random numbers, so a room always looks the same
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

  function lightFor(s, now) {
    if (!s) return STATE_COLORS.off;
    if (s.state === 'idle') return s.alive ? STATE_COLORS.idle : STATE_COLORS.off;
    const base = STATE_COLORS[s.state];
    // Working lights flicker like a busy hard drive; others blink slowly
    if (s.state === 'working') return Math.sin(now / 90 + s.hue) > 0.6 ? '#1f8a52' : base;
    if (s.state === 'blocked') return Math.floor(now / 350) % 2 ? base : '#8c2530';
    return Math.floor(now / 800) % 2 ? base : '#b07a10';
  }

  // How many rows and columns of desks a room needs for n desks
  function grid(n) {
    const rows = Math.max(1, Math.ceil(n / MAX_COLS));
    const cols = Math.max(2, Math.ceil(n / rows));
    return { rows, cols };
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
      this.pet = null;           // the room's cat or drone
      this.hover = null;
      this.selected = null;
      this.width = 0;
      this.height = BASE_H;
      this.rows = 1;
      this.cols = 2;
      this.seed = 1;
      this.style = 'mixed';
    }

    // Called whenever new state arrives from the server.
    setRoom(room, sessionsById, style) {
      this.room = room;
      this.sessions = sessionsById;
      this.seed = hashStr(room.key);
      this.style = style || 'mixed';
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

      const { rows, cols } = grid(this.desks.length);
      const width = LEFT + cols * SLOT + RIGHT;
      const height = BASE_H + (rows - 1) * ROW_H;
      this.rows = rows;
      this.cols = cols;
      if (width !== this.width || height !== this.height || !this.canvas.width) {
        this.width = width;
        this.height = height;
        this.canvas.width = width;
        this.canvas.height = height;
        this.pet = null; // the room changed shape; the pet starts fresh
      }

      for (const id of [...this.actors.keys()]) if (!ids.includes(id)) this.actors.delete(id);
      const queue = this.doorQueue();
      this.desks.forEach((id, i) => {
        if (!id || this.actors.has(id)) return;
        // New robots appear where they belong (no walking on first sight)
        const q = queue.indexOf(id);
        this.actors.set(id, q >= 0
          ? { id, x: this.doorX() + 3 - q * 15, feet: DOOR_FEET, mode: 'door', goal: 'door', path: [] }
          : { id, x: this.seatX(i), feet: this.seatFeet(i), mode: 'seat', goal: 'seat', path: [] });
      });
    }

    // Which style this room uses ("mixed" picks one from the folder name)
    theme() {
      return Themes.pick(this.style, this.seed);
    }

    wantsDoor(s) {
      return !!s && s.state === 'blocked' && s.reason === 'permission';
    }

    // Where desk i is
    deskRow(i) { return Math.floor(i / this.cols); }
    deskCenter(i) { return LEFT + (i % this.cols) * SLOT + SLOT / 2; }
    deskTop(i) { return DESK_Y + this.deskRow(i) * ROW_H; }
    seatX(i) { return this.deskCenter(i) - 7; }
    seatFeet(i) { return this.deskTop(i) + 22; }  // where a robot stands when it gets up
    laneFeet(i) { return this.deskTop(i) + 40; }  // the aisle in front of that row
    doorX() { return this.width - RIGHT + 16; }

    // Robots queue at the door, oldest question first
    doorQueue() {
      return this.desks
        .filter((id) => id && this.wantsDoor(this.sessions[id]))
        .sort((a, b) => (this.sessions[a].since || 0) - (this.sessions[b].since || 0));
    }

    // Moves robots between their desk and the door, and walks the pet.
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
        const targetFeet = want === 'door' ? DOOR_FEET : this.seatFeet(i);
        const lane = this.laneFeet(i);

        if (a.mode === 'door' && want === 'door' && Math.abs(a.x - targetX) > 0.5) {
          // Just shuffling along the queue
          a.mode = 'walk';
          a.path = [{ x: targetX, feet: DOOR_FEET }];
        } else if (a.goal !== want) {
          // Get up, walk along the aisle, then go to the door (or back to the desk)
          a.goal = want;
          a.mode = 'walk';
          a.path = [];
          if (Math.abs(a.feet - lane) > 0.5) a.path.push({ x: a.x, feet: lane });
          a.path.push({ x: targetX, feet: lane }, { x: targetX, feet: targetFeet });
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
      this.updatePet(dt);
    }

    // -------------------------------------------------------------------------
    // The pet. It follows a little plan, one step at a time:
    //   walk / run somewhere, jump up or down, or rest (sit or sleep).
    // Its y is where its feet are: the floor, a desk top, or on top of a monitor.
    // -------------------------------------------------------------------------

    // A random place on the floor (in one of the aisles between desk rows)
    petSpot() {
      const row = Math.floor(Math.random() * this.rows);
      const top = DESK_Y + row * ROW_H + 36;
      const bottom = row === this.rows - 1 ? this.height - 5 : top + 10;
      return { x: LEFT + 2 + Math.random() * (this.doorX() - LEFT - 22), y: top + Math.random() * (bottom - top) };
    }

    updatePet(dt) {
      if (!this.width) return;
      if (!this.pet) {
        const r = rng(this.seed * 17);
        const start = this.petSpot();
        this.pet = { x: start.x, y: start.y, dir: 1, mode: 'sit', surface: 'floor', desk: -1, plan: [], step: { do: 'rest', mode: 'sleep', secs: 1 + r() * 3 } };
      }
      const p = this.pet;

      // Its desk went away (robot left the room): land back on the floor
      if (p.desk >= 0 && !this.desks[p.desk]) {
        Object.assign(p, this.petSpot(), { surface: 'floor', desk: -1, plan: [], step: null });
      }
      if (!p.step) p.step = p.plan.shift() || null;
      if (!p.step) {
        p.plan = this.petPlan();
        p.step = p.plan.shift();
      }

      const st = p.step;
      if (st.do === 'walk') {
        const dx = st.x - p.x, dy = st.y - p.y;
        const dist = Math.hypot(dx, dy);
        const move = st.speed * dt;
        p.mode = st.speed > 30 ? 'run' : 'walk';
        if (Math.abs(dx) > 0.5) p.dir = Math.sign(dx);
        if (dist <= move) {
          p.x = st.x;
          p.y = st.y;
          p.step = null;
        } else {
          p.x += (dx / dist) * move;
          p.y += (dy / dist) * move;
        }
      } else if (st.do === 'jump') {
        if (st.t === undefined) {
          st.t = 0;
          st.fx = p.x;
          st.fy = p.y;
          if (Math.abs(st.x - p.x) > 0.5) p.dir = Math.sign(st.x - p.x);
          if (st.desk !== undefined) p.desk = st.desk; // so it's drawn in front of that desk
        }
        st.t = Math.min(1, st.t + dt / st.dur);
        p.mode = 'jump';
        p.x = st.fx + (st.x - st.fx) * st.t;
        p.y = st.fy + (st.y - st.fy) * st.t - Math.sin(Math.PI * st.t) * st.h;
        if (st.t >= 1) {
          p.x = st.x;
          p.y = st.y;
          p.surface = st.surface;
          if (st.surface === 'floor') p.desk = -1;
          p.step = null;
        }
      } else if (st.do === 'rest') {
        if (st.left === undefined) st.left = st.secs;
        p.mode = st.mode;
        if (st.face) p.dir = st.face;
        st.left -= dt;
        if (st.left <= 0) p.step = null;
      }
    }

    // Chooses what the pet does next. It's a busy animal.
    petPlan() {
      const spot = () => this.petSpot();
      const desks = this.desks.map((id, i) => (id ? i : -1)).filter((i) => i >= 0);
      const roll = Math.random();

      if (roll < 0.3 && desks.length) {
        // Climb onto a computer and nap on it for 10 seconds
        const i = desks[Math.floor(Math.random() * desks.length)];
        const cx = this.deskCenter(i);
        const top = this.deskTop(i);
        const floorY = this.laneFeet(i) + 3;
        return [
          { do: 'walk', x: cx + 14, y: floorY, speed: 20 },
          { do: 'rest', mode: 'sit', secs: 0.5 },
          { do: 'jump', x: cx + 14, y: top, dur: 0.5, h: 10, surface: 'desk', desk: i },
          { do: 'rest', mode: 'sit', secs: 0.8 },
          { do: 'jump', x: cx - 6, y: top - 23, dur: 0.4, h: 2, surface: 'monitor', desk: i },
          { do: 'rest', mode: 'sit', secs: 1.5, face: 1 },
          { do: 'rest', mode: 'sleep', secs: 10, face: 1 },
          { do: 'rest', mode: 'sit', secs: 1.2 },
          { do: 'jump', x: cx + 14, y: top, dur: 0.4, h: 3, surface: 'desk', desk: i },
          { do: 'jump', x: cx + 20 + Math.random() * 12, y: floorY + Math.random() * 5, dur: 0.55, h: 5, surface: 'floor' },
        ];
      }
      if (roll < 0.55) {
        return [{ do: 'walk', ...spot(), speed: 20 }, { do: 'rest', mode: 'sit', secs: 0.6 + Math.random() * 1.4 }];
      }
      if (roll < 0.75) {
        // Zoomies!
        return [
          { do: 'walk', ...spot(), speed: 48 },
          { do: 'walk', ...spot(), speed: 48 },
          { do: 'walk', ...spot(), speed: 48 },
          { do: 'rest', mode: 'sit', secs: 1.2 },
        ];
      }
      if (roll < 0.92) {
        return [{ do: 'walk', ...spot(), speed: 20 }, { do: 'walk', ...spot(), speed: 20 }, { do: 'rest', mode: 'sit', secs: 1 }];
      }
      return [{ do: 'rest', mode: 'sleep', secs: 3 + Math.random() * 4 }];
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
      for (let i = 0; i < this.desks.length; i++) {
        if (!this.desks[i]) continue;
        const cx = this.deskCenter(i), top = this.deskTop(i);
        if (x >= cx - SLOT / 2 && x < cx + SLOT / 2 && y >= top - 42 && y <= top + 28) return this.desks[i];
      }
      return null;
    }

    // Everything a style needs to know to draw the room
    env(now, date) {
      return {
        W: this.width, H: this.height, WALL, FLOOR: WALL + 3, DESK_Y, LEFT, SLOT, RIGHT,
        slots: this.cols, rows: this.rows,
        hue: this.room.hue, seed: this.seed, now, date, hour: date.getHours(),
        sky: Themes.skyFor(date.getHours()),
        doorX: this.doorX(),
        deskCenter: (i) => this.deskCenter(i),
        deskTop: (i) => this.deskTop(i),
      };
    }

    // -------------------------------------------------------------------------
    // Drawing
    // -------------------------------------------------------------------------

    draw(now) {
      if (!this.room) return;
      const ctx = this.ctx;
      const date = window.roomClock ? window.roomClock() : new Date(); // demo mode can fix the time
      const { theme } = this.theme();
      const e = this.env(now, date);

      ctx.imageSmoothingEnabled = false;
      theme.back(ctx, e);
      theme.floor(ctx, e);
      const doorOpen = [...this.actors.values()].some((a) => a.goal === 'door' && a.mode === 'door');
      theme.door(ctx, e, doorOpen);
      theme.corner(ctx, e);
      theme.front(ctx, e);

      // Desks, walking robots and the pet, drawn from the back of the room to
      // the front so the nearer thing is always on top
      const items = [];
      const slots = this.rows * this.cols;
      for (let i = 0; i < slots; i++) {
        const id = this.desks[i];
        const top = this.deskTop(i);
        items.push({
          depth: top + 27,
          draw: () => (id ? this.drawDesk(ctx, i, this.sessions[id], this.actors.get(id), now, theme, e) : theme.spare(ctx, e, i, top)),
        });
      }
      for (const a of this.actors.values()) {
        if (a.mode !== 'seat') items.push({ depth: a.feet + 8, draw: () => this.drawStanding(ctx, a, this.sessions[a.id], now) });
      }
      if (this.pet) {
        const p = this.pet;
        const depth = p.desk >= 0 && this.desks[p.desk] ? this.deskTop(p.desk) + 27.5 : p.y + 8;
        items.push({
          depth,
          draw: () => (theme.pet === 'drone' ? Themes.drawDrone(ctx, p, e, theme.petLight) : Themes.drawCat(ctx, p, e)),
        });
      }
      items.sort((a, b) => a.depth - b.depth).forEach((item) => item.draw());

      // Name plates go on top, so nothing ever covers a robot's name
      for (let i = 0; i < this.desks.length; i++) {
        const id = this.desks[i];
        if (id) this.drawPlate(ctx, i, this.sessions[id], now);
      }
      Themes.vignette(ctx, e);

      // Night time: dim the room, then add the lights and glowing screens on top
      const dark = e.sky.night && theme.dim > 0;
      if (dark) rect(ctx, 0, 0, e.W, e.H, `rgba(10, 12, 40, ${theme.dim})`);
      theme.light(ctx, e);
      for (let i = 0; i < this.desks.length; i++) {
        const id = this.desks[i];
        if (id) this.drawScreen(ctx, i, this.sessions[id], now, dark || theme.dim === 0);
      }
      this.drawBulbs(ctx, now, dark);

      // Speech bubbles on top of everything
      for (let i = 0; i < this.desks.length; i++) {
        const id = this.desks[i];
        if (id) this.drawBubble(ctx, i, this.sessions[id], this.actors.get(id), now);
      }
    }

    drawDesk(ctx, i, s, actor, now, theme, e) {
      const f = theme.furniture;
      const cx = this.deskCenter(i);
      const top = this.deskTop(i);
      const mx = cx - 13, my = top - 22;
      const on = s && !(s.state === 'idle' && !s.alive);
      const light = lightFor(s, now);

      // Glow behind a screen that's on
      if (s && s.state !== 'idle') {
        const pulse = s.state === 'blocked' ? 0.08 + 0.05 * Math.sin(now / 200) : 0.1;
        ctx.globalAlpha = pulse;
        rect(ctx, mx - 6, my - 6, 38, 30, STATE_COLORS[s.state]);
        ctx.globalAlpha = pulse * 0.6;
        rect(ctx, mx - 11, my - 10, 48, 38, STATE_COLORS[s.state]);
        ctx.globalAlpha = 1;
      }

      // Monitor
      rect(ctx, mx - 1, my - 1, 28, 19, '#0e0f16');
      rect(ctx, mx, my, 26, 17, f.monitor);
      rect(ctx, mx, my, 26, 1, 'rgba(255,255,255,0.12)');
      rect(ctx, mx + 1, my + 1, 24, 15, f.bezel);
      rect(ctx, mx + 2, my + 2, 22, 13, on ? '#0b0d15' : '#08090e');
      rect(ctx, mx + 22, my + 15, 2, 1, on ? light : '#3a3e55'); // power light
      rect(ctx, cx - 2, my + 17, 4, 3, f.stand);
      rect(ctx, cx - 6, my + 20, 12, 2, f.monitor);

      // Desk
      const dx = cx - 26;
      ctx.globalAlpha = 0.25;
      rect(ctx, dx - 1, top + 20, 54, 2, '#000'); // shadow on the floor
      ctx.globalAlpha = 1;
      rect(ctx, dx - 1, top - 1, 54, 19, '#15161f');
      rect(ctx, dx, top, 52, 3, f.top);
      rect(ctx, dx, top, 52, 1, f.edge);
      rect(ctx, dx, top + 3, 52, 13, f.front);
      rect(ctx, dx + 3, top + 5, 14, 4, f.panel);
      rect(ctx, dx + 3, top + 10, 14, 4, f.panel);
      rect(ctx, dx + 9, top + 7, 2, 1, f.knob);
      rect(ctx, dx + 9, top + 12, 2, 1, f.knob);
      rect(ctx, dx + 1, top + 16, 3, 4, f.leg);
      rect(ctx, dx + 48, top + 16, 3, 4, f.leg);
      theme.extras(ctx, e, cx, s, i, top);
      if (s) this.drawHelpers(ctx, cx, top, s, now);

      // Robot in its chair (if it's at the desk)
      const seated = !actor || actor.mode === 'seat';
      const rx = cx - 7, ry = top - 1;
      if (!seated) {
        this.drawChair(ctx, cx, true, f, top);
        return;
      }
      const facingYou = s && (s.state === 'waiting' || s.state === 'blocked');
      if (facingYou) {
        this.drawChair(ctx, cx, false, f, top);
        drawRobot(ctx, this.frontPose(s, now), rx + this.shake(s, now), ry, s.hue, light);
      } else {
        drawRobot(ctx, this.backPose(s, now), rx, ry, s ? s.hue : 220, light);
        this.drawChair(ctx, cx, true, f, top);
      }
    }

    // Little helper robots on the desk while sub-agents are working
    drawHelpers(ctx, cx, top, s, now) {
      const n = (s.helpers && s.helpers.active) || 0;
      if (!n) return;
      const shown = Math.min(n, 3);
      const colors = { o: '#15161f', b: `hsl(${s.hue} 45% 72%)`, e: '#3ddc84', s: '#3ddc84' };
      for (let k = 0; k < shown; k++) {
        const x = cx - 25 + k * 6;
        const hop = Math.floor(now / 180 + k * 2) % 4 === 0 ? 1 : 0; // busy little hops
        HELPER.forEach((row, y) => {
          for (let j = 0; j < row.length; j++) {
            const c = colors[row[j]];
            if (c) rect(ctx, x + j, top - 6 + y - hop, 1, 1, c);
          }
        });
      }
      if (n > 3) text(ctx, '+' + (n - 3), cx - 25 + 18, top - 6, '#3ddc84');
    }

    // Name plate above the monitor, with a status light.
    // Drawn after everything else in the room, so nothing can cover a name.
    drawPlate(ctx, i, s, now) {
      const cx = this.deskCenter(i);
      const label = s.name;
      const tw = textWidth(label) + 9;
      const px = Math.round(cx - tw / 2), py = this.deskTop(i) - 38;
      const hot = this.selected === s.id || this.hover === s.id;
      rect(ctx, px - 1, py - 1, tw + 2, 9, hot ? '#ffffff' : '#0e0f16');
      rect(ctx, px, py, tw, 7, '#1d1f2e');
      rect(ctx, px + 2, py + 2, 2, 3, lightFor(s, now));
      text(ctx, label, px + 6, py + 1, '#d9dcef');
      if (this.selected === s.id) {
        const bob = Math.floor(now / 300) % 2;
        rect(ctx, cx - 2, py - 6 + bob, 5, 1, '#ffffff');
        rect(ctx, cx - 1, py - 5 + bob, 3, 1, '#ffffff');
        rect(ctx, cx, py - 4 + bob, 1, 1, '#ffffff');
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
    drawChair(ctx, cx, back, f, top) {
      const x = cx - 7, y = top + 15; // low enough that the robot's back light shows
      ctx.globalAlpha = 0.25;
      rect(ctx, cx - 7, y + 13, 15, 1, '#000');
      ctx.globalAlpha = 1;
      if (back) {
        rect(ctx, x, y, 15, 7, '#15161f');
        rect(ctx, x + 1, y + 1, 13, 5, f.chair);
        rect(ctx, x + 2, y + 1, 11, 1, f.chairLight);
      } else {
        rect(ctx, x + 1, y + 2, 13, 5, '#15161f');
        rect(ctx, x + 2, y + 3, 11, 3, f.chairSeat);
      }
      rect(ctx, cx - 1, y + 7, 3, 4, f.base);
      rect(ctx, cx - 6, y + 11, 13, 1, f.base);
      rect(ctx, cx - 6, y + 12, 2, 1, '#15161f');
      rect(ctx, cx, y + 12, 1, 1, '#15161f');
      rect(ctx, cx + 5, y + 12, 2, 1, '#15161f');
    }

    drawStanding(ctx, a, s, now) {
      const light = lightFor(s, now);
      const x = Math.round(a.x), y = Math.round(a.feet) - 22;
      ctx.globalAlpha = 0.3;
      rect(ctx, x + 2, Math.round(a.feet), 11, 1, '#000'); // shadow
      ctx.globalAlpha = 1;
      let pose = 'front';
      if (a.mode === 'walk') pose = Math.floor(now / 140) % 2 ? 'walkL' : 'walkR';
      else if ((now + (s ? s.hue : 0) * 20) % 3000 > 2850) pose = 'frontBlink';
      drawRobot(ctx, pose, x, y, s ? s.hue : 220, light);
    }

    // The monitor picture: code, "YOUR TURN", "ALLOW?", or dark
    drawScreen(ctx, i, s, now, glowing) {
      const cx = this.deskCenter(i);
      const sx = cx - 11, sy = this.deskTop(i) - 20, w = 22, h = 13;
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
      if (glowing && s.state !== 'idle') {
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
          by = this.deskTop(i) - 1 + (sleeping ? 1 : 0);
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
      const top = this.deskTop(i);
      const bob = Math.floor(now / 400) % 2;
      if (actor.mode !== 'seat') {
        if (actor.mode === 'door') this.bubble(ctx, Math.round(actor.x) + 11, Math.round(actor.feet) - 33 + bob, '!', '#ff4f5e');
        return;
      }
      if (s.state === 'waiting') this.bubble(ctx, cx + 8, top - 11 + bob, '?', '#e09a10');
      else if (s.state === 'blocked') this.bubble(ctx, cx + 8, top - 11 + bob, '!', '#ff4f5e');
      else if (s.stopping) this.bubble(ctx, cx + 8, top - 11 + bob, '.', '#5f6488');
      else if (s.state === 'idle' && !s.alive) {
        // Floating Zzz
        for (let k = 0; k < 3; k++) {
          const t = ((now / 1000 + k * 0.9 + s.hue) % 2.7) / 2.7;
          ctx.globalAlpha = 1 - t;
          text(ctx, 'Z', cx + 12 + Math.round(t * 6), top - 2 - Math.round(t * 14), '#c9cde6');
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
  window.RoomLayout = { BASE_H, LEFT, SLOT, RIGHT, DESK_Y };
})();
