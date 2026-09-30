# f100-aimod-web

Visor 3D del modelo Blender **`f100-aimod_web.blend`** (Ford F100) montado con **three.js** + **Vite** + **TypeScript**.

## Stack

- three.js `^0.186` (GLTFLoader, DRACOLoader, OrbitControls, RoomEnvironment)
- TypeScript (strict)
- Vite 7

## Origen del modelo

`C:\Users\leonc\OneDrive\Documentos\Objetos\blend\f100-aimod_web.blend` (~46 MB)

three.js no lee `.blend` directamente: hay que exportar a **glTF/GLB** (con compresión Draco).

### Exportar el modelo

Requiere Blender instalado y en el `PATH`:

```bash
npm run export:model
```

Eso ejecuta:

```bash
blender --background "<ruta>/f100-aimod_web.blend" \
  --python scripts/blend_to_glb.py -- public/models/f100-aimod_web.glb
```

Alternativa manual: abrir el `.blend` en Blender → *File ▸ Export ▸ glTF 2.0 (.glb)*
con **+Y up**, **Apply Modifiers** y **Draco compression** activados, guardando en
`public/models/f100-aimod_web.glb`.

El `.glb` está en `.gitignore` (asset binario grande) — se regenera con el script.

## Uso

```bash
npm install
npm run dev      # servidor de desarrollo
npm run lint     # tsc --noEmit
npm run build    # tsc + vite build -> dist/
npm run preview
```

## Controles

- Arrastrar: orbitar
- Rueda: zoom
- Click derecho: desplazar
- `R`: auto-rotación
- `F`: reencuadrar el modelo

## Estructura

```
src/
  main.ts      # bootstrap de la UI
  viewer.ts    # escena three.js: renderer, luces, IBL, carga glTF, encuadre automático
  style.css
scripts/
  blend_to_glb.py   # exportador headless Blender -> GLB
public/models/      # destino del .glb (ignorado por git)
```

## Notas técnicas

- Tone mapping ACES Filmic + `PMREMGenerator` sobre `RoomEnvironment` para IBL sin cargar HDRIs externos.
- Encuadre automático: se calcula el `Box3` del modelo, se centra en el origen y se ajustan cámara, sombras y grid a su escala — funciona con cualquier tamaño de exportación.
- Decoder Draco servido desde el CDN de gstatic.
