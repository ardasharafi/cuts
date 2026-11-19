/* Cuts on the iPhone: PDFs and the share sheet.
 * A Home Screen app on the iPhone can't print, so the statement is drawn into a PDF
 * here: the real statement page is laid out by the browser, painted onto a canvas
 * element by element at print resolution, and packed into an A4 PDF.
 * (The computer prints the same page with Edge or Chrome instead.) */

const MM = 96 / 25.4;
const SCALE = 2.5;
const PAGES = { portrait: { w: 210, h: 297, top: 14, bottom: 12 }, landscape: { w: 297, h: 210, top: 12, bottom: 12 } };

function latin1(s) { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i += 1) u[i] = s.charCodeAt(i) & 255; return u; }
function transparent(c) { return !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c); }
function px(v) { return parseFloat(v) || 0; }
function blobBytes(b) { return b.arrayBuffer().then((ab) => new Uint8Array(ab)); }

function roundRectPath(ctx, x, y, w, h, r) {
  const tl = Math.min(r[0], w / 2, h / 2);
  const tr = Math.min(r[1], w / 2, h / 2);
  const br = Math.min(r[2], w / 2, h / 2);
  const bl = Math.min(r[3], w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  if (tr) ctx.arcTo(x + w, y, x + w, y + tr, tr); else ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - br);
  if (br) ctx.arcTo(x + w, y + h, x + w - br, y + h, br); else ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + bl, y + h);
  if (bl) ctx.arcTo(x, y + h, x, y + h - bl, bl); else ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + tl);
  if (tl) ctx.arcTo(x, y, x + tl, y, tl); else ctx.lineTo(x, y);
  ctx.closePath();
}
function radii(cs) { return [px(cs.borderTopLeftRadius), px(cs.borderTopRightRadius), px(cs.borderBottomRightRadius), px(cs.borderBottomLeftRadius)]; }

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

