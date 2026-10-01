# f100-aimod-web

Visor 3D del proyecto Blender **F100** montado con **three.js** + **Vite** + **TypeScript**.

Tres modos, conmutables desde las pestañas superiores:

- **Cinemática** — la escena completa (`escena.glb`) con las 119 animaciones horneadas
  y el track de cámara de Blender (`camara.json`: posición, rotación y FOV horizontal
  por frame, 24 fps, 1700 frames ≈ 71 s). Play/pausa, barra de scrub y cámara libre.
- **Modelo** — inspección orbital solo de la camioneta, extraída del subárbol
  `HandlerVehicle005`. Auto-rotación, wireframe, reencuadre y dimensiones reales.
- **Desierto** — escena original hecha 100 % con three.js: recta de desierto al
  anochecer, tierra roja, cactus, acera y luna llena. Bucle de 15 s con cuatro
  cámaras (persecución, lateral, capó, libre). Del glb solo se usa la camioneta.

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

## Enlaces compartibles

Cada vista tiene su propia URL mediante el hash, así que se puede compartir un
enlace directo a una de ellas:

- `#cinematic` — Cinemática (por defecto)
- `#orbit` — Modelo
- `#desert` — Desierto

Pulsar una pestaña actualiza la URL con `pushState`, así que atrás/adelante del
navegador recorren las vistas visitadas. Un hash desconocido abre la vista por
defecto y normaliza la URL, para no compartir un enlace que no corresponde a lo
que se ve.

Se usa el hash y no una ruta real (`/desert`) porque el sitio se publica en
GitHub Pages: el hash no llega al servidor, así que un enlace directo funciona
sin configuración extra, mientras que una ruta devolvería 404.

## Controles

**Cinemática**: `Espacio` play/pausa · barra de scrub · `C` cicla cámara
(cinemática → trasera → libre) · arrastrar el lienzo para asomarse, soltar para
volver al encuadre.
**Modelo**: arrastrar orbita · rueda zoom · `R` auto-rotar · `F` reencuadrar.
**Desierto**: `Espacio` play/pausa · barra de scrub · `C` cicla cámara
(persecución → lateral → capó → libre) · arrastrar el lienzo para asomarse.

## Tests

`scripts/smoke.mjs` levanta Chrome real (ANGLE/SwiftShader), recorre los tres
modos cambiando el hash,
espera a que el overlay de carga desaparezca y comprueba:

- cero errores de consola y cero peticiones fallidas;
- que el canvas renderiza (fps, draw calls, triángulos);
- **regresión de bbox**: en modo Modelo el vehículo debe medir < 8 m en su eje
  mayor. Si un clip del rig raíz se cuela en el mixer, el bbox se dispara a ~25 m
  y el test falla.

Capturas en `test-results/`.

Resultado actual: los tres modos OK, ~2,97 M tris / 495 draw calls en cinemática,
~1,78 M tris / 383 draw calls en modelo y 406 en desierto (bajo SwiftShader, sin
GPU).

### Scripts de verificación

`scripts/lib/viewer.mjs` concentra lo común: arranque de Chrome con GL por
software, `openMode()` para abrir una vista, `waitFrames()` y `seekTo()`.

`openMode()` navega **directo al hash** (`#desert`) en vez de cargar la vista por
defecto y pulsar la pestaña. Ahorra una carga de escena completa — 51 s → 34 s en
`smoke-one desert` — y elimina el clic, que es la parte frágil: si se lanza antes
de que la app monte sus handlers se pierde en silencio y el script acaba midiendo
la vista equivocada mientras informa de éxito.

Todos aceptan la URL base como primer argumento y por defecto usan
`http://localhost:5180/`:

```bash
node scripts/smoke-one.mjs desert          # un modo (evita timeouts)
node scripts/test-grounding.mjs            # regresión de apoyo de las ruedas
node scripts/test-peek.mjs '' desierto     # peek de cámara; 3er arg filtra casos
node scripts/test-hash-routing.mjs         # enlaces compartibles
node scripts/measure-idle-cost.mjs         # consumo con la pestaña oculta
```

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

## Modo Desierto — decisiones de diseño

Escenario **generado por código**, sin assets externos. Presupuesto de escenario:
cielo 1 · estrellas 1 · luna 2 · suelo 1 · asfalto 1 · líneas 1 · bordillos 1 ·
cactus 1 · piedras 1 = **10 draw calls**. El resto (~260) son los meshes de la
camioneta, que vienen así del glb.

Sin objetos duplicados:

- **Cactus (90), piedras (140) y bordillos (~160)** son `InstancedMesh`: una
  geometría y un material por tipo, N matrices. Añadir instancias no añade draw
  calls.
- **Líneas discontinuas** (~65 segmentos): un único `BufferGeometry` con los
  quads escritos a mano en un `Float32Array`.
- **El cactus** se fusiona de 8 primitivas en una sola geometría al arrancar.
- **Faros y pilotos** son `InstancedMesh` de 2 instancias cada uno.
- La camioneta se carga **una vez** mediante el módulo compartido
  `src/vehicle.ts`, que usan tanto este modo como Modelo.

Otros detalles:

- **Cielo**: domo invertido con gradiente en el fragment shader (tres colores),
  sin texturas. Sigue a la cámara en Z para que el horizonte no se agote.
- **Brillo lunar sobre la chapa**: `metalness`/`roughness` reforzados en los
  materiales `Pintura*` y `Chrome*`, más un **IBL generado con PMREM desde el
  propio cielo y la luna**. Sin envMap, un material metálico se renderiza negro.
- **Bucle exacto de 15 s**: `t` se envuelve con `t -= DURATION`, y la recta mide
  `DURATION × SPEED` = 330 m, así que el reinicio no da salto visible.
- **Giro de ruedas** derivado de la distancia recorrida
  (`dist / circunferencia × 2π`), no de un valor arbitrario.
- **Sombras nítidas**: la cámara de sombras es de solo 32×32 m y viaja con el
  vehículo en vez de cubrir los 330 m de ruta.

### Gotcha: fusionar geometrías a mano

`toNonIndexed()` **expande** el número de vértices. Dimensionar el `Float32Array`
con el conteo de la geometría *indexada* y luego copiar la desindexada desborda
el buffer (`RangeError: offset is out of bounds`). Hay que desindexar primero y
medir después.

### Gotcha: apoyar el vehículo en el suelo

Alinear con `box.min.y` (el `Box3` del conjunto) **no** apoya las ruedas:

- El punto más bajo del vehículo no es el neumático, sino la **suspensión/frenos**,
  unos **14 cm por debajo** del contacto real.
- Ese mínimo **oscila hasta 14 cm** al girar las ruedas, porque la llanta no es un
  cilindro perfecto: el coche subiría y bajaría solo por animar el giro.

`extractVehicle()` alinea por el **contacto real**: por cada nodo `ROT_Rueda_*`
toma su eje de giro y le resta el **radio del neumático**, medido como la
distancia máxima del eje a sus vértices en el plano perpendicular (X local → YZ).
Un `Box3` del nodo tampoco sirve para el radio — engloba los frenos y da 0,52 m
en vez de los 0,37 m reales (41 % de error, que también hacía patinar las ruedas).

Al colocar el vehículo hay que sumar además la altura del asfalto (`ROAD_Y`),
que va 2 cm sobre el terreno para evitar z-fighting, y mantener el bamboleo de
suspensión **no negativo** y de amplitud pequeña (≤ 4 mm).

`npm run test:grounding` verifica el hueco en 8 instantes del bucle y falla si
supera ±5 mm. Peor caso actual: **2,2 mm**.
