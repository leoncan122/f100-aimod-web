/**
 * Iconos de acción, dibujados a mano como paths SVG.
 *
 * Son trazos (`stroke`) sobre una caja de 24×24 y heredan el color con
 * `currentColor`, así que el mismo icono sirve en un botón activo o apagado sin
 * duplicarlo. Van aquí y no en `public/icons.svg` porque ese archivo es el
 * sprite de marcas (redes sociales) y estos se usan desde TypeScript.
 */

export type IconId =
  | 'speak'
  | 'jump'
  | 'kneel'
  | 'gun'
  | 'fire'
  | 'wave'
  | 'board'
  | 'laugh'
  | 'hug'
  | 'kiss'
  | 'close';

/** Contenido interno de cada `<svg viewBox="0 0 24 24">`. */
const PATHS: Record<IconId, string> = {
  // bocadillo de diálogo
  speak: '<path d="M4 5h16v11H9l-5 4z"/>',
  // figura con los brazos arriba y los pies despegados
  jump: '<circle cx="12" cy="4.2" r="2.2"/><path d="M12 7v7"/><path d="M12 8.5 7.5 4.5M12 8.5l4.5-4"/><path d="M12 14l-3 4.5M12 14l3 4.5"/><path d="M4.5 21h15"/>',
  // figura apoyada en una rodilla
  kneel: '<circle cx="13" cy="4.2" r="2.2"/><path d="M13 7v5l-4 4h-4"/><path d="M13 12l3 4v4"/><path d="M13 9.5l4.5 2"/><path d="M4.5 21h15"/>',
  // pistola enfundada
  gun: '<path d="M3 8h13v5h-3l-1.5 2H9l-2-2H3z"/><path d="M6.5 15 5 21"/><path d="M16 10.5h4"/>',
  // disparo: pistola con destello
  fire: '<path d="M3 9h11v4.5h-2.5L10 15.5H7.5L6 13.5H3z"/><path d="M6 15.5 4.8 20"/><path d="M15.5 11.2h2M18.8 8.4l1.8-1.6M18.8 14l1.8 1.6"/>',
  // mano saludando
  wave: '<path d="M8 21v-3.5c-2-1-3-3-3-5.5V7a1.4 1.4 0 0 1 2.8 0v3.5"/><path d="M7.8 10.5V5.2a1.4 1.4 0 0 1 2.8 0v5.3"/><path d="M10.6 10.5V5.8a1.4 1.4 0 0 1 2.8 0v4.7"/><path d="M13.4 10.8V7.6a1.4 1.4 0 0 1 2.8 0V13c0 2.6-1 4.8-2.6 6v2"/>',
  // puerta de la camioneta con flecha de entrada
  board: '<path d="M14 3H6v18h8"/><path d="M11 12h9"/><path d="m17 9 3 3-3 3"/>',
  // cara riendo
  laugh: '<circle cx="12" cy="12" r="9"/><path d="M7.5 9.5 10 11l-2.5 1.5M16.5 9.5 14 11l2.5 1.5"/><path d="M7.5 15c1 2 7.5 2 9 0z"/>',
  // dos figuras abrazadas
  hug: '<circle cx="8.5" cy="5.5" r="2.3"/><circle cx="15.5" cy="5.5" r="2.3"/><path d="M8.5 8.5c-2.5 0-4 1.8-4 4v2M15.5 8.5c2.5 0 4 1.8 4 4v2"/><path d="M5 12.5c3 2.5 11 2.5 14 0"/><path d="M8.5 14.5V21M15.5 14.5V21"/>',
  // corazón
  kiss: '<path d="M12 20s-7.5-4.6-7.5-9.5A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
};

/**
 * Devuelve el `<svg>` de un icono.
 *
 * `aria-hidden`: el nombre accesible lo pone el botón que lo contiene, así que
 * el icono no debe anunciarse por separado.
 */
export function icon(id: IconId): string {
  return (
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" ` +
    `stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">` +
    `${PATHS[id]}</svg>`
  );
}
