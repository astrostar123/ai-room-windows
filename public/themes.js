// Room styles for AI Room.
//
// Each style draws the walls, floor, windows, door and decorations of a room,
// and says what colour the furniture is. room.js draws the desks, robots and
// screens on top, using the style's colours.
//
// Every style has the same parts:
//   back(ctx, e)        ceiling, walls, windows, things on the wall
//   floor(ctx, e)       floor, rugs, light patches
//   door(ctx, e, open)  the door robots walk to (open = a robot is there)
//   corner(ctx, e)      big thing in the left corner (shelf, arcade, fireplace…)
//   front(ctx, e)       small things at the front of the room
//   spare(ctx, e, i, top)          what fills a desk slot nobody is using
//   extras(ctx, e, cx, s, i, top)  small things on each desk
//   ("top" is the y of that row's desk tops: 70 for the first row, lower for the next)
//   light(ctx, e)       glowing lights, drawn after the room gets dark at night
//
// "e" holds the room's size and the time; see room.js (env()).

(function () {
  const { text, textWidth } = window.Sprites;

  // ---------------------------------------------------------------------------
  // Drawing helpers
  // ---------------------------------------------------------------------------

  function rect(ctx, x, y, w, h, color) {
    if (w <= 0 || h <= 0) return;
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  function px(ctx, x, y, color) {
    rect(ctx, x, y, 1, 1, color);
  }

  // Draw something see-through
  function faint(ctx, alpha, draw) {
    const old = ctx.globalAlpha;
    ctx.globalAlpha = old * alpha;
    draw();
    ctx.globalAlpha = old;
  }

  // Soft glow around a rectangle (three fading layers)
  function glow(ctx, x, y, w, h, color, strength) {
    faint(ctx, strength * 0.45, () => rect(ctx, x - 1, y - 1, w + 2, h + 2, color));
    faint(ctx, strength * 0.2, () => rect(ctx, x - 3, y - 3, w + 6, h + 6, color));
    faint(ctx, strength * 0.1, () => rect(ctx, x - 6, y - 6, w + 12, h + 12, color));
  }

  // Filled circle / oval, one row at a time. Measuring to the middle of each
  // pixel row (the +0.5) keeps the top and bottom rows from being 1 pixel wide.
  function circle(ctx, cx, cy, r, color) {
    ellipse(ctx, cx, cy, r, r, color);
  }

  function ellipse(ctx, cx, cy, rx, ry, color) {
    for (let y = -ry; y <= ry; y++) {
      const t = y / (ry + 0.5);
      const half = Math.round((rx + 0.5) * Math.sqrt(Math.max(0, 1 - t * t)) - 0.5);
      rect(ctx, cx - half, cy + y, half * 2 + 1, 1, color);
    }
  }

  // Seeded random numbers: the same room always gets the same furniture
  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  // Floor rows get taller towards you, which makes the floor look deep
  function floorRows(top, bottom) {
    const rows = [];
    for (let y = top, h = 4; y < bottom; y += h, h++) rows.push({ y, h: Math.min(h, bottom - y) });
    return rows;
  }

  // Lines on the floor spread out towards you (perspective)
  function spread(e, x, y) {
    const t = (y - e.FLOOR) / (e.H - e.FLOOR);
    const mid = e.W / 2;
    return Math.round(mid + (x - mid) * (0.84 + 0.32 * t));
  }

  // The x positions between desks (windows and pictures go here)
  function gaps(e) {
    const out = [];
    for (let i = 0; i < e.slots; i++) out.push(e.LEFT + e.SLOT * (i + 1));
    return out;
  }

  // Sky colours through the window, by time of day
  function skyFor(hour) {
    if (hour >= 20 || hour < 6) return { top: '#0a0f2c', mid: '#121a44', bottom: '#1d285c', night: true };
    if (hour < 8) return { top: '#5d4f9e', mid: '#c27a9e', bottom: '#f5a36a', night: false };
    if (hour < 17) return { top: '#4f9fe0', mid: '#79bdf0', bottom: '#b3e0fa', night: false };
    return { top: '#43306b', mid: '#a04f7a', bottom: '#ef8a5c', night: false };
  }

  // Three bands of colour with a checkerboard where they meet
  function bands(ctx, x, y, w, h, colors) {
    const n = colors.length;
    const bh = h / n;
    colors.forEach((c, i) => rect(ctx, x, y + Math.floor(i * bh), w, Math.ceil(bh), c));
    for (let i = 1; i < n; i++) {
      const by = y + Math.floor(i * bh);
      for (let k = 0; k < w; k += 2) px(ctx, x + k + (i % 2), by, colors[i - 1]);
    }
  }

  function stars(ctx, x, y, w, h, seed, now, count) {
    const r = rng(seed);
    for (let k = 0; k < count; k++) {
      const sx = x + Math.floor(r() * w), sy = y + Math.floor(r() * h);
      const twinkle = Math.sin(now / 650 + k * 1.9);
      if (twinkle > -0.4) px(ctx, sx, sy, twinkle > 0.75 ? '#ffffff' : '#aeb6d8');
    }
  }

  function signBoard(ctx, cx, y, label, bg, fg, rim) {
    const w = textWidth(label) + 6;
    const x = Math.round(cx - w / 2);
    rect(ctx, x - 1, y - 1, w + 2, 9, rim);
    rect(ctx, x, y, w, 7, bg);
    text(ctx, label, x + 3, y + 1, fg);
  }

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

  function clock(ctx, cx, cy, date, face, rim, hand) {
    const R = 5;
    for (let y = -R - 1; y <= R + 1; y++) {
      for (let x = -R - 1; x <= R + 1; x++) {
        const d = Math.hypot(x, y);
        if (d <= R + 1.2) px(ctx, cx + x, cy + y, d > R ? rim : face);
      }
    }
    const m = date.getMinutes(), h = (date.getHours() % 12) + m / 60;
    const ma = (m / 60) * Math.PI * 2, ha = (h / 12) * Math.PI * 2;
    line(ctx, cx, cy, cx + Math.round(Math.sin(ma) * 4), cy - Math.round(Math.cos(ma) * 4), hand);
    line(ctx, cx, cy, cx + Math.round(Math.sin(ha) * 2.6), cy - Math.round(Math.cos(ha) * 2.6), '#c0392b');
  }

  // Draws a little sprite from strings (used for the cat)
  function sprite(ctx, rows, x, y, colors, flip) {
    const w = rows[0].length;
    rows.forEach((row, j) => {
      for (let i = 0; i < w; i++) {
        const c = colors[row[flip ? w - 1 - i : i]];
        if (c) px(ctx, x + i, y + j, c);
      }
    });
  }

  // Dark edges make the room feel like a box you're looking into
  function vignette(ctx, e) {
    faint(ctx, 0.28, () => { rect(ctx, 0, 0, 2, e.H, '#000'); rect(ctx, e.W - 2, 0, 2, e.H, '#000'); });
    faint(ctx, 0.14, () => { rect(ctx, 2, 0, 3, e.H, '#000'); rect(ctx, e.W - 5, 0, 3, e.H, '#000'); });
    faint(ctx, 0.07, () => { rect(ctx, 5, 0, 5, e.H, '#000'); rect(ctx, e.W - 10, 0, 5, e.H, '#000'); });
    faint(ctx, 0.18, () => rect(ctx, 0, e.H - 2, e.W, 2, '#000'));
  }

  // ---------------------------------------------------------------------------
  // Pets
  // ---------------------------------------------------------------------------

  // The cat (12 x 7 pixels, facing right). c = fur, e = eye, p = nose, d = closed eye
  const CAT = {
    walkA: ['.........c.c', '.........ccc', 'c.......ccec', '.c......cccp', '.cccccccccc.', '.cccccccccc.', '.c.c....c.c.'],
    walkB: ['.........c.c', '.........ccc', 'c.......ccec', '.c......cccp', '.cccccccccc.', '.cccccccccc.', '..c.c..c.c..'],
    sit: ['.......c.c..', '.......ccc..', '.......cec..', '.....ccccc..', 'c...cccccc..', 'cc.ccccccc..', '.ccccccccc..'],
    sitFlick: ['.......c.c..', '.......ccc..', 'c......cec..', 'c....ccccc..', '.c..cccccc..', '..cccccccc..', '..cccccccc..'],
    jump: ['............', '.........c.c', 'c........ccc', '.c......ccec', '..cccccccccp', '.cc.cccc.cc.', 'c..........c'],
    sleep: ['............', '............', '............', '...cccccc...', '..cccccccc..', '.cccccccdcc.', 'cccccccccccc'],
  };
  const CAT_COLORS = ['#e0913a', '#8d92a3', '#2d2d36', '#eee4d4'];

  function drawCat(ctx, pet, e) {
    const body = CAT_COLORS[e.seed % CAT_COLORS.length];
    const colors = { c: body, d: '#15161f', e: '#f3e36b', p: '#ff9aa8' };
    let frame = Math.floor(e.now / 300) % 4 === 0 ? CAT.sitFlick : CAT.sit; // flicks its tail
    let bob = 0;
    if (pet.mode === 'walk') frame = Math.floor(e.now / 170) % 2 ? CAT.walkA : CAT.walkB;
    if (pet.mode === 'run') {
      frame = Math.floor(e.now / 80) % 2 ? CAT.walkA : CAT.walkB;
      bob = Math.floor(e.now / 80) % 2;
    }
    if (pet.mode === 'jump') frame = CAT.jump;
    if (pet.mode === 'sleep') frame = CAT.sleep;
    const x = Math.round(pet.x), y = Math.round(pet.y) - 7 - bob;
    if (pet.mode !== 'jump') faint(ctx, 0.3, () => rect(ctx, x + 1, Math.round(pet.y), 10, 1, '#000'));
    sprite(ctx, frame, x, y, colors, pet.dir < 0);
    if (pet.mode === 'sleep') {
      // A small Z that drifts sideways (name plates are drawn over it anyway)
      const t = ((e.now / 1000) % 2.4) / 2.4;
      const zx = pet.dir < 0 ? x - 5 - Math.round(t * 5) : x + 12 + Math.round(t * 5);
      faint(ctx, 1 - t, () => text(ctx, 'Z', zx, y + 1 - Math.round(t * 5), '#c9cde6'));
    }
  }

  function drawDrone(ctx, pet, e, light) {
    const x = Math.round(pet.x), ground = Math.round(pet.y);
    // Hovers over the floor; lands to "charge" when it rests or sits on a desk
    const landed = pet.mode === 'sleep' || (pet.mode === 'sit' && pet.surface !== 'floor');
    const hover = landed ? 0 : pet.surface === 'floor' && pet.mode !== 'jump' ? 14 : 3;
    const y = ground - 6 - hover + (landed ? 0 : Math.round(Math.sin(e.now / 320) * 1.5));
    if (pet.mode !== 'jump') faint(ctx, 0.25, () => rect(ctx, x + 3, ground, 7, 1, '#000'));
    const spin = landed ? 1 : Math.floor(e.now / 50) % 2;
    rect(ctx, x + (spin ? 0 : 1), y, spin ? 4 : 2, 1, '#aab3c5');
    rect(ctx, x + 9 + (spin ? 0 : 1), y, spin ? 4 : 2, 1, '#aab3c5');
    px(ctx, x + 2, y + 1, '#555a6b');
    px(ctx, x + 10, y + 1, '#555a6b');
    rect(ctx, x + 1, y + 2, 11, 4, '#15161f');
    rect(ctx, x + 2, y + 2, 9, 3, '#c9d0dd');
    rect(ctx, x + 2, y + 4, 9, 1, '#8e97aa');
    const color = pet.mode === 'sleep' ? '#3ddc84' : light; // green = charging
    const on = pet.mode === 'sleep' ? Math.floor(e.now / 900) % 2 === 0 : Math.floor(e.now / 400) % 3 !== 0;
    px(ctx, x + 6, y + 3, on ? color : '#555a6b');
    if (on) faint(ctx, 0.25, () => rect(ctx, x + 4, y + 1, 5, 5, color));
  }

  // ---------------------------------------------------------------------------
  // Pieces shared by several styles
  // ---------------------------------------------------------------------------

  function bookshelf(ctx, e) {
    const x = 4, y = 28, w = 24, h = e.WALL - 28;
    rect(ctx, x - 1, y - 1, w + 2, h + 1, '#15161f');
    rect(ctx, x, y, w, h, '#5a3f2b');
    rect(ctx, x, y, w, 1, '#6d4d35');
    const r = rng(e.seed * 7);
    for (let s = 0; s < 3; s++) {
      const sy = y + 3 + s * 13;
      rect(ctx, x + 1, sy, w - 2, 10, '#3a281c');
      let bx = x + 2;
      while (bx < x + w - 4) {
        const bw = 2 + Math.floor(r() * 2), bh = 6 + Math.floor(r() * 4);
        const c = `hsl(${Math.floor(r() * 360)} 42% ${40 + Math.floor(r() * 18)}%)`;
        if (r() < 0.12 && bx < x + w - 7) {
          rect(ctx, bx, sy + 10 - 3, 5, 3, c); // a book lying flat
          bx += 6;
          continue;
        }
        rect(ctx, bx, sy + 10 - bh, bw, bh, c);
        px(ctx, bx, sy + 10 - bh + 2, 'rgba(255,255,255,0.35)');
        bx += bw + (r() < 0.2 ? 1 : 0);
      }
      rect(ctx, x, sy + 10, w, 2, '#6d4d35');
    }
  }

  function plant(ctx, x, y, leaf, leafLight, pot, potLight) {
    rect(ctx, x, y, 14, 12, '#15161f');
    rect(ctx, x + 1, y + 1, 12, 10, pot);
    rect(ctx, x + 1, y + 1, 12, 2, potLight);
    rect(ctx, x + 2, y + 10, 10, 1, 'rgba(0,0,0,0.25)');
    const leaves = [[7, -15], [3, -11], [11, -12], [5, -7], [9, -6], [1, -5], [13, -7], [7, -9]];
    for (const [lx, ly] of leaves) {
      rect(ctx, x + lx - 1, y + ly, 3, 5, leaf);
      rect(ctx, x + lx, y + ly + 1, 1, 3, leafLight);
    }
  }

  // "top" is where the desk top would be in that slot's row (70 in the first row)
  function waterCooler(ctx, e, i, top) {
    const cx = e.deskCenter(i);
    const o = top - 70;
    faint(ctx, 0.25, () => rect(ctx, cx - 7, 94 + o, 15, 2, '#000'));
    rect(ctx, cx - 6, 62 + o, 12, 33, '#15161f');
    rect(ctx, cx - 5, 76 + o, 10, 18, '#d7dbe6');
    rect(ctx, cx - 5, 76 + o, 2, 18, '#eef1f7');
    rect(ctx, cx - 4, 63 + o, 8, 12, '#7cc3ee');
    rect(ctx, cx - 3, 65 + o, 2, 8, '#b4e1fb');
    const bubble = Math.floor(e.now / 700) % 6;
    px(ctx, cx + 1, 73 + o - bubble, '#dff3ff');
    rect(ctx, cx - 1, 80 + o, 3, 2, '#3a3e55');
  }

  // Server rack with blinking lights (neon + space)
  function serverRack(ctx, e, i, top, body, edge) {
    const cx = e.deskCenter(i);
    const x = cx - 10, y = top - 30, w = 20, h = 55;
    faint(ctx, 0.3, () => rect(ctx, x - 1, y + h, w + 2, 2, '#000'));
    rect(ctx, x - 1, y - 1, w + 2, h + 1, '#07080d');
    rect(ctx, x, y, w, h, body);
    rect(ctx, x, y, w, 1, edge);
    const r = rng(e.seed + i * 13);
    for (let u = 0; u < 8; u++) {
      const uy = y + 3 + u * 6;
      rect(ctx, x + 2, uy, w - 4, 4, '#0c0d14');
      for (let k = 0; k < 4; k++) {
        const on = Math.sin(e.now / (120 + k * 40) + u * 3 + r() * 6) > 0.1;
        px(ctx, x + 4 + k * 3, uy + 1, on ? ['#3ddc84', '#4fc3ff', '#ffb627', '#3ddc84'][k] : '#23252f');
      }
      rect(ctx, x + w - 7, uy + 2, 4, 1, '#2a2d3a');
    }
  }

  // ---------------------------------------------------------------------------
  // COZY OFFICE
  // ---------------------------------------------------------------------------

  const office = {
    label: 'Cozy office',
    dim: 0.36,
    pet: 'cat',
    furniture: {
      top: '#9c7650', edge: '#b89066', front: '#7d5b3d', panel: '#6d4f34', knob: '#caa46a', leg: '#5a4029',
      chair: '#3b3350', chairLight: '#4d4468', chairSeat: '#2a2439', base: '#2a2d42',
      monitor: '#2a2d42', bezel: '#1c1e2d', stand: '#3a3e55',
    },

    back(ctx, e) {
      const h = e.hue;
      rect(ctx, 0, 0, e.W, 5, `hsl(${h} 14% 14%)`);
      rect(ctx, 0, 5, e.W, 1, `hsl(${h} 14% 26%)`);
      // Wallpaper with little dots
      rect(ctx, 0, 6, e.W, 43, `hsl(${h} 22% 30%)`);
      for (let x = 2; x < e.W; x += 8) rect(ctx, x, 6, 3, 43, `hsl(${h} 22% 32%)`);
      for (let y = 10, n = 0; y < 47; y += 7, n++) {
        for (let x = 6 + (n % 2) * 4; x < e.W; x += 8) px(ctx, x, y, `hsl(${h} 26% 37%)`);
      }
      faint(ctx, 0.35, () => rect(ctx, 0, 6, e.W, 2, '#000')); // shadow under the ceiling
      // Wooden panelling on the lower wall
      rect(ctx, 0, 49, e.W, 2, '#7a5538');
      rect(ctx, 0, 49, e.W, 1, '#9a6e4c');
      rect(ctx, 0, 51, e.W, e.WALL - 51, '#5b3d2b');
      for (let x = 3; x < e.W - 10; x += 16) {
        rect(ctx, x, 54, 12, e.WALL - 58, '#503627');
        rect(ctx, x, 54, 12, 1, '#3f2a1d');
        rect(ctx, x, 54, 1, e.WALL - 58, '#3f2a1d');
        rect(ctx, x, e.WALL - 5, 12, 1, '#6d4a34');
      }
      rect(ctx, 0, e.WALL, e.W, 3, '#3a2619');
      rect(ctx, 0, e.WALL, e.W, 1, '#7a5538');

      gaps(e).forEach((gx, i) => (i % 2 === 0 ? officeWindow(ctx, e, gx, i) : painting(ctx, e, gx, i)));
      for (let i = 0; i < e.slots; i++) pendant(ctx, e.deskCenter(i), '#c9a24a', '#8a6a2a');
      clock(ctx, e.W - e.RIGHT + 27, 15, e.date, '#ece6d4', '#15161f', '#2b2d3c');
    },

    floor(ctx, e) {
      const rows = floorRows(e.FLOOR, e.H);
      rows.forEach((r, n) => {
        rect(ctx, 0, r.y, e.W, r.h, n % 2 ? '#654635' : '#6d4c39');
        rect(ctx, 0, r.y + r.h - 1, e.W, 1, '#4b3226');
        rect(ctx, 0, r.y, e.W, 1, n % 2 ? '#6f4d3b' : '#77533f');
        const step = 42, offset = (n * 19) % step;
        for (let x = offset - step; x < e.W + step; x += step) rect(ctx, spread(e, x, r.y + r.h / 2), r.y, 1, r.h - 1, '#503526');
      });
      // Sunlight from the windows
      if (!e.sky.night) {
        gaps(e).forEach((gx, i) => {
          if (i % 2) return;
          faint(ctx, 0.1, () => {
            for (let y = e.FLOOR + 1; y < e.FLOOR + 18; y++) rect(ctx, gx - 12 + (y - e.FLOOR) * 0.7, y, 24, 1, '#fff0c2');
          });
        });
      }
      // Rug (at the front of the room)
      const h = (e.hue + 180) % 360;
      const top = e.H - 33, bottom = e.H - 5, x0 = e.LEFT + 4, x1 = e.doorX - 8;
      for (let y = top; y < bottom; y++) {
        const inset = Math.round((bottom - y) * 0.28);
        const edge = y < top + 2 || y > bottom - 3;
        rect(ctx, x0 + inset, y, x1 - x0 - inset * 2, 1, edge ? `hsl(${h} 28% 24%)` : `hsl(${h} 30% 36%)`);
        if (!edge) {
          rect(ctx, x0 + inset, y, 2, 1, `hsl(${h} 28% 24%)`);
          rect(ctx, x1 - inset - 2, y, 2, 1, `hsl(${h} 28% 24%)`);
          if (y === top + 4 || y === bottom - 6) {
            for (let k = x0 + inset + 5; k < x1 - inset - 5; k += 2) px(ctx, k, y, '#d8b26a');
          } else if (y > top + 4 && y < bottom - 6) {
            px(ctx, x0 + inset + 5, y, '#d8b26a');
            px(ctx, x1 - inset - 6, y, '#d8b26a');
          }
        }
      }
      for (let k = x0 + 2; k < x1 - 2; k += 3) px(ctx, k, bottom, `hsl(${h} 20% 60%)`); // tassels
      faint(ctx, 0.3, () => rect(ctx, 0, e.FLOOR, e.W, 2, '#000'));
    },

    door(ctx, e, open) {
      const x = e.doorX, y = 34, w = 22, h = e.WALL - 34 + 1;
      signBoard(ctx, x + w / 2, y - 10, 'EXIT', '#1f9a57', '#e9fff1', '#15161f');
      rect(ctx, x - 3, y - 3, w + 6, h + 3, '#e9e1cf');
      rect(ctx, x - 2, y - 2, w + 4, h + 2, '#2a1f2c');
      if (open) {
        bands(ctx, x, y, w, h, [e.sky.top, e.sky.bottom]);
        rect(ctx, x, y + h - 6, w, 6, e.sky.night ? '#16241c' : '#5d9a55');
        rect(ctx, x, y, 12, h, '#7a5238');
        rect(ctx, x + 2, y + 3, 8, 12, '#6a4530');
        rect(ctx, x + 2, y + 19, 8, 14, '#6a4530');
        faint(ctx, 0.2, () => { for (let k = 0; k < 14; k++) rect(ctx, x + 12 + k * 0.5, e.FLOOR + k, 12, 1, e.sky.night ? '#8ea6ff' : '#fff0c2'); });
      } else {
        rect(ctx, x, y, w, h, '#7a5238');
        rect(ctx, x, y, w, 1, '#94694a');
        rect(ctx, x + 3, y + 3, w - 6, 12, '#6a4530');
        rect(ctx, x + 3, y + 19, w - 6, 14, '#6a4530');
        rect(ctx, x + w - 5, y + 18, 2, 2, '#e8c14a');
      }
      rect(ctx, x - 1, e.FLOOR + 1, w + 2, 3, '#7a2e2e'); // doormat
      rect(ctx, x - 1, e.FLOOR + 1, w + 2, 1, '#8f3a3a');
    },

    corner(ctx, e) {
      bookshelf(ctx, e);
    },

    front(ctx, e) {
      plant(ctx, 6, e.H - 22, '#2f7a45', '#49a862', '#b5653f', '#cc7a52');
    },

    spare: waterCooler,

    extras(ctx, e, cx, s, i, top) {
      const r = rng(e.seed + i * 31);
      if (r() < 0.8) mug(ctx, cx + 16, top, ['#e0e0e0', '#d65b5b', '#5b8fd6', '#e8c14a'][Math.floor(r() * 4)], s, e);
      if (r() < 0.6 && !(s && s.helpers && s.helpers.active)) papers(ctx, cx - 23, top);
    },

    light(ctx, e) {
      if (!e.sky.night) return;
      for (let i = 0; i < e.slots; i++) lampCone(ctx, e.deskCenter(i), 13, e.DESK_Y, '#ffe3a0', 0.07);
    },
  };

  function officeWindow(ctx, e, gx, i) {
    const x = gx - 14, y = 11, w = 28, h = 19;
    const curtain = `hsl(${(e.hue + 180) % 360} 34% 44%)`, fold = `hsl(${(e.hue + 180) % 360} 34% 34%)`;
    rect(ctx, x - 1, y - 1, w + 2, h + 2, '#1b1622');
    rect(ctx, x, y, w, h, '#e9e1cf');
    bands(ctx, x + 2, y + 2, w - 4, h - 4, [e.sky.top, e.sky.mid, e.sky.bottom]);
    if (e.sky.night) {
      stars(ctx, x + 2, y + 2, w - 4, 8, e.seed + i, e.now, 6);
      rect(ctx, x + w - 9, y + 4, 3, 3, '#f1ecc4');
    } else {
      const cx = x + 2 + ((e.now / 1000) * 1.2 + (e.seed % 40) + i * 13) % (w + 6) - 6;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 2, y + 2, w - 4, h - 4);
      ctx.clip();
      rect(ctx, cx, y + 5, 7, 2, 'rgba(255,255,255,0.9)');
      rect(ctx, cx + 2, y + 4, 3, 1, 'rgba(255,255,255,0.9)');
      ctx.restore();
    }
    // Trees on a hill outside
    const r = rng(e.seed + i * 5);
    const tree = e.sky.night ? '#0d1628' : '#3f7a4a';
    const far = e.sky.night ? '#131d38' : '#6fa37a';
    rect(ctx, x + 2, y + h - 5, w - 4, 3, far);
    for (let k = x + 2; k < x + w - 2; k += 3) rect(ctx, k, y + h - 5 - Math.floor(r() * 3), 3, 3 + Math.floor(r() * 2), tree);
    rect(ctx, x + w / 2 - 1, y, 2, h, '#e9e1cf');
    rect(ctx, x, y + Math.floor(h / 2) - 1, w, 2, '#e9e1cf');
    rect(ctx, x - 3, y + h, w + 6, 2, '#c9bfa9');
    // Curtains and rod
    rect(ctx, x - 7, y - 3, w + 14, 1, '#c9a24a');
    for (const cxs of [x - 6, x + w + 1]) {
      rect(ctx, cxs, y - 2, 5, h + 5, curtain);
      rect(ctx, cxs + 1, y - 2, 1, h + 5, fold);
      rect(ctx, cxs + 3, y - 2, 1, h + 5, fold);
    }
  }

  function painting(ctx, e, gx, i) {
    const r = rng(e.seed * 3 + i);
    const x = gx - 10, y = 12, w = 20, h = 15;
    rect(ctx, x - 1, y - 1, w + 2, h + 2, '#15161f');
    rect(ctx, x, y, w, h, '#c9a24a');
    rect(ctx, x + 1, y + 1, w - 2, h - 2, '#a88338');
    const skyC = `hsl(${190 + Math.floor(r() * 40)} 50% 70%)`;
    rect(ctx, x + 2, y + 2, w - 4, h - 4, skyC);
    rect(ctx, x + 2, y + 8, w - 4, 5, `hsl(${90 + Math.floor(r() * 50)} 35% 45%)`);
    ellipse(ctx, x + 7, y + 9, 5, 2, `hsl(${90 + Math.floor(r() * 50)} 35% 38%)`);
    circle(ctx, x + 14, y + 5, 1, '#fff1a8');
  }

  function pendant(ctx, cx, shade, shadeDark) {
    rect(ctx, cx, 5, 1, 6, '#15161f');
    rect(ctx, cx - 3, 11, 7, 3, shade);
    rect(ctx, cx - 4, 13, 9, 1, shadeDark);
    rect(ctx, cx - 1, 14, 3, 1, '#fff3c4');
  }

  function lampCone(ctx, cx, top, bottom, color, strength) {
    faint(ctx, strength, () => {
      for (let y = top; y < bottom; y++) {
        const half = 3 + (y - top) * 0.33;
        rect(ctx, cx - half, y, half * 2 + 1, 1, color);
      }
    });
    faint(ctx, 0.9, () => rect(ctx, cx - 1, top, 3, 1, '#fff7d6'));
  }

  function mug(ctx, x, deskY, color, s, e) {
    rect(ctx, x, deskY - 5, 5, 5, '#15161f');
    rect(ctx, x + 1, deskY - 4, 3, 4, color);
    rect(ctx, x + 5, deskY - 3, 1, 2, '#15161f');
    if (s && s.state === 'working') {
      const t = Math.floor(e.now / 250) % 3;
      faint(ctx, 0.6, () => px(ctx, x + 2 + (t === 1 ? 1 : 0), deskY - 7 - t, '#ffffff'));
    }
  }

  function papers(ctx, x, deskY) {
    rect(ctx, x, deskY - 2, 8, 2, '#15161f');
    rect(ctx, x + 1, deskY - 2, 6, 1, '#f1efe6');
    rect(ctx, x, deskY - 1, 8, 1, '#dcd8c8');
  }

  // ---------------------------------------------------------------------------
  // NEON CITY
  // ---------------------------------------------------------------------------

  const NEON = ['#ff3fd0', '#2ef2ff', '#ffe95c', '#7cff6b'];
  const NEON_WORDS = ['CODE', 'BYTE', '24/7', 'RAMEN', 'HACK', 'BOTS', 'LOFI', '404', 'OPEN'];

  // Neon lights sometimes stutter
  function flicker(e, k) {
    return Math.sin(e.now / 97 + k * 7.3) * Math.sin(e.now / 1730 + k) > 0.93;
  }

  const neon = {
    label: 'Neon city',
    dim: 0,
    pet: 'drone',
    petLight: '#ff3fd0',
    furniture: {
      top: '#26222f', edge: '#2ef2ff', front: '#1b1824', panel: '#16131f', knob: '#ff3fd0', leg: '#0f0d17',
      chair: '#b3243e', chairLight: '#df3c58', chairSeat: '#7a1a2c', base: '#1c1a28',
      monitor: '#161424', bezel: '#0c0a16', stand: '#2b2838',
    },

    back(ctx, e) {
      rect(ctx, 0, 0, e.W, 5, '#08060f');
      rect(ctx, 0, 5, e.W, e.WALL - 5, '#150f26');
      for (let x = 0; x < e.W; x += 16) {
        rect(ctx, x, 5, 1, e.WALL - 5, '#0d091a');
        rect(ctx, x + 1, 5, 1, e.WALL - 5, '#1d1536');
      }
      rect(ctx, 0, 51, e.W, e.WALL - 51, '#110c1f');
      for (let x = 4; x < e.W; x += 16) for (let y = 56; y < e.WALL - 3; y += 3) rect(ctx, x, y, 8, 1, '#0b0816'); // vents
      rect(ctx, 0, e.WALL, e.W, 3, '#08060f');
      gaps(e).forEach((gx, i) => (i % 2 === 0 ? cityWindow(ctx, e, gx, i) : null));
      // Neon strips along the ceiling and the middle of the wall
      neonLine(ctx, e, 0, 6, e.W, NEON[0], 1);
      neonLine(ctx, e, 0, 50, e.W, NEON[1], 2);
      gaps(e).forEach((gx, i) => (i % 2 === 1 ? neonSign(ctx, e, gx, i) : null));
      clock(ctx, e.W - e.RIGHT + 27, 15, e.date, '#1a1430', '#2ef2ff', '#2ef2ff');
    },

    floor(ctx, e) {
      rect(ctx, 0, e.FLOOR, e.W, e.H - e.FLOOR, '#0e0a1a');
      const rows = floorRows(e.FLOOR, e.H);
      rows.forEach((r, n) => {
        rect(ctx, 0, r.y, e.W, r.h, n % 2 ? '#110c1f' : '#140e24');
        faint(ctx, 0.35, () => rect(ctx, 0, r.y, e.W, 1, '#2ef2ff'));
        for (let x = -64; x < e.W + 64; x += 18) faint(ctx, 0.22, () => rect(ctx, spread(e, x, r.y + r.h / 2), r.y, 1, r.h, '#2ef2ff'));
      });
      // Reflections of the neon on the shiny floor
      gaps(e).forEach((gx, i) => {
        const c = i % 2 ? NEON[(e.seed + i) % NEON.length] : '#7a3cff';
        faint(ctx, 0.14, () => rect(ctx, gx - 12, e.FLOOR + 2, 24, 3, c));
        faint(ctx, 0.07, () => rect(ctx, gx - 8, e.FLOOR + 6, 16, 5, c));
      });
      faint(ctx, 0.12, () => rect(ctx, 0, e.FLOOR + 1, e.W, 2, NEON[0]));
      faint(ctx, 0.4, () => rect(ctx, 0, e.FLOOR, e.W, 1, '#000'));
    },

    door(ctx, e, open) {
      const x = e.doorX, y = 34, w = 22, h = e.WALL - 34 + 1;
      const on = !flicker(e, 99);
      if (on) glow(ctx, x + 3, y - 10, 16, 7, '#ff3355', 0.9);
      signBoard(ctx, x + w / 2, y - 10, 'EXIT', '#12060c', on ? '#ff5577' : '#5a2030', '#07080d');
      rect(ctx, x - 2, y - 2, w + 4, h + 2, '#07060d');
      if (open) {
        rect(ctx, x, y, w, h, '#5ff2ff');
        glow(ctx, x + 4, y, w - 8, h, '#5ff2ff', 0.7);
        rect(ctx, x, y, 4, h, '#2b2540');
        rect(ctx, x + w - 4, y, 4, h, '#2b2540');
        faint(ctx, 0.2, () => { for (let k = 0; k < 14; k++) rect(ctx, x + 2, e.FLOOR + k, w - 4, 1, '#5ff2ff'); });
      } else {
        rect(ctx, x, y, w, h, '#2b2540');
        rect(ctx, x + w / 2 - 1, y, 2, h, '#1a1530');
        for (let k = y + 4; k < y + h; k += 6) {
          rect(ctx, x + 2, k, w / 2 - 4, 1, '#342d4c');
          rect(ctx, x + w / 2 + 2, k, w / 2 - 4, 1, '#342d4c');
        }
      }
      rect(ctx, x + w + 3, y + 16, 3, 5, '#15121f');
      px(ctx, x + w + 4, y + 17, open ? '#3ddc84' : '#ff3355');
    },

    corner(ctx, e) {
      // Arcade machine with a tiny game of pong
      const x = 4, y = 24, w = 24;
      faint(ctx, 0.25, () => glow(ctx, x, e.FLOOR, w, 10, '#ff3fd0', 0.6));
      rect(ctx, x - 1, y - 1, w + 2, e.WALL - y + 1, '#07060d');
      rect(ctx, x, y, w, e.WALL - y, '#2a1d4a');
      rect(ctx, x, y, 3, e.WALL - y, '#1f1538');
      rect(ctx, x + 2, y + 1, w - 4, 6, flicker(e, 5) ? '#6a5a20' : '#ffe95c');
      text(ctx, 'PONG', x + 5, y + 2, '#2a1d4a');
      rect(ctx, x + 3, y + 9, w - 6, 14, '#07060d');
      const sx = x + 4, sy = y + 10, sw = w - 8, sh = 12;
      rect(ctx, sx, sy, sw, sh, '#0b1a12');
      const t = e.now / 1000;
      const bx = sx + Math.floor(Math.abs(((t * 9) % ((sw - 1) * 2)) - (sw - 1)));
      const by = sy + Math.floor(Math.abs(((t * 6) % ((sh - 1) * 2)) - (sh - 1)));
      px(ctx, bx, by, '#e6fff0');
      rect(ctx, sx, Math.min(sy + sh - 4, Math.max(sy, by - 1)), 1, 4, '#7cff6b');
      rect(ctx, sx + sw - 1, Math.min(sy + sh - 4, Math.max(sy, by - 2)), 1, 4, '#7cff6b');
      rect(ctx, x + 2, y + 25, w - 4, 5, '#3a2a64');
      rect(ctx, x + 6, y + 23, 1, 3, '#15161f');
      rect(ctx, x + 5, y + 22, 3, 2, '#ff3355');
      px(ctx, x + 13, y + 27, '#2ef2ff');
      px(ctx, x + 16, y + 27, '#ffe95c');
      rect(ctx, x + 9, y + 36, 5, 3, '#15161f');
      px(ctx, x + 11, y + 37, '#ff3355');
    },

    front(ctx, e) {
      // A glowing cactus
      const x = 8, y = e.H - 20;
      rect(ctx, x, y, 11, 9, '#07060d');
      rect(ctx, x + 1, y + 1, 9, 7, '#2b2540');
      rect(ctx, x + 4, y - 11, 3, 12, '#7cff6b');
      rect(ctx, x + 1, y - 7, 2, 4, '#7cff6b');
      rect(ctx, x + 1, y - 4, 4, 2, '#7cff6b');
      rect(ctx, x + 8, y - 9, 2, 5, '#7cff6b');
      rect(ctx, x + 6, y - 5, 4, 2, '#7cff6b');
      faint(ctx, 0.2, () => rect(ctx, x - 2, y - 13, 15, 16, '#7cff6b'));
    },

    spare(ctx, e, i, top) {
      serverRack(ctx, e, i, top, '#1c1830', '#2ef2ff');
    },

    extras(ctx, e, cx, s, i, top) {
      // Energy drink and an RGB light strip under the desk
      const x = cx + 17;
      rect(ctx, x, top - 6, 4, 6, '#07060d');
      rect(ctx, x + 1, top - 5, 2, 5, ['#2ef2ff', '#ff3fd0', '#7cff6b'][i % 3]);
      rect(ctx, cx - 25, top + 15, 50, 1, `hsl(${(e.now / 12 + i * 90) % 360} 100% 62%)`);
      faint(ctx, 0.2, () => rect(ctx, cx - 25, top + 16, 50, 3, `hsl(${(e.now / 12 + i * 90) % 360} 100% 62%)`));
    },

    light() {},
  };

  function neonLine(ctx, e, x, y, w, color, k) {
    if (flicker(e, k)) return rect(ctx, x, y, w, 1, '#3a2a4a');
    faint(ctx, 0.18, () => rect(ctx, x, y - 2, w, 5, color));
    faint(ctx, 0.35, () => rect(ctx, x, y - 1, w, 3, color));
    rect(ctx, x, y, w, 1, '#ffffff');
    faint(ctx, 0.6, () => rect(ctx, x, y, w, 1, color));
  }

  function neonSign(ctx, e, gx, i) {
    const word = NEON_WORDS[(e.seed + i * 3) % NEON_WORDS.length];
    const color = NEON[(e.seed + i) % NEON.length];
    const w = textWidth(word);
    const x = Math.round(gx - w / 2), y = 18;
    if (flicker(e, i + 10)) {
      text(ctx, word, x, y, '#3a2a4a');
      return;
    }
    glow(ctx, x, y, w, 5, color, 0.6);
    text(ctx, word, x, y, color);
    faint(ctx, 0.45, () => text(ctx, word, x, y, '#ffffff')); // hot white core
  }

  function cityWindow(ctx, e, gx, i) {
    const x = gx - 16, y = 10, w = 32, h = 24;
    rect(ctx, x - 2, y - 2, w + 4, h + 4, '#07060d');
    rect(ctx, x - 1, y - 1, w + 2, h + 2, '#2b2540');
    bands(ctx, x, y, w, h, ['#12072e', '#2a0e4a', '#5a1a66']);
    const r = rng(e.seed + i * 17);
    // Far buildings
    for (let bx = x; bx < x + w; bx += 5) rect(ctx, bx, y + 8 + Math.floor(r() * 6), 5, h, '#26143f');
    // Near buildings with lit windows
    for (let bx = x - 2; bx < x + w; ) {
      const bw = 5 + Math.floor(r() * 5), top = y + 11 + Math.floor(r() * 7);
      rect(ctx, bx, top, bw, y + h - top, '#0c0718');
      for (let wy = top + 2; wy < y + h - 1; wy += 2) {
        for (let wx = bx + 1; wx < bx + bw - 1; wx += 2) {
          if (r() < 0.35 && wx >= x && wx < x + w) px(ctx, wx, wy, ['#ffd36b', '#ff5fd2', '#5ff2ff'][Math.floor(r() * 3)]);
        }
      }
      bx += bw + 1;
    }
    // A flying car now and then
    const carX = x + ((e.now / 1000) * 14 + (e.seed % 97)) % (w * 4) - w;
    if (carX > x && carX < x + w - 3) {
      rect(ctx, carX, y + 6, 3, 1, '#ff5fd2');
      faint(ctx, 0.4, () => rect(ctx, carX - 4, y + 6, 4, 1, '#ff5fd2'));
    }
    // Rain
    const rr = rng(e.seed + i * 29);
    faint(ctx, 0.5, () => {
      for (let k = 0; k < 14; k++) {
        const speed = 60 + rr() * 40;
        const rx = x + Math.floor((rr() * w + (e.now / 1000) * speed * 0.35) % w);
        const ry = y + Math.floor((rr() * h + (e.now / 1000) * speed) % h);
        rect(ctx, rx, ry, 1, 2, '#9fb8ff');
      }
    });
    rect(ctx, x, y, w, 1, '#5ff2ff');
    faint(ctx, 0.25, () => rect(ctx, x + 2, y + 2, 1, h - 4, '#ffffff'));
    rect(ctx, x + w / 2, y, 1, h, '#2b2540');
  }

  // ---------------------------------------------------------------------------
  // SPACE STATION
  // ---------------------------------------------------------------------------

  const PLANETS = [['#e39b5a', '#b86a35'], ['#6fb7e0', '#3d7fae'], ['#b58cf0', '#7b55b8'], ['#8fd18a', '#4f9a4a']];

  const space = {
    label: 'Space station',
    dim: 0,
    pet: 'drone',
    petLight: '#4fc3ff',
    furniture: {
      top: '#d6dde8', edge: '#f2f6fb', front: '#aeb8c8', panel: '#9aa4b5', knob: '#4fc3ff', leg: '#6b7488',
      chair: '#e3e8f0', chairLight: '#ffffff', chairSeat: '#b9c2d0', base: '#5b6579',
      monitor: '#3a4150', bezel: '#1b1f29', stand: '#6b7488',
    },

    back(ctx, e) {
      rect(ctx, 0, 0, e.W, 7, '#1b1f29');
      for (let x = 10; x < e.W - 20; x += 44) rect(ctx, x, 2, 26, 2, '#dff1ff');
      rect(ctx, 0, 7, e.W, 1, '#0f1218');
      rect(ctx, 0, 8, e.W, e.WALL - 8, '#3b4354');
      // Wall panels with rivets
      for (let py = 8; py < e.WALL - 6; py += 21) {
        for (let pxx = 0; pxx < e.W; pxx += 24) {
          rect(ctx, pxx, py, 24, 1, '#4b5468');
          rect(ctx, pxx, py, 1, 21, '#4b5468');
          rect(ctx, pxx + 23, py, 1, 21, '#262c38');
          rect(ctx, pxx, py + 20, 24, 1, '#262c38');
          for (const [rx, ry] of [[3, 3], [20, 3], [3, 17], [20, 17]]) px(ctx, pxx + rx, py + ry, '#65708a');
        }
      }
      // Pipe along the top
      rect(ctx, 0, 10, e.W, 3, '#6b7488');
      rect(ctx, 0, 10, e.W, 1, '#8b95ab');
      rect(ctx, 0, 12, e.W, 1, '#4b5263');
      for (let x = 12; x < e.W; x += 34) rect(ctx, x, 9, 3, 5, '#2b303c');
      // Hazard stripes at the bottom of the wall
      for (let y = e.WALL - 5; y < e.WALL; y++) {
        for (let x = 0; x < e.W; x++) if ((x + y) % 8 < 4) px(ctx, x, y, '#e8c14a');
      }
      rect(ctx, 0, e.WALL - 6, e.W, 1, '#262c38');
      for (let y = e.WALL - 5; y < e.WALL; y++) for (let x = 0; x < e.W; x++) if ((x + y) % 8 >= 4) px(ctx, x, y, '#2b2b30');
      rect(ctx, 0, e.WALL, e.W, 3, '#1b1f29');
      gaps(e).forEach((gx, i) => (i % 2 === 0 ? porthole(ctx, e, gx, i) : wallConsole(ctx, e, gx, i)));
      // Station clock
      const cx = e.W - e.RIGHT + 27;
      rect(ctx, cx - 12, 13, 24, 9, '#15161f');
      rect(ctx, cx - 11, 14, 22, 7, '#0a1a14');
      const hh = String(e.date.getHours()).padStart(2, '0'), mm = String(e.date.getMinutes()).padStart(2, '0');
      text(ctx, hh + (Math.floor(e.now / 500) % 2 ? ':' : ' ') + mm, cx - 9, 15, '#3ddc84');
    },

    floor(ctx, e) {
      const rows = floorRows(e.FLOOR, e.H);
      rows.forEach((r, n) => {
        rect(ctx, 0, r.y, e.W, r.h, n % 2 ? '#2a2f3a' : '#2d3340');
        rect(ctx, 0, r.y, e.W, 1, '#3c4454');
        for (let x = -64; x < e.W + 64; x += 16) rect(ctx, spread(e, x, r.y + r.h / 2), r.y, 1, r.h, '#20242d');
        for (let x = (n % 2) * 2; x < e.W; x += 4) px(ctx, x, r.y + Math.floor(r.h / 2), '#22262f');
      });
      // Blue light strip along the wall
      rect(ctx, 0, e.FLOOR, e.W, 1, '#4fc3ff');
      faint(ctx, 0.2, () => rect(ctx, 0, e.FLOOR + 1, e.W, 4, '#4fc3ff'));
    },

    door(ctx, e, open) {
      const x = e.doorX, y = 34, w = 22, h = e.WALL - 34 + 1;
      signBoard(ctx, x + w / 2, y - 10, 'AIRLOCK', '#1b1f29', '#e8c14a', '#07080d');
      // Hazard frame
      rect(ctx, x - 3, y - 3, w + 6, h + 3, '#2b2b30');
      for (let yy = y - 3; yy < y + h; yy++) {
        for (let xx = x - 3; xx < x + w + 3; xx++) {
          const inFrame = xx < x || xx >= x + w || yy < y;
          if (inFrame && (xx + yy) % 6 < 3) px(ctx, xx, yy, '#e8c14a');
        }
      }
      if (open) {
        rect(ctx, x, y, w, h, '#bfe6ff');
        glow(ctx, x + 3, y + 3, w - 6, h - 3, '#bfe6ff', 0.6);
        rect(ctx, x, y, w, 5, '#6b7488');
        rect(ctx, x, y + 4, w, 1, '#4b5263');
        faint(ctx, 0.22, () => { for (let k = 0; k < 14; k++) rect(ctx, x + 1, e.FLOOR + k, w - 2, 1, '#bfe6ff'); });
      } else {
        rect(ctx, x, y, w, h, '#6b7488');
        rect(ctx, x, y, w, 1, '#8b95ab');
        rect(ctx, x + w / 2 - 1, y, 2, h, '#4b5263');
        circle(ctx, x + w / 2, y + 10, 4, '#3a4150');
        circle(ctx, x + w / 2, y + 10, 3, '#0b1a2e');
        px(ctx, x + w / 2 - 1, y + 8, '#bfe6ff');
      }
      const blink = Math.floor(e.now / 500) % 2;
      px(ctx, x + w + 4, y + 2, open ? '#3ddc84' : blink ? '#ff4f5e' : '#5a1a22');
    },

    corner(ctx, e) {
      // Hydroponic plant tube with bubbles
      const x = 5, y = 26, w = 22, h = e.WALL - 26;
      rect(ctx, x - 1, y - 1, w + 2, h + 1, '#15161f');
      rect(ctx, x, y, w, 4, '#8b95ab');
      rect(ctx, x, y + h - 5, w, 5, '#8b95ab');
      rect(ctx, x + 1, y + 4, w - 2, h - 9, '#0f2a2a');
      faint(ctx, 0.9, () => glow(ctx, x + 2, y + 4, w - 4, 1, '#d56bff', 0.8));
      rect(ctx, x + 2, y + 4, w - 4, 1, '#e7a6ff');
      const r = rng(e.seed * 5);
      for (let k = 0; k < 4; k++) {
        const sx = x + 4 + k * 4, top = y + 12 + Math.floor(r() * 12);
        rect(ctx, sx, top, 1, y + h - 5 - top, '#3f8f4a');
        for (let ly = top; ly < y + h - 7; ly += 4) {
          rect(ctx, sx - 2, ly, 2, 1, '#6fd07a');
          rect(ctx, sx + 1, ly + 2, 2, 1, '#6fd07a');
        }
      }
      for (let k = 0; k < 6; k++) {
        const bx = x + 3 + Math.floor(r() * (w - 6));
        const by = y + h - 7 - Math.floor(((e.now / 1000) * (6 + k) + k * 9) % (h - 13));
        px(ctx, bx, by, '#9fe8ff');
      }
      faint(ctx, 0.2, () => rect(ctx, x + 3, y + 5, 2, h - 12, '#ffffff'));
    },

    front(ctx, e) {
      // Supply crate
      const x = 6, y = e.H - 22;
      rect(ctx, x - 1, y - 1, 18, 13, '#15161f');
      rect(ctx, x, y, 16, 11, '#5b6579');
      rect(ctx, x, y, 16, 1, '#8b95ab');
      rect(ctx, x, y + 4, 16, 3, '#e8c14a');
      for (let k = 0; k < 16; k += 4) rect(ctx, x + k, y + 4, 2, 3, '#2b2b30');
    },

    spare(ctx, e, i, top) {
      serverRack(ctx, e, i, top, '#4b5468', '#8b95ab');
    },

    extras(ctx, e, cx, s, i, top) {
      // Blinking buttons on the desk and a blue light along its edge
      for (let k = 0; k < 3; k++) {
        const on = Math.sin(e.now / (200 + k * 90) + i * 2 + k) > 0;
        px(ctx, cx + 16 + k * 3, top + 5, on ? ['#ff4f5e', '#3ddc84', '#ffb627'][k] : '#6b7488');
      }
      rect(ctx, cx - 26, top + 2, 52, 1, '#4fc3ff');
    },

    light(ctx, e) {
      for (let x = 10; x < e.W - 20; x += 44) {
        faint(ctx, 0.05, () => {
          for (let y = 7; y < e.FLOOR; y++) rect(ctx, x - (y - 7) * 0.25, y, 26 + (y - 7) * 0.5, 1, '#dff1ff');
        });
      }
    },
  };

  function porthole(ctx, e, gx, i) {
    const cx = gx, cy = 25, r = 10;
    circle(ctx, cx, cy, r + 1, '#15161f');
    circle(ctx, cx, cy, r, '#8b95ab');
    circle(ctx, cx, cy, r - 2, '#4b5263');
    circle(ctx, cx, cy, r - 3, '#04050c');
    const inner = r - 3;
    const inside = (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= inner * inner;
    // Stars drift past slowly
    const rr = rng(e.seed + i * 7);
    for (let k = 0; k < 16; k++) {
      const sx = cx - inner + Math.floor((rr() * inner * 2 + (e.now / 1000) * 1.5) % (inner * 2));
      const sy = cy - inner + Math.floor(rr() * inner * 2);
      if (inside(sx, sy)) px(ctx, sx, sy, k % 5 === 0 ? '#ffffff' : '#9aa4c8');
    }
    // A planet floats by
    const [light, dark] = PLANETS[(e.seed + i) % PLANETS.length];
    const pxc = cx - inner - 6 + Math.floor(((e.now / 1000) * 0.6 + (e.seed % 50)) % (inner * 2 + 12));
    const pyc = cy + 2;
    for (let y = -4; y <= 4; y++) {
      for (let x = -4; x <= 4; x++) {
        if (x * x + y * y > 17 || !inside(pxc + x, pyc + y)) continue;
        px(ctx, pxc + x, pyc + y, x + y > 1 ? dark : light);
      }
    }
    px(ctx, cx - 4, cy - 5, '#cfe3ff');
    px(ctx, cx - 5, cy - 4, '#cfe3ff');
    for (const [bx, by] of [[0, -r], [r, 0], [0, r], [-r, 0]]) px(ctx, cx + bx, cy + by, '#c9d0dd');
  }

  function wallConsole(ctx, e, gx, i) {
    const x = gx - 11, y = 17, w = 22, h = 16;
    rect(ctx, x - 1, y - 1, w + 2, h + 2, '#15161f');
    rect(ctx, x, y, w, h, '#262c38');
    rect(ctx, x + 2, y + 2, w - 4, 7, '#06140f');
    for (let k = 0; k < w - 4; k++) {
      const wy = Math.round(Math.sin(k / 2 + e.now / 300 + i) * 2);
      px(ctx, x + 2 + k, y + 5 + wy, '#3ddc84');
    }
    const r = rng(e.seed + i);
    for (let k = 0; k < 5; k++) {
      const on = Math.sin(e.now / (150 + r() * 400) + k * 4) > 0;
      rect(ctx, x + 2 + k * 4, y + 11, 2, 2, on ? ['#ff4f5e', '#ffb627', '#3ddc84', '#4fc3ff', '#d56bff'][k] : '#3a4150');
    }
  }

  // ---------------------------------------------------------------------------
  // FOREST CABIN
  // ---------------------------------------------------------------------------

  const cabin = {
    label: 'Forest cabin',
    dim: 0.42,
    pet: 'cat',
    furniture: {
      top: '#8a5a32', edge: '#a8723f', front: '#6b4527', panel: '#5c3b21', knob: '#d8a45a', leg: '#4a2f19',
      chair: '#6b4527', chairLight: '#8a5a32', chairSeat: '#4a2f19', base: '#3a2616',
      monitor: '#2a2d42', bezel: '#1c1e2d', stand: '#3a3e55',
    },

    back(ctx, e) {
      // Log walls
      const r = rng(e.seed * 11);
      for (let y = 5, n = 0; y < e.WALL; y += 7, n++) {
        rect(ctx, 0, y, e.W, 7, '#7a5230');
        rect(ctx, 0, y + 1, e.W, 1, '#94643a');
        rect(ctx, 0, y + 2, e.W, 1, '#86592f');
        rect(ctx, 0, y + 5, e.W, 1, '#5e3d22');
        rect(ctx, 0, y + 6, e.W, 1, '#c8ad80');
        for (let x = (n * 37) % 70; x < e.W; x += 70) rect(ctx, x, y + 1, 1, 5, '#4f331c');
        for (let k = 0; k < e.W / 30; k++) {
          const kx = Math.floor(r() * e.W);
          rect(ctx, kx, y + 3, 2, 1, '#5a3a1f');
        }
      }
      // Ceiling beams
      rect(ctx, 0, 0, e.W, 5, '#2e1d10');
      for (let x = 14; x < e.W; x += 46) {
        rect(ctx, x, 0, 9, 7, '#4f331d');
        rect(ctx, x, 0, 9, 1, '#6b4527');
        rect(ctx, x, 7, 9, 1, '#2a1a0e');
      }
      faint(ctx, 0.3, () => rect(ctx, 0, 5, e.W, 2, '#000'));
      rect(ctx, 0, e.WALL, e.W, 3, '#3a2616');
      rect(ctx, 0, e.WALL, e.W, 1, '#6b4527');
      gaps(e).forEach((gx, i) => (i % 2 === 0 ? cabinWindow(ctx, e, gx, i) : cabinShelf(ctx, e, gx, i)));
      for (let i = 0; i < e.slots; i++) lantern(ctx, e.deskCenter(i), e);
      clock(ctx, e.W - e.RIGHT + 27, 16, e.date, '#efe3c8', '#4a2f19', '#2b2d3c');
    },

    floor(ctx, e) {
      const rows = floorRows(e.FLOOR, e.H);
      rows.forEach((r, n) => {
        rect(ctx, 0, r.y, e.W, r.h, n % 2 ? '#553723' : '#5c3c25');
        rect(ctx, 0, r.y + r.h - 1, e.W, 1, '#3a2616');
        rect(ctx, 0, r.y, e.W, 1, n % 2 ? '#5f3e28' : '#66442b');
        const step = 56, offset = (n * 23) % step;
        for (let x = offset - step; x < e.W + step; x += step) {
          const sx = spread(e, x, r.y + r.h / 2);
          rect(ctx, sx, r.y, 1, r.h - 1, '#3a2616');
          px(ctx, sx + 2, r.y + 1, '#2a1a0e');
        }
      });
      // Braided round rug (at the front of the room)
      const cx = Math.round((e.LEFT + e.doorX) / 2), cy = e.H - 18;
      const rx = Math.round((e.doorX - e.LEFT) / 2) - 10;
      faint(ctx, 0.3, () => ellipse(ctx, cx, cy + 1, rx + 1, 12, '#000')); // shadow under the rug
      ['#6e2c22', '#9a3b2e', '#c46a44', '#d8a45a', '#9a3b2e', '#5c6e3e'].forEach((c, k) => {
        ellipse(ctx, cx, cy, rx - k * 5, 12 - k * 2, c);
      });
      faint(ctx, 0.3, () => rect(ctx, 0, e.FLOOR, e.W, 2, '#000'));
    },

    door(ctx, e, open) {
      const x = e.doorX, y = 34, w = 22, h = e.WALL - 34 + 1;
      // Wooden sign
      rect(ctx, x + 2, y - 11, 18, 8, '#15161f');
      rect(ctx, x + 3, y - 10, 16, 6, '#a8723f');
      text(ctx, 'EXIT', x + 4, y - 10, '#3a2616');
      rect(ctx, x - 3, y - 3, w + 6, h + 3, '#4a2f19');
      rect(ctx, x - 2, y - 2, w + 4, h + 2, '#2a1a0e');
      if (open) {
        bands(ctx, x, y, w, h, [e.sky.top, e.sky.bottom]);
        rect(ctx, x, y + h - 7, w, 7, e.sky.night ? '#dfe8f2' : '#6f9a5a');
        for (let k = x + 2; k < x + w; k += 5) {
          rect(ctx, k + 1, y + h - 16, 1, 3, '#2a1a0e');
          rect(ctx, k, y + h - 14, 3, 7, e.sky.night ? '#12261c' : '#2f5d3a');
        }
        rect(ctx, x, y, 11, h, '#6b4527');
        rect(ctx, x + 3, y, 1, h, '#57381f');
        rect(ctx, x + 7, y, 1, h, '#57381f');
        faint(ctx, 0.2, () => { for (let k = 0; k < 14; k++) rect(ctx, x + 11 + k * 0.5, e.FLOOR + k, 12, 1, e.sky.night ? '#9fb8ff' : '#fff0c2'); });
      } else {
        rect(ctx, x, y, w, h, '#6b4527');
        for (let k = x + 4; k < x + w; k += 5) rect(ctx, k, y, 1, h, '#57381f');
        line(ctx, x + 2, y + h - 4, x + w - 3, y + 4, '#57381f');
        rect(ctx, x, y + 5, 6, 2, '#2b2b30');
        rect(ctx, x, y + h - 8, 6, 2, '#2b2b30');
        rect(ctx, x + w - 5, y + 18, 3, 3, '#2b2b30');
        px(ctx, x + w - 4, y + 19, '#6b4527');
      }
    },

    corner(ctx, e) {
      // Stone fireplace with a real fire
      const x = 2, y = 28, w = 28;
      const r = rng(e.seed * 13);
      rect(ctx, x - 1, y - 1, w + 2, e.WALL - y + 1, '#15161f');
      rect(ctx, x, y, w, e.WALL - y, '#4d4845');
      for (let sy = y, n = 0; sy < e.WALL; sy += 4, n++) {
        for (let sx = x + ((n % 2) * 3) - 3; sx < x + w; sx += 6) {
          const c = ['#7c7671', '#8a837d', '#6d6763', '#948d86'][Math.floor(r() * 4)];
          rect(ctx, Math.max(x, sx + 1), sy + 1, Math.min(5, x + w - Math.max(x, sx + 1)), 3, c);
        }
      }
      rect(ctx, x - 2, y + 12, w + 4, 3, '#5a3a20');
      rect(ctx, x - 2, y + 12, w + 4, 1, '#7a5230');
      // Candle on the mantel
      rect(ctx, x + 20, y + 8, 2, 4, '#efe3c8');
      if (Math.sin(e.now / 90) > -0.8) px(ctx, x + 20 + (Math.floor(e.now / 200) % 2), y + 7, '#ffd166');
      // Firebox
      const fx = x + 6, fy = y + 22, fw = 16, fh = e.WALL - fy;
      rect(ctx, fx, fy, fw, fh, '#140c08');
      rect(ctx, fx + 1, fy - 1, fw - 2, 1, '#140c08');
      rect(ctx, fx + 2, fy + fh - 3, fw - 4, 2, '#4a2f19');
      rect(ctx, fx + 3, fy + fh - 4, fw - 7, 1, '#5e3d22');
      fire(ctx, e);
      rect(ctx, x - 2, e.WALL - 1, w + 4, 4, '#8a837d');
      rect(ctx, x - 2, e.WALL - 1, w + 4, 1, '#a39b94');
    },

    front(ctx, e) {
      // Stack of firewood
      const x = 5, y = e.H - 20;
      for (const [lx, ly] of [[0, 6], [5, 6], [10, 6], [2, 1], [7, 1]]) {
        circle(ctx, x + lx + 2, y + ly + 2, 2, '#8a5a32');
        px(ctx, x + lx + 2, y + ly + 2, '#c79c62');
        rect(ctx, x + lx, y + ly + 4, 5, 1, '#4a2f19');
      }
    },

    spare(ctx, e, i, top) {
      // Potted fern
      const cx = e.deskCenter(i);
      plant(ctx, cx - 7, top + 12, '#2f6b3f', '#4f9a5a', '#8a5a32', '#a8723f');
    },

    extras(ctx, e, cx, s, i, top) {
      mug(ctx, cx + 16, top, ['#efe3c8', '#9a3b2e', '#5c6e3e'][i % 3], s, e);
      if (i % 2 && !(s && s.helpers && s.helpers.active)) papers(ctx, cx - 23, top);
    },

    light(ctx, e) {
      // Warm, flickering firelight (the flames stay bright even at night)
      const f = 0.08 + Math.sin(e.now / 140) * 0.012 + Math.sin(e.now / 57) * 0.008;
      const strength = e.sky.night ? f * 1.5 : f;
      faint(ctx, strength * 0.6, () => ellipse(ctx, 16, 66, 58, 42, '#ff9a2e'));
      faint(ctx, strength, () => ellipse(ctx, 16, 66, 40, 30, '#ff9a2e'));
      faint(ctx, strength, () => ellipse(ctx, 16, 66, 24, 18, '#ffb347'));
      if (e.sky.night) {
        fire(ctx, e);
        for (let i = 0; i < e.slots; i++) {
          faint(ctx, 0.05, () => ellipse(ctx, e.deskCenter(i), 18, 16, 12, '#ffd28a'));
          faint(ctx, 0.07, () => ellipse(ctx, e.deskCenter(i), 14, 8, 6, '#ffd28a'));
        }
      }
    },
  };

  // Flames in the fireplace
  function fire(ctx, e) {
    const fx = 8, fw = 16, baseY = e.WALL - 4;
    const t = e.now / 1000;
    for (let k = 0; k < fw - 4; k++) {
      const flame = 3 + Math.round((Math.sin(t * 9 + k * 1.7) + Math.sin(t * 13 + k * 0.9) + 2) * 1.8);
      for (let j = 0; j < flame; j++) {
        const c = j < flame * 0.4 ? '#ffd166' : j < flame * 0.75 ? '#ff9a2e' : '#e0561f';
        px(ctx, fx + 2 + k, baseY - j, c);
      }
    }
  }

  function cabinWindow(ctx, e, gx, i) {
    const x = gx - 14, y = 11, w = 28, h = 19;
    rect(ctx, x - 3, y - 3, w + 6, h + 6, '#4a2f19');
    rect(ctx, x - 2, y - 2, w + 4, h + 4, '#6b4527');
    bands(ctx, x, y, w, h, [e.sky.top, e.sky.mid, e.sky.bottom]);
    if (e.sky.night) {
      stars(ctx, x, y, w, 9, e.seed + i, e.now, 7);
      rect(ctx, x + 4, y + 3, 3, 3, '#f1ecc4');
    }
    // Snowy mountains and pine trees
    const peak = e.sky.night ? '#2a3558' : '#7d8ea8';
    for (let k = 0; k < 9; k++) {
      rect(ctx, x + 6 - k, y + 7 + k, 1 + k * 2, 1, peak);
      rect(ctx, x + 20 - k, y + 5 + k, 1 + k * 2, 1, peak);
    }
    rect(ctx, x + 19, y + 5, 3, 2, '#eef3f8');
    rect(ctx, x + 5, y + 7, 3, 2, '#eef3f8');
    const tree = e.sky.night ? '#0d1a14' : '#2f5d3a';
    for (let k = 0; k < 6; k++) {
      const tx = x + 1 + k * 5;
      for (let j = 0; j < 5; j++) rect(ctx, tx + 2 - Math.floor(j / 2), y + h - 7 + j, 1 + Math.floor(j / 2) * 2, 1, tree);
    }
    rect(ctx, x, y + h - 2, w, 2, e.sky.night ? '#dfe8f2' : '#6f9a5a');
    // Snow falls at night
    if (e.sky.night) {
      const r = rng(e.seed + i * 3);
      for (let k = 0; k < 10; k++) {
        const sx = x + Math.floor((r() * w + Math.sin(e.now / 900 + k) * 2 + w) % w);
        const sy = y + Math.floor((r() * h + (e.now / 1000) * (4 + k % 3)) % h);
        px(ctx, sx, sy, '#ffffff');
      }
    }
    rect(ctx, x + w / 2 - 1, y, 2, h, '#6b4527');
    rect(ctx, x, y + Math.floor(h / 2) - 1, w, 2, '#6b4527');
    // Flower box
    rect(ctx, x - 2, y + h + 2, w + 4, 4, '#5a3a20');
    rect(ctx, x - 2, y + h + 2, w + 4, 1, '#7a5230');
    for (let k = x; k < x + w; k += 3) {
      px(ctx, k, y + h + 1, '#3f7a4a');
      px(ctx, k + 1, y + h, ['#e05a5a', '#f2c14e', '#e98ad0'][(k + i) % 3]);
    }
  }

  function cabinShelf(ctx, e, gx, i) {
    const x = gx - 11, y = 24;
    rect(ctx, x, y, 22, 2, '#5a3a20');
    rect(ctx, x, y, 22, 1, '#7a5230');
    rect(ctx, x + 2, y + 2, 1, 3, '#4a2f19');
    rect(ctx, x + 19, y + 2, 1, 3, '#4a2f19');
    rect(ctx, x + 2, y - 6, 4, 6, '#9ab8c9');
    rect(ctx, x + 2, y - 7, 4, 1, '#c9a24a');
    rect(ctx, x + 3, y - 4, 2, 3, '#d8a45a');
    rect(ctx, x + 8, y - 8, 2, 8, '#9a3b2e');
    rect(ctx, x + 10, y - 7, 2, 7, '#5c6e3e');
    rect(ctx, x + 12, y - 8, 2, 8, '#3b5a8a');
    rect(ctx, x + 16, y - 4, 4, 4, '#b5653f');
    rect(ctx, x + 16, y - 7, 1, 3, '#3f7a4a');
    rect(ctx, x + 18, y - 8, 1, 4, '#3f7a4a');
  }

  function lantern(ctx, cx, e) {
    rect(ctx, cx, 5, 1, 5, '#2b2b30');
    rect(ctx, cx - 2, 10, 5, 1, '#2b2b30');
    rect(ctx, cx - 2, 11, 5, 4, '#2b2b30');
    rect(ctx, cx - 1, 11, 3, 3, Math.sin(e.now / 110 + cx) > -0.7 ? '#ffd166' : '#ffb347'); // flickering flame
    rect(ctx, cx - 2, 15, 5, 1, '#2b2b30');
  }

  // ---------------------------------------------------------------------------

  const THEMES = { office, neon, space, cabin };
  const ORDER = ['office', 'neon', 'space', 'cabin'];

  // "mixed" gives each room its own style, based on the room's folder
  function pick(style, seed) {
    if (THEMES[style]) return { name: style, theme: THEMES[style] };
    const name = ORDER[seed % ORDER.length];
    return { name, theme: THEMES[name] };
  }

  window.RoomThemes = {
    THEMES, ORDER, pick, vignette, skyFor, drawCat, drawDrone,
    labels: Object.fromEntries(ORDER.map((k) => [k, THEMES[k].label])),
  };
})();
