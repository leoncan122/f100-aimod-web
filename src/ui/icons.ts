/**
 * Iconos de acción, dibujados a mano como paths SVG.
 *
 * Son trazos (`stroke`) sobre una caja de 24×24 y heredan el color con
 * `currentColor`, así que el mismo icono sirve en un botón activo o apagado sin
 * duplicarlo. Van aquí y no en `public/icons.svg` porque ese archivo es el
 * sprite de marcas (redes sociales) y estos se usan desde TypeScript.
 *
 * Criterio de dibujo (tras una primera pasada en la que no se entendían): a
 * ~26 px un icono solo se lee si tiene UNA silueta dominante y aire entre los
 * trazos. Por eso aquí:
 *  - nada de figuras humanas completas — un palo con cuatro extremidades se
 *    convierte en una mancha y todas se parecen entre sí: se dibuja el objeto
 *    o el gesto, no el cuerpo;
 *  - como mucho tres elementos por icono, separados 2 px o más;
 *  - relleno (`fill`) donde la silueta importa más que el contorno (bocadillo,
 *    corazón), que a tamaño pequeño gana mucha legibilidad.
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

interface Icon {
  /** Path(s) del `<svg viewBox="0 0 24 24">`. */
  d: string;
  /** Relleno en vez de contorno: siluetas que se leen mejor macizas. */
  solid?: boolean;
  /** Grosor de trazo propio (por defecto 2). */
  w?: number;
  /** Markup extra con su propia pintura (p. ej. trazos sobre una silueta maciza). */
  extra?: string;
}

const ICONS: Record<IconId, Icon> = {
  // Bocadillo macizo: se reconoce al instante, mejor que un contorno fino.
  speak: {
    d: 'M4 4h16a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-7.8L7 21v-4.5H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
    solid: true,
  },

  // Salto: flecha gruesa hacia arriba despegando del suelo. Una figura humana
  // saltando no se distinguiría de las demás a este tamaño.
  jump: { d: 'M12 3v11.5M12 3 6.8 8.2M12 3l5.2 5.2M4 20.5h16', w: 2.5 },

  // Arrodillarse: la misma flecha hacia el suelo (el gesto, no la figura).
  kneel: { d: 'M12 14.5V3M12 14.5 6.8 9.3M12 14.5l5.2-5.2M4 20.5h16', w: 2.5 },

  // Pistola de perfil, maciza: corredera larga arriba y empuñadura inclinada.
  // En contorno se leía como un banco; rellena la silueta es inconfundible.
  gun: { d: 'M2 7.5h19.5v5h-5.2l-1.7 2.6h-3.4L9.9 21H5.2l1.7-5.9H2z', solid: true },

  // Disparo: pistola más pequeña y desplazada para dejar sitio al fogonazo que
  // sale del cañón. Si el destello no se ve, este icono y el de 'arma' son el
  // mismo dibujo y no se distinguen en el abanico.
  fire: {
    d: 'M1 9h12.6v4.4h-3.4l-1.3 2.3H5.6L4.4 20H1.2l1.2-4.3H1z',
    extra: '<path d="M16.2 11.2h2.6M15.6 7.9l2.1-1.9M15.6 14.5l2.1 1.9M21.4 11.2h1.4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
    solid: true,
  },

  // Saludo: mano abierta. Tres dedos marcados más el pulgar; cinco dedos
  // paralelos se fusionan en un bloque ilegible.
  wave: {
    d: 'M9.2 21c-2.8 0-4.9-2.2-4.9-5V9.4a1.7 1.7 0 0 1 3.4 0v3.1M7.7 12.2V5.3a1.7 1.7 0 0 1 3.4 0v6.9M11.1 12.2V6a1.7 1.7 0 0 1 3.4 0v6.2M14.5 12.5V8.8a1.7 1.7 0 0 1 3.4 0V16c0 2.8-2.1 5-4.9 5z',
    w: 2,
  },

  // Subir: puerta con una flecha entrando.
  board: { d: 'M13.5 2.5H6a1.5 1.5 0 0 0-1.5 1.5v16A1.5 1.5 0 0 0 6 21.5h7.5M9.5 12H22M18.2 8.2 22 12l-3.8 3.8', w: 2.3 },

  // Risa: boca abierta y ojos cerrados en arco. Los ojos "^" son lo que la
  // separa de cualquier otra cara redonda.
  laugh: {
    d: 'M12 2.6a9.4 9.4 0 1 1 0 18.8 9.4 9.4 0 0 1 0-18.8M6.6 10.4 9 8.2l2.4 2.2M12.6 10.4 15 8.2l2.4 2.2M6.4 13.6h11.2a5.6 5.6 0 0 1-11.2 0z',
    w: 2,
  },

  // Abrazo: dos personas juntas de medio cuerpo, con un brazo cruzando la
  // espalda del otro. La versión anterior (dos cabezas sobre un arco) se leía
  // como una cara: los círculos hacían de ojos y el arco de boca.
  hug: {
    d: 'M8 2.6a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4M16 2.6a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4M2.5 21.5v-2.8c0-3.2 2.3-5.4 5.5-5.4M21.5 21.5v-2.8c0-3.2-2.3-5.4-5.5-5.4M12 13.3v8.2M6.2 12.4l11.6 4.2',
    w: 2,
  },

  // Beso: corazón macizo, inconfundible a cualquier tamaño.
  kiss: { d: 'M12 21.2S3.2 15.9 3.2 10.1A5.3 5.3 0 0 1 12 6.7a5.3 5.3 0 0 1 8.8 3.4c0 5.8-8.8 11.1-8.8 11.1z', solid: true },

  close: { d: 'M6 6l12 12M18 6 6 18', w: 2.3 },
};

/**
 * Devuelve el `<svg>` de un icono.
 *
 * `aria-hidden`: el nombre accesible lo pone el botón que lo contiene, así que
 * el icono no debe anunciarse por separado.
 */
export function icon(id: IconId): string {
  const { d, solid, w, extra } = ICONS[id];
  const paint = solid
    ? 'fill="currentColor" stroke="none"'
    : `fill="none" stroke="currentColor" stroke-width="${w ?? 2}"`;
  return (
    `<svg class="icon${solid ? ' solid' : ''}" viewBox="0 0 24 24" aria-hidden="true" ` +
    `${paint} stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${d}"/>${extra ?? ''}</svg>`
  );
}

/** Todos los iconos, para la hoja de contacto que se revisa a ojo. */
export const ALL_ICONS = Object.keys(ICONS) as IconId[];

/**
 * Definiciones en crudo, para herramientas (la hoja de contacto).
 *
 * Se exportan en vez de dejar que un script lea este archivo con una expresión
 * regular: la regex se desincronizaba en silencio al cambiar el formato y la
 * hoja se generaba con la mitad de los iconos.
 */
export const ICON_DEFS: Readonly<Record<IconId, Icon>> = ICONS;
