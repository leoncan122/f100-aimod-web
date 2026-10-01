/**
 * Mide el hueco REAL entre los neumáticos y el asfalto en el modo Desierto,
 * dentro de la escena en ejecución (no recargando el glb por separado).
 */
import { DEFAULT_BASE, launch, openMode } from './lib/viewer.mjs';

const BASE = process.argv[2] ?? DEFAULT_BASE;

const browser = await launch();

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 520 });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 300)));

  // Directo a la vista por hash: evita cargar la vista por defecto y pulsar la
  // pestaña (una carga de escena menos, ~12 s bajo SwiftShader).
  await openMode(page, BASE, 'desert');
  await new Promise((r) => setTimeout(r, 4000));
  await page.click('#play'); // pausar para medir estable

  // Exponer la escena: recorrer el canvas no basta, así que se busca por el
  // árbol de objetos a través de una referencia global que inyectamos.
  const out = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');

    // localizar la escena viva: el renderer guarda la última escena en __three
    // si no existe, reconstruimos buscando desde el canvas -> no disponible.
    const scene = window.__scene;
    if (!scene) return { error: 'no hay window.__scene; hay que exponerla' };

    const truck = scene.getObjectByName('F100');
    if (!truck) return { error: 'no se encontró el grupo F100' };

    scene.updateMatrixWorld(true);

    // asfalto: plano a Y conocido
    let roadY = null;
    scene.traverse((o) => {
      if (o.isMesh && o.geometry?.type === 'PlaneGeometry' && o.material?.color) {
        const hex = o.material.color.getHexString();
        if (hex === '101018') roadY = o.position.y;
      }
    });

    const truckBox = new THREE.Box3().setFromObject(truck);

    // Contacto REAL: eje de giro de cada rueda menos su radio medido en el
    // plano perpendicular al eje. El Box3 del nodo engloba frenos/suspensión.
    const inv = new THREE.Matrix4();
    const wp = new THREE.Vector3();
    const p = new THREE.Vector3();
    const contacts = [];
    truck.traverse((node) => {
      if (!/^ROT_Rueda_/.test(node.name)) return;
      node.getWorldPosition(wp);
      inv.copy(node.matrixWorld).invert();
      let rMax = 0;
      node.traverse((o) => {
        if (!o.isMesh) return;
        const pa = o.geometry?.attributes.position;
        if (!pa) return;
        for (let i = 0; i < pa.count; i++) {
          p.fromBufferAttribute(pa, i);
          o.localToWorld(p);
          p.applyMatrix4(inv);
          const r = Math.hypot(p.y, p.z);
          if (r > rMax) rMax = r;
        }
      });
      contacts.push({
        name: node.name,
        axisY: +wp.y.toFixed(4),
        radio: +rMax.toFixed(4),
        contactoY: +(wp.y - rMax).toFixed(4),
      });
    });
    contacts.sort((a, b) => a.contactoY - b.contactoY);

    const wheels = [];
    truck.traverse((o) => {
      if (!o.isMesh) return;
      if (!/Wheel|Rueda|Neumatico|Llanta/i.test(o.name)) return;
      const b = new THREE.Box3().setFromObject(o);
      wheels.push({ name: o.name, minY: +b.min.y.toFixed(4) });
    });
    wheels.sort((a, b) => a.minY - b.minY);

    return {
      truckPositionY: +truck.position.y.toFixed(4),
      roadTopY: roadY,
      contactoRuedas: contacts,
      huecoReal:
        roadY === null || !contacts.length
          ? null
          : +(contacts[0].contactoY - roadY).toFixed(4),
      bboxMinY: +truckBox.min.y.toFixed(4),
      huecoSegunBbox: roadY === null ? null : +(truckBox.min.y - roadY).toFixed(4),
    };
  });

  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
}
