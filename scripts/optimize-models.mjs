/**
 * Genera los .glb optimizados que se publican en GitHub Pages.
 *
 *  public/models/f100.glb   ->  dist-models/f100-truck.glb
 *      Poda la escena al subárbol del vehículo (HandlerVehicle005). El glb
 *      original trae el paisaje completo, incluida una textura de 2048² que
 *      pesa 6,5 MB y que la camioneta no usa.
 *
 *  public/models/escena.glb ->  dist-models/escena.glb
 *      Se conserva entera (el modo Cinemática la necesita), solo se
 *      recomprime y se reducen las texturas.
 *
 * Uso: node scripts/optimize-models.mjs
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup,
  prune,
  draco,
  textureCompress,
  weld,
  resample,
} from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { mkdirSync, statSync } from 'node:fs';

const OUT_DIR = 'dist-models';
mkdirSync(OUT_DIR, { recursive: true });

const io = new NodeIO()
  .registerExtensions(KHRONOS_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(2);

const VEHICLE_NAMES = ['HandlerVehicle005', 'HandlerVehicle.005'];

/** Deja en la escena solo el subárbol del vehículo. */
function keepOnlyVehicle(document) {
  const root = document.getRoot();
  for (const scene of root.listScenes()) {
    const children = scene.listChildren();
    const vehicle = children.find((n) => VEHICLE_NAMES.includes(n.getName()));
    if (!vehicle) {
      console.warn('  ! no se encontró el nodo del vehículo; no se poda');
      return false;
    }
    for (const child of children) {
      if (child !== vehicle) scene.removeChild(child);
    }
  }
  // Las animaciones del paisaje quedan huérfanas; prune() las elimina después.
  return true;
}

async function build({ input, output, onlyVehicle, textureSize }) {
  console.log(`\n${input} (${mb(input)} MB)`);
  const document = await io.read(input);

  if (onlyVehicle) {
    const ok = keepOnlyVehicle(document);
    console.log(`  poda al vehículo: ${ok ? 'sí' : 'no'}`);
  }

  await document.transform(
    // resample + weld antes de podar: limpia claves redundantes y vértices
    resample(),
    weld(),
    // prune elimina todo lo que ya no referencia nadie (mallas, materiales,
    // texturas y animaciones del paisaje tras la poda)
    prune({ keepAttributes: false, keepLeaves: false }),
    dedup(),
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: [textureSize, textureSize],
    }),
    draco({ method: 'edgebreaker' }),
  );

  await io.write(output, document);
  console.log(`  -> ${output} (${mb(output)} MB)`);
  return { input, output, before: +mb(input), after: +mb(output) };
}

const results = [];
results.push(
  await build({
    input: 'public/models/f100.glb',
    output: `${OUT_DIR}/f100-truck.glb`,
    onlyVehicle: true,
    textureSize: 1024,
  }),
);
results.push(
  await build({
    input: 'public/models/escena.glb',
    output: `${OUT_DIR}/escena.glb`,
    onlyVehicle: false,
    textureSize: 1024,
  }),
);

console.log('\nRESUMEN');
let tb = 0;
let ta = 0;
for (const r of results) {
  const pct = (((r.before - r.after) / r.before) * 100).toFixed(1);
  console.log(`  ${r.output}: ${r.before} -> ${r.after} MB  (-${pct}%)`);
  tb += r.before;
  ta += r.after;
}
console.log(`  TOTAL: ${tb.toFixed(2)} -> ${ta.toFixed(2)} MB  (-${(((tb - ta) / tb) * 100).toFixed(1)}%)`);
