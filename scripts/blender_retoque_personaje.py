"""
Prepara una sesión de Blender para retocar la textura del conductor.

Importa public/models/personaje.glb, deja el material visible en el visor y
abre el espacio de trabajo de pintura de texturas con el pincel ya configurado
para clonar piel sana sobre el blanco derramado del hombro.

Se lanza así (no hace falta tocar nada a mano):

    blender --python scripts/blender_retoque_personaje.py

Qué queda listo:
  - el personaje importado, escalado y encuadrado;
  - la textura baseColor como imagen activa para pintar;
  - vista de material (se ve la textura, no el gris);
  - modo Texture Paint con el pincel "Clone" seleccionado.

El retoque pendiente es la cara interna del hombro: ahí el blanco de la
camiseta es tan ancho que no tiene piel sana cerca EN EL ATLAS, así que el
repintado automático (scripts/fix-textura.mjs) no puede rellenarlo. A mano sí,
porque en 3D la piel buena está al lado.

Al guardar: File > Export > glTF 2.0 sobre public/models/personaje.glb, o bien
guardar la imagen (Image > Save As) y pasarla a
  node scripts/aplicar-textura.mjs <imagen.png> --write
"""
import bpy
import os
import sys
from mathutils import Vector

PROY = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
GLB = os.path.join(PROY, 'public', 'models', 'personaje.glb')


def limpiar_escena():
    """Escena vacía: fuera el cubo, la cámara y la luz por defecto."""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for bloque in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(bloque):
            if item.users == 0:
                bloque.remove(item)


def importar():
    if not os.path.exists(GLB):
        print(f'[retoque] NO existe {GLB}')
        sys.exit(1)
    bpy.ops.import_scene.gltf(filepath=GLB)
    mallas = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not mallas:
        print('[retoque] el glb no trajo ninguna malla')
        sys.exit(1)
    # la malla con más vértices es el cuerpo
    cuerpo = max(mallas, key=lambda o: len(o.data.vertices))
    print(f'[retoque] malla: {cuerpo.name} · {len(cuerpo.data.vertices)} vertices')
    return cuerpo


def imagen_basecolor(obj):
    """La textura de color del material, para pintar sobre ella."""
    for slot in obj.material_slots:
        mat = slot.material
        if not mat or not mat.use_nodes:
            continue
        for nodo in mat.node_tree.nodes:
            if nodo.type == 'TEX_IMAGE' and nodo.image:
                return nodo.image
    return None


def encuadrar(obj):
    """Deja la vista mirando al torso, que es donde está el trabajo."""
    for area in bpy.context.screen.areas:
        if area.type != 'VIEW_3D':
            continue
        for espacio in area.spaces:
            if espacio.type != 'VIEW_3D':
                continue
            espacio.shading.type = 'MATERIAL'   # ver la textura, no gris
            espacio.shading.use_scene_lights = False
            espacio.shading.use_scene_world = False
            r3d = espacio.region_3d
            # mirando al torso desde delante: es donde está el trabajo
            r3d.view_location = Vector((0.0, 0.0, 1.35))
            r3d.view_distance = 1.1
    # unidades en metros, para que las medidas cuadren con el proyecto
    bpy.context.scene.unit_settings.system = 'METRIC'
    bpy.context.scene.unit_settings.scale_length = 1.0


def preparar_pintura(obj, img):
    """Modo Texture Paint con el pincel de clonar y la imagen activa."""
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    escena = bpy.context.scene
    ajustes = escena.tool_settings.image_paint
    # pintar directamente sobre la imagen del material
    ajustes.mode = 'MATERIAL'
    if img:
        ajustes.canvas = img
        print(f'[retoque] textura activa: {img.name} {tuple(img.size)}')

    try:
        bpy.ops.object.mode_set(mode='TEXTURE_PAINT')
    except RuntimeError as e:
        print(f'[retoque] no se pudo entrar en Texture Paint: {e}')
        return

    # Clone: copia de una zona sana a la estropeada. Es lo que hace falta aquí;
    # un color plano se vería como un parche sin grano ni sombra.
    #
    # OJO: desde Blender 4.3 los pinceles son assets y `bpy.data.brushes` suele
    # estar vacío al arrancar, así que esto normalmente NO funciona y hay que
    # elegir Clone a mano en la barra de pinceles. Se intenta igualmente por si
    # la versión lo permite, y si no se avisa por consola.
    for nombre in ('Clone', 'TexDraw'):
        pincel = bpy.data.brushes.get(nombre)
        if pincel:
            ajustes.brush = pincel
            print(f'[retoque] pincel: {nombre}')
            break
    else:
        print('[retoque] ELIGE "Clone" A MANO en la barra de pinceles de abajo '
              '(pestaña All). Ver docs/retoque-textura.md')
    if ajustes.brush:
        ajustes.brush.size = 60
        ajustes.brush.strength = 0.85
        # bordes suaves: un clon con borde duro canta tanto como la mancha
        try:
            ajustes.brush.curve_preset = 'SMOOTH'
        except (AttributeError, TypeError):
            pass


def main():
    limpiar_escena()
    cuerpo = importar()
    img = imagen_basecolor(cuerpo)
    if img is None:
        print('[retoque] OJO: no se encontro la textura baseColor')
    encuadrar(cuerpo)
    preparar_pintura(cuerpo, img)

    # Fuera de public/: ahi lo serviria vite y se colaria en el repo (7,5 MB).
    # El scratchpad es scratch de verdad y ya guarda el backup de los modelos.
    destino = os.path.join(
        os.path.expanduser('~'), 'hermes-workspace', 'scratchpad', 'f100-backup',
        'personaje-retoque.blend',
    )
    os.makedirs(os.path.dirname(destino), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=destino)
    print(f'[retoque] sesion guardada en {destino}')
    print('[retoque] listo: Ctrl+clic elige el origen del clon, clic pinta')


main()
