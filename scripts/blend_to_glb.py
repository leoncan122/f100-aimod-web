"""
Exporta un .blend a .glb para three.js.

Uso (headless):
  blender --background <archivo.blend> --python scripts/blend_to_glb.py -- <salida.glb>
"""
import sys
import bpy

argv = sys.argv
argv = argv[argv.index("--") + 1:] if "--" in argv else []
out = argv[0] if argv else "public/models/model.glb"

# Selecciona todo lo visible en la escena activa
bpy.ops.object.select_all(action="SELECT")

bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    export_apply=True,          # aplica modificadores
    export_yup=True,            # Y-up (convención three.js)
    export_materials="EXPORT",
    export_cameras=False,
    export_lights=False,
    export_animations=True,
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=6,
)

print(f"[blend_to_glb] escrito: {out}")
