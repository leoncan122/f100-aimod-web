# f100-aimod-web

Visor 3D del proyecto Blender **F100** montado con **three.js** + **Vite** + **TypeScript**.

Dos modos, conmutables desde las pestañas superiores:

- **Cinemática** — la escena completa (`escena.glb`) con las 119 animaciones horneadas
  y el track de cámara de Blender (`camara.json`: posición, rotación y FOV horizontal
  por frame, 24 fps, 1700 frames ≈ 71 s). Play/pausa, barra de scrub y cámara libre.
- **Modelo** — inspección orbital solo de la camioneta, extraída del subárbol
  `HandlerVehicle005`. Auto-rotación, wireframe, reencuadre y dimensiones reales.

## Stack

- three.js `^0.186` — GLTFLoader + DRACOLoader, OrbitControls, Sky, PMREMGenerator
- TypeScript strict
- Vite 7

## Assets

Viven en `public/models/` y están en `.gitignore` (binarios grandes):

| archivo | tamaño | contenido |
|---|---|---|
| `escena.glb` | 14,5 MB | escena completa animada |
| `f100.glb` | 11,5 MB | misma escena; se extrae solo el vehículo |
| `camara.json` | 115 KB | track de cámara horneado |

Origen: `OneDrive\Documentos\Objetos\web_f100\`, exportados desde
`Objetos\blend\f100-aimod_web.blend`.

### Regenerar desde el .blend

```bash
npm run export:model   # requiere blender en el PATH
```

three.js no lee `.blend`: hay que exportar a glTF/GLB con **+Y up**,
**Apply Modifiers** y **Draco** activados.

## Uso

```bash
npm install
npm run dev      # http://127.0.0.1:5173
npm run lint     # tsc --noEmit
npm run build    # tsc + vite build -> dist/
npm run smoke    # test de humo en Chrome headless (requiere dev server activo)
```

## Controles

**Cinemática**: `Espacio` play/pausa · barra de scrub · botón *Cámara libre* para
orbitar alrededor del vehículo.
**Modelo**: arrastrar orbita · rueda zoom · `R` auto-rotar · `F` reencuadrar.

## Tests

`scripts/smoke.mjs` levanta Chrome real (ANGLE/SwiftShader), carga ambos modos,
espera a que el overlay de carga desaparezca y comprueba:

- cero errores de consola y cero peticiones fallidas;
- que el canvas renderiza (fps, draw calls, triángulos);
- **regresión de bbox**: en modo Modelo el vehículo debe medir < 8 m en su eje
  mayor. Si un clip del rig raíz se cuela en el mixer, el bbox se dispara a ~25 m
  y el test falla.

Capturas en `test-results/`.

Resultado actual: ambos modos OK, ~2,97 M tris / 495 draw calls en cinemática y
~1,78 M tris / 383 draw calls en modelo (bajo SwiftShader, sin GPU).

## Notas de implementación

- **Iluminación**: la de Cycles no se exporta en glTF. Cinemática la recrea con
  `Sky` procedural + PMREM como IBL y una direccional que sigue a la camioneta.
  Modelo usa `RoomEnvironment` como IBL de estudio.
- **Agua**: el shader procedural del lago tampoco se exporta; `Lago_*` recibe un
  `MeshPhysicalMaterial` azul.
- **Extracción del vehículo**: `f100.glb` contiene el paisaje entero (~843 m).
  Se usa `Group.attach()` para conservar la transformada mundial y luego se
  liberan geometrías/materiales/texturas del resto **excluyendo los compartidos**
  con el vehículo (un dispose indiscriminado rompe los materiales de la camioneta).
- **Filtro de animaciones en modo Modelo**: solo clips `ROT_Rueda_*`, `PIV_Dir_*`
  y `Rueda_*`. Los del nodo raíz mueven el vehículo por el paisaje.
- **Sombras**: la direccional de cinemática reencuadra su cámara de sombras sobre
  el vehículo cada frame; sin eso, el paisaje de 843 m degrada la resolución.
