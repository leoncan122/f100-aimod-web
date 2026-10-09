/**
 * Genera el glb de la pestaña "Cinemática three.js": la escena horneada de
 * Blender SIN el paisaje. Se conserva el subárbol del vehículo tal cual — la
 * camioneta, el perro de la caja y todas sus animaciones (recorrido, ruedas,
 * dirección, suspensión, esqueleto del perro y tapa de la caja) — y se descarta
 * todo lo demás (terreno, carretera, lago, rocas, mirador, barandillas), que en
 * esa pestaña se genera con three.js.
 *
 *  public/models/escena.glb -> public/models/escena-vehiculo.glb
 *
 * Uso: node scripts/extract-cinematic-vehicle.mjs
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { statSync } from 'node:fs';

const INPUT = 'public/models/escena.glb';
const OUTPUT = 'public/models/escena-vehiculo.glb';
const VEHICLE_NAMES = ['HandlerVehicle005', 'HandlerVehicle.005'];

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(2);
const doc = await io.read(INPUT);

for (const scene of doc.getRoot().listScenes()) {
  const children = scene.listChildren();
  const vehicle = children.find((n) => VEHICLE_NAMES.includes(n.getName()));
  if (!vehicle) throw new Error('no se encontró el nodo del vehículo');
  for (const child of children) if (child !== vehicle) scene.removeChild(child);
}

// prune elimina mallas, materiales, texturas y canales de animación que ya no
// referencia nadie. keepLeaves: los nodos vacíos del rig (CAM_Objetivo, huesos
// sin malla) se mantienen porque el mixer los anima.
await doc.transform(prune({ keepLeaves: true }), draco({ method: 'edgebreaker' }));
await io.write(OUTPUT, doc);
console.log(`${INPUT} (${mb(INPUT)} MB) -> ${OUTPUT} (${mb(OUTPUT)} MB)`);
