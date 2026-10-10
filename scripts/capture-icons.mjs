/**
 * Hoja de contacto de los iconos de acción.
 *
 * Los renderiza al tamaño REAL del botón (y al doble, para ver el dibujo) sobre
 * el fondo oscuro de la interfaz. Sirve para juzgar legibilidad a ojo: un icono
 * que no se entiende a 27 px no se arregla mirándolo a 200.
 *
 * Uso: node scripts/capture-icons.mjs
 */
import { launch } from './lib/viewer.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = 'test-results/iconos';
mkdirSync(OUT, { recursive: true });

// Los iconos se piden al propio modulo (ICON_DEFS) a traves de vite: asi la
// hoja NO puede quedar desfasada. Antes se parseaba el .ts con una expresion
// regular y al cambiar el formato se genero la hoja con 5 de 11 iconos sin
// avisar de nada.
const mod = await import('../src/ui/icons.ts').catch(() => null);
let icons;
if (mod?.ICON_DEFS) {
  icons = Object.entries(mod.ICON_DEFS).map(([id, v]) => ({ id, ...v, w: v.w ?? 2, extra: v.extra ?? '' }));
} else {
  // node no sabe importar TypeScript: se pide al dev server que lo transpile
  const base = process.argv[2] ?? 'http://localhost:5180/';
  const res = await fetch(new URL('src/ui/icons.ts', base));
  if (!res.ok) throw new Error(`no se pudo cargar src/ui/icons.ts del dev server (${res.status}); arranca "npm run dev"`);
  const js = await res.text();
  const url = 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
  const m = await import(url);
  icons = Object.entries(m.ICON_DEFS).map(([id, v]) => ({ id, ...v, w: v.w ?? 2, extra: v.extra ?? '' }));
}
const ESPERADOS = 11;
if (icons.length !== ESPERADOS) throw new Error(`se esperaban ${ESPERADOS} iconos y se leyeron ${icons.length}`);

const ETIQUETAS = {
  speak: 'Hablar', jump: 'Saltar', kneel: 'Arrodillarse', gun: 'Arma', fire: 'Disparar',
  wave: 'Saludar', board: 'Subir', laugh: 'Reír', hug: 'Abrazar', kiss: 'Beso', close: 'Cerrar',
};

const svg = (i, px) => {
  const paint = i.solid
    ? 'fill="currentColor" stroke="none"'
    : `fill="none" stroke="currentColor" stroke-width="${i.w}"`;
  return `<svg width="${px}" height="${px}" viewBox="0 0 24 24" ${paint} stroke-linecap="round" stroke-linejoin="round"><path d="${i.d}"/>${i.extra}</svg>`;
};

const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0e1116;color:#e8ecf1;font:14px system-ui,'Segoe UI',sans-serif">
<div style="padding:20px">
  <h2 style="margin:0 0 4px;font-size:15px;font-weight:600">Iconos de acción</h2>
  <p style="margin:0 0 18px;color:#9aa4b2;font-size:12px">Arriba: tamaño real en el botón (27 px sobre círculo de 50). Abajo: el dibujo al doble.</p>
  <div style="display:flex;flex-wrap:wrap;gap:14px">
    ${icons.map((i) => `
      <div style="width:104px;text-align:center">
        <div style="width:50px;height:50px;margin:0 auto;border-radius:50%;border:1px solid #2c3440;background:rgba(16,20,26,.9);display:grid;place-items:center">${svg(i, i.solid ? 25 : 27)}</div>
        <div style="margin:9px auto 0;width:50px;height:50px;border-radius:50%;background:#d9483b;border:1px solid #d9483b;display:grid;place-items:center">${svg(i, i.solid ? 25 : 27)}</div>
        <div style="margin-top:9px;color:#9aa4b2">${svg(i, 54)}</div>
        <div style="margin-top:4px;font-size:11px;color:#9aa4b2">${ETIQUETAS[i.id] ?? i.id}</div>
      </div>`).join('')}
  </div>
</div></body>`;

const file = `${OUT}/hoja.html`;
writeFileSync(file, html);

const browser = await launch();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 760, height: 560, deviceScaleFactor: 2 });
  await page.goto(`file://${process.cwd().replace(/\\/g, '/')}/${file}`, { waitUntil: 'load' });
  await page.screenshot({ path: `${OUT}/hoja.png`, fullPage: true });
  console.log(`${icons.length} iconos:`, icons.map((i) => i.id).join(', '));
  console.log(`-> ${OUT}/hoja.png`);
} finally {
  await browser.close();
}
