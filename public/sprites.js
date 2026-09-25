// Pixel art for AI Room.
// Each sprite is a list of strings. Each character is one pixel, and the
// palette says which colour it is ('.' = see-through).
//
//   o outline   b body   d body shadow   l body highlight
//   s state light (green/amber/red/grey)   e eyes (same as state)
//   k dark metal   g light metal   f face screen

(function () {
  // ---- Robot, facing you (standing) ----
  const HEAD_FRONT = [
    '......sss......',
    '......sss......',
    '.......k.......',
    '...ooooooooo...',
    '..olllllllllo..',
    '..obfffffffbo..',
    '..obfefffefbo..',
    '..obfefffefbo..',
    '..obfffffffbo..',
    '..odbbbbbbbdo..',
    '...ooooooooo...',
  ];
  const BODY_FRONT = [
    '.....okgko.....',
    '..ooooooooooo..',
    '.obbbbbbbbbbbo.',
    '.obobbsssbbobo.',
    '.obobbsssbbobo.',
    '.obobbbbbbbobo.',
    '.ogodbbbbbdogo.',
    '..o.ooooooo.o..',
  ];
  const LEGS = {
    stand: ['.....ok.ko.....', '.....ok.ko.....', '....ooo.ooo....'],
    stepL: ['.....ok.ko.....', '....ooo.ko.....', '........ooo....'],
    stepR: ['.....ok.ko.....', '.....ok.ooo....', '....ooo........'],
    sit: ['....ooo.ooo....'],
  };

  // Blink: close the eyes for a frame
  const HEAD_BLINK = HEAD_FRONT.map((r, i) => (i === 6 ? r.replace(/e/g, 'f') : i === 7 ? r.replace(/e/g, 'k') : r));

  // Waving: right arm up next to the head
  const WAVE = [
    '......sss......',
    '......sss......',
    '.......k.......',
    '...ooooooooo...',
    '..olllllllllo.o',
    '..obfffffffbogo',
    '..obfefffefbogo',
    '..obfefffefbobo',
    '..obfffffffbobo',
    '..odbbbbbbbdobo',
    '...ooooooooo.bo',
    '.....okgko...bo',
    '..ooooooooooobo',
    '.obbbbbbbbbbbo.',
    '.obobbsssbbo...',
    '.obobbsssbbo...',
    '.obobbbbbbbo...',
    '.ogodbbbbbdo...',
    '..o.ooooooo....',
  ];

  // ---- Robot, from behind, sitting at a desk ----
  const BACK = [
    '......sss......',
    '......sss......',
    '.......k.......',
    '...ooooooooo...',
    '..olllllllllo..',
    '..obbbbbbbbbo..',
    '..obkkkkkkkbo..',
    '..obbbbbbbbbo..',
    '..obkkkkkkkbo..',
    '..odbbbbbbbdo..',
    '...ooooooooo...',
    '.....okgko.....',
    '..ooooooooooo..',
    '.obbbbbbbbbbbo.',
    '.obobbsssbbobo.',
    '.obobbbbbbbobo.',
    '.ododdddddd' + 'odo.',
    '..o.ooooooo.o..',
  ];

  // Moves a block of pixels up or down (used to make arms "type").
  function shift(rows, col0, col1, row0, dy) {
    const grid = rows.map((r) => r.split(''));
    const out = rows.map((r) => r.split(''));
    for (let y = row0; y < rows.length; y++) for (let x = col0; x <= col1; x++) out[y][x] = '.';
    for (let y = row0; y < rows.length; y++) {
      for (let x = col0; x <= col1; x++) {
        const ny = y + dy;
        if (ny >= 0 && ny < rows.length && grid[y][x] !== '.') out[ny][x] = grid[y][x];
      }
    }
    return out.map((r) => r.join(''));
  }

  // Slumped head for sleeping: everything above the neck drops 1 pixel
  const BACK_SLEEP = shift(BACK, 0, 14, 0, 1).map((r, i) => (i < 12 ? r : BACK[i]));

  const SPRITES = {
    front: [...HEAD_FRONT, ...BODY_FRONT, ...LEGS.stand],
    frontBlink: [...HEAD_BLINK, ...BODY_FRONT, ...LEGS.stand],
    walkL: [...HEAD_FRONT, ...BODY_FRONT, ...LEGS.stepL],
    walkR: [...HEAD_FRONT, ...BODY_FRONT, ...LEGS.stepR],
    sitFront: [...HEAD_FRONT, ...BODY_FRONT, ...LEGS.sit],
    sitFrontBlink: [...HEAD_BLINK, ...BODY_FRONT, ...LEGS.sit],
    wave: [...WAVE, ...LEGS.sit],
    back: BACK,
    backTypeL: shift(BACK, 0, 2, 13, -1),
    backTypeR: shift(BACK, 12, 14, 13, -1),
    backSleep: BACK_SLEEP,
  };

  // ---- 3x5 pixel font ----
  const FONT = {
    A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110',
    E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101',
    I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
    M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100',
    Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
    U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
    Y: '101101010010010', Z: '111001010100111',
    0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
    4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010',
    8: '111101111101111', 9: '111101111001110',
    '-': '000000111000000', '.': '000000000000010', '!': '010010010000010', '?': '110001010000010',
    ':': '000010000010000', '/': '001001010100100', '_': '000000000000111', '>': '100010001010100',
    '+': '000010111010000', ' ': '000000000000000', "'": '010010000000000',
  };

  // ---- Colours ----
  const STATE_COLORS = {
    working: '#3ddc84',
    waiting: '#ffb627',
    blocked: '#ff4f5e',
    idle: '#5f6488',
    off: '#2c2f45',
  };

  function robotPalette(hue, light) {
    return {
      o: '#15161f',
      b: `hsl(${hue} 38% 64%)`,
      d: `hsl(${hue} 32% 44%)`,
      l: `hsl(${hue} 55% 82%)`,
      s: light,
      e: light,
      k: '#434860',
      g: '#b9bed2',
      f: '#10121b',
    };
  }

  // Pre-draw each sprite+palette once into a tiny canvas, then reuse it.
  const cache = new Map();
  function spriteCanvas(name, palette, key) {
    const id = name + '|' + key;
    let c = cache.get(id);
    if (c) return c;
    const rows = SPRITES[name];
    c = document.createElement('canvas');
    c.width = rows[0].length;
    c.height = rows.length;
    const ctx = c.getContext('2d');
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const color = palette[row[x]];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 1, 1);
      }
    });
    if (cache.size > 400) cache.clear();
    cache.set(id, c);
    return c;
  }

  function drawRobot(ctx, name, x, y, hue, light) {
    const c = spriteCanvas(name, robotPalette(hue, light), hue + light);
    ctx.drawImage(c, Math.round(x), Math.round(y));
  }

  function spriteSize(name) {
    return { w: SPRITES[name][0].length, h: SPRITES[name].length };
  }

  // Draws text with the 3x5 font. Returns the width in pixels.
  function text(ctx, str, x, y, color) {
    ctx.fillStyle = color;
    const s = String(str).toUpperCase();
    for (let i = 0; i < s.length; i++) {
      const glyph = FONT[s[i]] || FONT['?'];
      for (let p = 0; p < 15; p++) {
        if (glyph[p] === '1') ctx.fillRect(x + i * 4 + (p % 3), y + Math.floor(p / 3), 1, 1);
      }
    }
    return textWidth(s);
  }

  function textWidth(str) {
    return Math.max(0, String(str).length * 4 - 1);
  }

  window.Sprites = { SPRITES, STATE_COLORS, drawRobot, spriteSize, text, textWidth, robotPalette, spriteCanvas };
})();
