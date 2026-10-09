/**
 * Aitziber (acompañante de la cinemática three.js): el glb riggeado del
 * artefacto "Aitziber al sol", comprimido para la web.
 *
 *  Objetos/fbx/Aitzi_Pose-A1_rigged.glb -> public/models/aitzi.glb
 *
 * Draco para la malla (los JOINTS/WEIGHTS del skin se conservan) y texturas a
 * WebP 1024. Los nombres de los huesos no cambian: companion.ts los busca por nombre.
 *
 * Uso: node scripts/optimize-aitzi.mjs [ruta del glb de origen]
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco, textureCompress, prune } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { statSync } from 'node:fs';

const INPUT = process.argv[2] ?? '../../../OneDrive/Documentos/Objetos/fbx/Aitzi_Pose-A1_rigged.glb';
const OUTPUT = 'public/models/aitzi.glb';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(2);
const doc = await io.read(INPUT);
await doc.transform(
  prune({ keepLeaves: true }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }),
  draco({ method: 'edgebreaker' }),
);
await io.write(OUTPUT, doc);
console.log(`${INPUT} (${mb(INPUT)} MB) -> ${OUTPUT} (${mb(OUTPUT)} MB)`);
