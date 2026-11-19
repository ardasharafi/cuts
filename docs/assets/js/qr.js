/* Cuts — a QR code as an SVG. Text goes in as bytes (UTF-8); the smallest version that
   holds it is used. Follows ISO/IEC 18004: Reed-Solomon blocks, the eight masks and the
   penalty rules that pick the easiest one to scan. */

const ECC_PER_BLOCK = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
};
const BLOCKS = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
};
const FORMAT_BITS = { L: 1, M: 0 };

function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
function dataCodewords(ver, level) {
  return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[level][ver] * BLOCKS[level][ver];
}

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let rootPow = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      out[j] = gfMul(out[j], rootPow);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    rootPow = gfMul(rootPow, 2);
  }
  return out;
}
function rsRemainder(data, divisor) {
  const out = divisor.map(() => 0);
  data.forEach((b) => {
    const factor = b ^ out.shift();
    out.push(0);
    divisor.forEach((coef, i) => { out[i] ^= gfMul(coef, factor); });
  });
  return out;
}

function alignmentPositions(ver, size) {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

/* Returns { size, modules } where modules[y][x] is true for a dark module. */
export function encode(text, level = 'L') {
  const bytes = [...new TextEncoder().encode(String(text))];
  let ver = 0;
  for (let v = 1; v <= 40; v += 1) {
    const need = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
    if (need <= dataCodewords(v, level) * 8) { ver = v; break; }
  }
  if (!ver) throw new Error('The text is too long for a QR code.');

  // the bit stream: mode, length, the bytes, terminator, padding
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1); };
  push(4, 4);
  push(bytes.length, ver < 10 ? 8 : 16);
  bytes.forEach((b) => push(b, 8));
  const capacity = dataCodewords(ver, level) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) b = (b << 1) | bits[i + j];
    data.push(b);
  }

  // split into blocks, add the error correction, interleave
  const numBlocks = BLOCKS[level][ver];
  const eccLen = ECC_PER_BLOCK[level][ver];
  const rawCodewords = Math.floor(rawModules(ver) / 8);
  const shortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const all = [];
  for (let i = 0; i < blocks[0].length; i += 1) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortBlocks) all.push(block[i]);
    });
  }

  // the fixed patterns
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = !!dark; fixed[y][x] = true; };
  for (let i = 0; i < size; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const align = alignmentPositions(ver, size);
  align.forEach((cy, i) => {
    align.forEach((cx, j) => {
      const corner = (i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0);
      if (corner) return;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    });
  });
  const drawFormat = (mask) => {
    const value = (FORMAT_BITS[level] << 3) | mask;
    let rem = value;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const word = ((value << 10) | rem) ^ 0x5412;
    const bit = (i) => ((word >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const word = (ver << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((word >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark); set(b, a, dark);
    }
  }

  // the data, in the zigzag from the bottom right
  let at = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fixed[y][x] && at < all.length * 8) {
          modules[y][x] = ((all[at >>> 3] >>> (7 - (at & 7))) & 1) !== 0;
          at += 1;
        }
      }
    }
  }

  // try the eight masks, keep the one with the lowest penalty
  const maskAt = (mask, x, y) => {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };
  const applyMask = (mask) => {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) if (!fixed[y][x] && maskAt(mask, x, y)) modules[y][x] = !modules[y][x];
    }
  };
  const penalty = () => {
    let score = 0;
    const lines = [];
    for (let y = 0; y < size; y += 1) lines.push(modules[y]);
    for (let x = 0; x < size; x += 1) lines.push(modules.map((row) => row[x]));
    lines.forEach((line) => {
      let run = 1;
      for (let i = 1; i <= size; i += 1) {
        if (i < size && line[i] === line[i - 1]) { run += 1; continue; }
        if (run >= 5) score += run - 2;
        run = 1;
      }
      const s = line.map((d) => (d ? '1' : '0')).join('');
      for (let i = 0; i + 11 <= size; i += 1) {
        const part = s.substr(i, 11);
        if (part === '10111010000' || part === '00001011101') score += 40;
      }
    });
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
      }
    }
    let dark = 0;
    modules.forEach((row) => row.forEach((d) => { if (d) dark += 1; }));
    score += Math.floor(Math.abs((dark * 20) / (size * size) - 10)) * 10;
    return score;
  };
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(mask);
    drawFormat(mask);
    const score = penalty();
    if (score < bestScore) { bestScore = score; best = mask; }
    applyMask(mask);
  }
  applyMask(best);
  drawFormat(best);
  return { size, version: ver, mask: best, modules };
}

/* The code as an SVG picture with a quiet zone around it. */
export function svg(text, options = {}) {
  const q = encode(text, options.level || 'L');
  const border = 4;
  const full = q.size + border * 2;
  let path = '';
  for (let y = 0; y < q.size; y += 1) {
    let x = 0;
    while (x < q.size) {
      if (!q.modules[y][x]) { x += 1; continue; }
      let run = 1;
      while (x + run < q.size && q.modules[y][x + run]) run += 1;
      path += 'M' + (x + border) + ' ' + (y + border) + 'h' + run + 'v1h-' + run + 'z';
      x += run;
    }
  }
  const px = options.size || 280;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + full + ' ' + full + '" width="' + px + '" height="' + px + '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
    '<rect width="' + full + '" height="' + full + '" fill="#ffffff"/><path d="' + path + '" fill="' + (options.color || '#1f1829') + '"/></svg>';
}