/* An SVG drawn as an image, with its colours written into it so it looks the same outside the page. */
function svgImage(svg, w, h) {
  const clone = svg.cloneNode(true);
  const src = svg.querySelectorAll('*');
  const dst = clone.querySelectorAll('*');
  for (let i = 0; i < src.length; i += 1) {
    const cs = getComputedStyle(src[i]);
    ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin'].forEach((p) => {
      const v = cs.getPropertyValue(p);
      if (v) dst[i].setAttribute(p, v);
    });
  }
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(Math.round(w * SCALE)));
  clone.setAttribute('height', String(Math.round(h * SCALE)));
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function paintSlice(sheet, origin, images, sl, pageW, pageH) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(pageW * SCALE);
  canvas.height = Math.round(pageH * SCALE);
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pageW, pageH);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, sl.from + sl.shift, pageW, sl.to - sl.from);
  ctx.clip();
  ctx.translate(0, sl.shift);
  const range = document.createRange();
  const visible = (y, h) => y + h >= sl.from - 1 && y <= sl.to + 1;

  function drawText(node, cs) {
    const text = node.nodeValue;
    if (!text || !/\S/.test(text)) return;
    ctx.fillStyle = cs.color;
    ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText('Hg');
    const asc = m.fontBoundingBoxAscent || px(cs.fontSize) * 0.97;
    const desc = m.fontBoundingBoxDescent || px(cs.fontSize) * 0.24;
    const tt = cs.textTransform;
    const ls = cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing);
    const widths = {};
    const adv = (ch) => (widths[ch] !== undefined ? widths[ch] : (widths[ch] = ctx.measureText(ch).width));
    const shape = (s) => (tt === 'uppercase' ? s.toUpperCase() : tt === 'lowercase' ? s.toLowerCase() : s);
    if (RTL.test(text)) {
      // Right-to-left scripts need their letters joined: draw each line as a whole.
      const lines = [];
      const re = /\S+/g;
      let mm;
      while ((mm = re.exec(text))) {
        range.setStart(node, mm.index); range.setEnd(node, mm.index + mm[0].length);
        const rr = range.getBoundingClientRect();
        const y = rr.top - origin.top;
        let line = lines.filter((l) => Math.abs(l.y - y) < 2)[0];
        if (!line) { line = { y, h: rr.height, left: rr.left, right: rr.right, words: [] }; lines.push(line); }
        line.left = Math.min(line.left, rr.left); line.right = Math.max(line.right, rr.right);
        line.words.push(mm[0]);
      }
      lines.forEach((l) => {
        if (!visible(l.y, l.h)) return;
        ctx.save();
        ctx.direction = 'rtl';
        ctx.textAlign = 'right';
        ctx.fillText(shape(l.words.join(' ')), l.right - origin.left, l.y + (l.h - asc - desc) / 2 + asc);
        ctx.restore();
      });
      return;
    }
    for (let i = 0; i < text.length;) {
      const cp = text.codePointAt(i);
      const n = cp > 0xffff ? 2 : 1;
      const ch = text.substr(i, n);
      if (/\S/.test(ch)) {
        range.setStart(node, i); range.setEnd(node, i + n);
        const r = range.getClientRects()[0];
        if (r && r.width > 0) {
          const y2 = r.top - origin.top;
          // Centre the glyph in the space the page gave it (tabular figures are wider than plain ones).
          const g = shape(ch);
          if (visible(y2, r.height)) ctx.fillText(g, r.left - origin.left + Math.max(0, (r.width - ls - adv(g)) / 2), y2 + (r.height - asc - desc) / 2 + asc);
        }
      }
      i += n;
    }
  }

  function drawEl(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    const x = r.left - origin.left;
    const y = r.top - origin.top;
    const w = r.width;
    const h = r.height;
    if (!visible(y, h) && el !== sheet) return;
    const op = parseFloat(cs.opacity);
    ctx.save();
    if (op < 1) ctx.globalAlpha *= op;
    const rad = radii(cs);
    const rounded = rad[0] || rad[1] || rad[2] || rad[3];
    if (!transparent(cs.backgroundColor) && w > 0 && h > 0) {
      ctx.fillStyle = cs.backgroundColor;
      if (rounded) { roundRectPath(ctx, x, y, w, h, rad); ctx.fill(); } else ctx.fillRect(x, y, w, h);
    }
    const bt = cs.borderTopStyle !== 'none' ? px(cs.borderTopWidth) : 0;
    const br = cs.borderRightStyle !== 'none' ? px(cs.borderRightWidth) : 0;
    const bb = cs.borderBottomStyle !== 'none' ? px(cs.borderBottomWidth) : 0;
    const bl = cs.borderLeftStyle !== 'none' ? px(cs.borderLeftWidth) : 0;
    if (rounded && bt && bt === br && bt === bb && bt === bl && cs.borderTopColor === cs.borderLeftColor && !transparent(cs.borderTopColor)) {
      ctx.strokeStyle = cs.borderTopColor; ctx.lineWidth = bt;
      roundRectPath(ctx, x + bt / 2, y + bt / 2, w - bt, h - bt, rad.map((v) => Math.max(0, v - bt / 2)));
      ctx.stroke();
    } else {
      if (bt && !transparent(cs.borderTopColor)) { ctx.fillStyle = cs.borderTopColor; ctx.fillRect(x, y, w, bt); }
      if (bb && !transparent(cs.borderBottomColor)) { ctx.fillStyle = cs.borderBottomColor; ctx.fillRect(x, y + h - bb, w, bb); }
      if (bl && !transparent(cs.borderLeftColor)) { ctx.fillStyle = cs.borderLeftColor; ctx.fillRect(x, y, bl, h); }
      if (br && !transparent(cs.borderRightColor)) { ctx.fillStyle = cs.borderRightColor; ctx.fillRect(x + w - br, y, br, h); }
    }
    if (el instanceof SVGSVGElement) {
      const img = images.get(el);
      if (img) ctx.drawImage(img, x, y, w, h);
      ctx.restore();
      return;
    }
    if (cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden') {
      if (rounded) roundRectPath(ctx, x, y, w, h, rad); else { ctx.beginPath(); ctx.rect(x, y, w, h); }
      ctx.clip();
    }
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) drawText(c, cs);
      else if (c.nodeType === 1) drawEl(c);
    }
    ctx.restore();
  }

  drawEl(sheet);
  ctx.restore();
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (!b) { reject(new Error('This device couldn’t draw the PDF.')); return; }
      blobBytes(b).then((bytes) => {
        const out = { jpeg: bytes, w: canvas.width, h: canvas.height, pw: (pageW * 72) / 96, ph: (pageH * 72) / 96 };
        canvas.width = 0; canvas.height = 0;
        resolve(out);
      }, reject);
    }, 'image/jpeg', 0.92);
  });
}

