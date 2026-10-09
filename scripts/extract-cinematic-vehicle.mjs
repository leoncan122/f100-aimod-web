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
 * Puertas que se abren: en escena.glb cada pieza de la puerta (panel, ventanilla,
 * marco, manijas, panel interior, retrovisor) es UNA malla con los dos lados
 * fusionados por el modificador Espejo, colgada de la carrocería. Si existe
 * public/models/puertas-src.glb — exportado desde f100-aimod.blend con las
 * puertas ya separadas por lado y colgadas de su bisagra (PIV_Puerta_Cond y
 * PIV_Puerta_Acomp) — se injerta en su lugar: se quitan las piezas fusionadas y
 * se cuelgan las bisagras de `Cube` en su posición. Las piezas reusan los
 * materiales de la camioneta por nombre, así que se ven idénticas.
 *
 * Uso: node scripts/extract-cinematic-vehicle.mjs
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, draco, mergeDocuments, unpartition } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { existsSync, statSync } from 'node:fs';

const INPUT = 'public/models/escena.glb';
const DOORS = 'public/models/puertas-src.glb';
const OUTPUT = 'public/models/escena-vehiculo.glb';
const VEHICLE_NAMES = ['HandlerVehicle005', 'HandlerVehicle.005'];

/** Piezas de puerta fusionadas (los dos lados) que sustituyen las puertas separadas. */
const MERGED_DOOR_PARTS = [
  'Plane.003', 'Ventana_Lat_Vidrio', 'Ventana_Lat_Marco', 'Manija_Puerta', 'Manija_Base', 'Manija_Boton',
  'Int_Paneles_Puerta', 'Int_Manijas_Puerta', 'Retrovisor_Base', 'Retrovisor_Brazo', 'Retrovisor_Cabeza', 'Retrovisor_Espejo',
];
/**
 * Bisagras en el marco local de `Cube` (Blender: x lateral, y adelante, z arriba),
 * tal como se crearon en f100-aimod.blend: arista delantera de cada puerta.
 * glTF (+Y arriba): (x, y, z)_blender -> (x, z, -y).
 */
const HINGES = {
  PIV_Puerta_Acomp: [0.863, -0.173, -0.236],
  PIV_Puerta_Cond: [-0.863, -0.173, -0.236],
};

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(2);
const doc = await io.read(INPUT);
const root = doc.getRoot();

for (const scene of root.listScenes()) {
  const children = scene.listChildren();
  const vehicle = children.find((n) => VEHICLE_NAMES.includes(n.getName()));
  if (!vehicle) throw new Error('no se encontró el nodo del vehículo');
  for (const child of children) if (child !== vehicle) scene.removeChild(child);
}

if (existsSync(DOORS)) {
  const cube = root.listNodes().find((n) => n.getName() === 'Cube');
  if (!cube) throw new Error('no se encontró la carrocería (Cube)');
  // fuera las piezas fusionadas (y sus instancias de Geometry Nodes)
  let removed = 0;
  for (const child of cube.listChildren()) {
    if (!MERGED_DOOR_PARTS.includes(child.getName())) continue;
    const kill = [];
    child.traverse((n) => kill.push(n));
    cube.removeChild(child);
    for (const n of kill) n.dispose();
    removed++;
  }
  // materiales de la camioneta por nombre, antes de fusionar (los del injerto se descartan)
  const vehicleMats = new Map(root.listMaterials().map((m) => [m.getName(), m]));

  const doors = await io.read(DOORS);
  const map = mergeDocuments(doc, doors);
  const doorScene = map.get(doors.getRoot().listScenes()[0]);
  for (const [name, [x, y, z]] of Object.entries(HINGES)) {
    const piv = doorScene.listChildren().find((n) => n.getName() === name);
    if (!piv) throw new Error(`puertas-src.glb: falta ${name}`);
    doorScene.removeChild(piv);
    piv.setTranslation([x, z, -y]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
    cube.addChild(piv);
    piv.traverse((n) => {
      for (const prim of n.getMesh()?.listPrimitives() ?? []) {
        const own = vehicleMats.get(prim.getMaterial()?.getName() ?? '');
        if (own) prim.setMaterial(own);
      }
    });
  }
  doorScene.dispose();
  await doc.transform(unpartition());
  console.log(`puertas injertadas: ${removed} piezas fusionadas sustituidas por ${Object.keys(HINGES).join(' y ')}`);
}

// prune elimina mallas, materiales, texturas y canales de animación que ya no
// referencia nadie. keepLeaves: los nodos vacíos del rig (CAM_Objetivo, huesos
// sin malla) se mantienen porque el mixer los anima.
await doc.transform(prune({ keepLeaves: true }), draco({ method: 'edgebreaker' }));
await io.write(OUTPUT, doc);
console.log(`${INPUT} (${mb(INPUT)} MB) -> ${OUTPUT} (${mb(OUTPUT)} MB)`);
