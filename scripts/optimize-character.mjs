/**
 * Genera el .glb publicado del personaje (modo Cinemática: conductor que se baja).
 *
 *  <entrada>.glb  ->  public/models/personaje.glb
 *      Malla con esqueleto de Meshy (28 huesos + 24 de dedos riggeados en Blender),
 *      clips Walking/Running y textura base corregida. Se recomprime con Draco
 *      (también JOINTS/WEIGHTS) y la textura pasa a WebP; las animaciones se
 *      remuestrean para quitar claves redundantes.
 *
 * Uso: node scripts/optimize-character.mjs <ruta/al/personaje-sin-optimizar.glb>
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, draco, textureCompress, resample } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { statSync } from 'node:fs';

const input = process.argv[2];
if (!input) {
  console.error('Uso: node scripts/optimize-character.mjs <entrada.glb>');
  process.exit(1);
}
const output = 'public/models/personaje.glb';

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(2);

const doc = await io.read(input);
await doc.transform(
  dedup(),
  resample(),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [2048, 2048], quality: 88 }),
  // Posiciones a 14 bits: la boca se deforma con morphs calculados sobre la malla
  // en tiempo de ejecución, y con menos precisión los labios se "escalonan".
  draco({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeGeneric: 12 }),
);
await io.write(output, doc);
console.log(`${input} (${mb(input)} MB) -> ${output} (${mb(output)} MB)`);