/* Paints one statement sheet (an .st-sheet element) into pages. */
function paintSheet(sheet) {
  const landscape = sheet.classList.contains('st-landscape');
  const P = landscape ? PAGES.landscape : PAGES.portrait;
  const pageW = P.w * MM;
  const pageH = P.h * MM;
  const top = P.top * MM;
  const bottom = P.bottom * MM;
  const stage = document.createElement('div');
  stage.className = 'pdf-stage';
  stage.style.cssText = 'position:fixed;left:-30000px;top:0;width:' + pageW + 'px;pointer-events:none;';
  stage.appendChild(sheet);
  document.body.appendChild(stage);

  const fonts = ['400', '500', '600', '700'].map((w) => w + ' 12px Inter').concat(['400 12px Adventor', '700 12px Adventor']);
  const ready = document.fonts && document.fonts.load
    ? Promise.all(fonts.map((f) => document.fonts.load(f).catch(() => {}))).then(() => document.fonts.ready)
    : Promise.resolve();

  return ready.then(() => {
    const svgs = [...sheet.querySelectorAll('svg')];
    return Promise.all(svgs.map((s) => { const r = s.getBoundingClientRect(); return svgImage(s, r.width, r.height); })).then((imgs) => {
      const images = new Map();
      svgs.forEach((s, i) => images.set(s, imgs[i]));
      const origin = sheet.getBoundingClientRect();
      const total = origin.height;
      // Page breaks fall between table rows and between sections, like printing does.
      const cuts = [];
      sheet.querySelectorAll('tr, .st-sheet > *, .st-section > *').forEach((el) => { cuts.push(el.getBoundingClientRect().top - origin.top); });
      cuts.sort((a, b) => a - b);
      const slices = [];
      if (total <= pageH + 1) slices.push({ from: 0, to: total, shift: 0 });
      else {
        let start = 0;
        let first = true;
        while (start < total - bottom - 1) {
          const room = first ? pageH - bottom : start + (pageH - top - bottom);
          let end = room;
          if (room < total - bottom) {
            let best = -1;
            cuts.forEach((c) => { if (c > start + 20 && c <= room) best = c; });
            end = best > 0 ? best : room;
          } else end = total - bottom;
          slices.push({ from: start, to: end, shift: first ? 0 : top - start });
          start = end; first = false;
        }
      }
      const pages = slices.map((sl) => paintSlice(sheet, origin, images, sl, pageW, pageH));
      stage.remove();
      return Promise.all(pages).then((list) => list.map((p) => { p.landscape = landscape; return p; }));
    });
  }, (e) => { stage.remove(); throw e; });
}

function pdfText(s) {
  let hexText = 'FEFF';
  for (let i = 0; i < s.length; i += 1) hexText += ('000' + s.charCodeAt(i).toString(16).toUpperCase()).slice(-4);
  return '<' + hexText + '>';
}

/* Packs painted pages into a PDF file. */
export function buildPdf(pages, title) {
  const parts = [];
  const offsets = [];
  let len = 0;
  const add = (x) => { const b = typeof x === 'string' ? latin1(x) : x; parts.push(b); len += b.length; };
  const num = (v) => (Math.round(v * 100) / 100).toString();
  add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = pages.length;
  const kids = [];
  for (let i = 0; i < n; i += 1) kids.push((4 + i * 3) + ' 0 R');
  offsets[1] = len; add('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offsets[2] = len; add('2 0 obj\n<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >>\nendobj\n');
  const d = new Date();
  const p2 = (v) => (v < 10 ? '0' : '') + v;
  const when = 'D:' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  offsets[3] = len; add('3 0 obj\n<< /Title ' + pdfText(title || 'Statement') + ' /Producer (Cuts) /Creator (Cuts for iPhone) /CreationDate (' + when + ') >>\nendobj\n');
  pages.forEach((pg, k) => {
    const pn = 4 + k * 3;
    const cn = pn + 1;
    const im = pn + 2;
    offsets[pn] = len;
    add(pn + ' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + num(pg.pw) + ' ' + num(pg.ph) + '] /Resources << /XObject << /Im0 ' + im + ' 0 R >> >> /Contents ' + cn + ' 0 R >>\nendobj\n');
    const content = 'q ' + num(pg.pw) + ' 0 0 ' + num(pg.ph) + ' 0 0 cm /Im0 Do Q';
    offsets[cn] = len;
    add(cn + ' 0 obj\n<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n');
    offsets[im] = len;
    add(im + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + pg.w + ' /Height ' + pg.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + pg.jpeg.length + ' >>\nstream\n');
    add(pg.jpeg);
    add('\nendstream\nendobj\n');
  });
  const count = 4 + n * 3;
  const xref = len;
  let x = 'xref\n0 ' + count + '\n0000000000 65535 f \n';
  for (let j = 1; j < count; j += 1) x += ('000000000' + offsets[j]).slice(-10) + ' 00000 n \n';
  add(x);
  add('trailer\n<< /Size ' + count + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
  return new Blob(parts, { type: 'application/pdf' });
}

/* Draws statement sheets into one PDF. Each sheet is an .st-sheet element that is not in the page yet. */
export function statementPdf(sheets, title) {
  let all = [];
  let chain = Promise.resolve();
  sheets.forEach((s) => { chain = chain.then(() => paintSheet(s).then((pages) => { all = all.concat(pages); })); });
  return chain.then(() => buildPdf(all, title));
}

export function canShareFiles(files) {
  try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files })); } catch (e) { return false; }
}

/* Hands files to the share sheet (Save to Files, Telegram, Mail, Print). Without a share
   sheet the files are downloaded. Resolves to false when the person closed the sheet. */
export function share(files, title) {
  if (canShareFiles(files)) {
    return navigator.share({ files, title }).then(() => true, (e) => {
      if (e && e.name === 'AbortError') return false;
      throw e;
    });
  }
  files.forEach((f) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  });
  return Promise.resolve(true);
}

export function makeFile(blob, name) {
  return new File([blob], name, { type: blob.type || 'application/octet-stream' });
}
