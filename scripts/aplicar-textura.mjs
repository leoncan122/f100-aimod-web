/**
 * Mete la textura repintada dentro de personaje.glb.
 *
 * El repintado se prepara aparte (build-mask-piel + fix-textura) y se revisa a
 * ojo; esto solo sustituye la imagen baseColor del material, sin tocar malla,
 * esqueleto ni UVs.
 *
 * La textura se guarda en WebP para no inflar el .glb: el original ya venía en
 * WebP (719 KB) y un PNG de 2048² lo multiplicaría por cinco.
 *
 * SEGURIDAD: no sobreescribe sin `--write`. El original está en
 * ~/hermes-workspace/scratchpad/f100-backup/personaje.ORIGINAL.glb y además
 * versionado en git.
 *
 * Uso:
 *   node scripts/aplicar-textura.mjs            # escribe un .glb aparte
 *   node scripts/aplicar-textura.mjs --write    # reemplaza public/models/personaje.glb
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const SRC = 'public/models/personaje.glb';
const TEX = process.argv.find((a) => a.endsWith('.png')) ?? 'test-results/personaje/textura-fix.png';
const WRITE = process.argv.includes('--write');
const DST = WRITE ? SRC : 'public/models/personaje-retexturado.glb';

/**
 * Ajustes de Draco al reescribir el .glb.
 *
 * DEBEN COINCIDIR con los de scripts/optimize-character.mjs, que es quien
 * genera el modelo publicado. `draco()` a secas cuantiza posiciones a 10 bits y,
 * sobre una malla YA cuantizada, eso es una segunda generacion de perdida: se
 * midio que movia 49.380 vertices que nadie habia tocado, 66 mm de media y
 * hasta 686 mm en los dedos. Los 14 bits de posicion hacen falta ademas porque
 * los morphs de la boca se calculan sobre la malla en tiempo de ejecucion y con
 * menos precision los labios se escalonan.
 */
const DRACO = { quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeGeneric: 12 };

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const doc = await io.read(SRC);
const root = doc.getRoot();

// material del personaje (solo hay uno con baseColorTexture)
let tex = null;
for (const m of root.listMaterials()) {
  const t = m.getBaseColorTexture();
  if (t) tex = t;
}
if (!tex) throw new Error('no se encontro baseColorTexture en el modelo');

const antes = tex.getImage()?.byteLength ?? 0;
const mime = tex.getMimeType();
console.log(`textura actual: ${mime}, ${(antes / 1024).toFixed(0)} KB`);

const png = readFileSync(TEX);
// Mismo formato y calidad que scripts/optimize-character.mjs (webp q88): si se
// usa otra calidad, cada pasada vuelve a degradar la imagen entera.
const nueva = mime === 'image/webp'
  ? await sharp(png).webp({ quality: 88 }).toBuffer()
  : await sharp(png).png().toBuffer();

tex.setImage(new Uint8Array(nueva));
console.log(`textura nueva:  ${mime}, ${(nueva.byteLength / 1024).toFixed(0)} KB  (de ${TEX})`);

await doc.transform(draco(DRACO));
await io.write(DST, doc);
console.log(`\n-> ${DST}${WRITE ? '  (reemplazado)' : '  (copia aparte, usa --write para reemplazar)'}`);
