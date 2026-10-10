/**
 * Capa de interfaz del visor: coloca los controles en regiones con layout real
 * (rejilla) en vez de dejar cada panel flotando con `position: fixed`.
 *
 * El problema que resuelve: cada modo creaba sus paneles anclados a esquinas
 * fijas (pestañas arriba-izquierda, stats arriba-derecha, HUD abajo, panel del
 * personaje arriba-derecha, panel de Aitziber arriba-izquierda). En cuanto la
 * ventana se estrechaba —móvil, tablet, portátil en horizontal— se solapaban
 * entre ellos y las pestañas se salían de la pantalla.
 *
 * Aquí se monta una rejilla de tres filas (barra superior · zona de paneles ·
 * HUD) que nunca se solapan porque el navegador las reparte. Los modos solo
 * piden un sitio donde colgar sus controles:
 *
 *   ui.dockLeft   paneles secundarios (acompañante…)
 *   ui.dockRight  panel principal de interacción
 *   ui.hud        barra inferior de reproducción
 *   ui.layer      cosas libres sobre la escena (bocadillos, joystick)
 *
 * Es genérico a propósito: sirve para cualquier modo presente o futuro, con o
 * sin interacción. Un dock vacío no ocupa espacio.
 */

export interface Overlay {
  /** Contenedor de toda la interfaz (no captura el ratón salvo en los paneles). */
  root: HTMLElement;
  tabs: HTMLElement;
  stats: HTMLElement;
  hud: HTMLElement;
  /** Columna de paneles pegada al borde izquierdo (derecho/abajo en móvil). */
  dockLeft: HTMLElement;
  /** Columna de paneles pegada al borde derecho. */
  dockRight: HTMLElement;
  /** Capa libre sobre la escena para elementos posicionados a mano. */
  layer: HTMLElement;
  /** Vacía docks, HUD y capa libre (al cambiar de modo). */
  clear(): void;
  dispose(): void;
}

const el = (tag: string, id?: string, cls?: string) => {
  const n = document.createElement(tag);
  if (id) n.id = id;
  if (cls) n.className = cls;
  return n;
};

export function createOverlay(host: HTMLElement): Overlay {
  const root = el('div', 'ui');

  const topbar = el('div', 'topbar');
  const tabs = el('div', 'tabs');
  const stats = el('div', 'stats');
  // Plegar los paneles: en pantallas pequeñas los controles tapan buena parte
  // de la escena, y mirar el modelo es el motivo de la página.
  const toggle = el('button', 'uiToggle', 'btn') as HTMLButtonElement;
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'true');
  // En móvil solo cabe el icono; el texto largo se oculta por CSS pero sigue
  // siendo el nombre accesible del botón.
  const setToggle = (open: boolean) => {
    toggle.innerHTML = `<span class="ico" aria-hidden="true">${open ? '▾' : '▸'}</span><span class="lbl">${open ? 'Ocultar controles' : 'Mostrar controles'}</span>`;
    toggle.setAttribute('aria-label', open ? 'Ocultar controles' : 'Mostrar controles');
    toggle.setAttribute('aria-expanded', String(open));
  };
  setToggle(true);
  topbar.append(tabs, stats, toggle);

  const docks = el('div', 'docks');
  const dockLeft = el('div', 'dockLeft', 'dock');
  const dockRight = el('div', 'dockRight', 'dock');
  docks.append(dockLeft, dockRight);

  const hud = el('div', 'hud');
  const layer = el('div', 'layer');

  root.append(topbar, docks, hud, layer);
  host.appendChild(root);

  toggle.onclick = () => {
    const open = root.classList.toggle('min') === false;
    setToggle(open);
  };

  // El botón solo tiene sentido si el modo activo tiene paneles (Modelo y
  // Desierto no los usan): se oculta solo observando los docks.
  const syncToggle = () => {
    const any = dockLeft.childElementCount + dockRight.childElementCount > 0;
    toggle.hidden = !any;
    if (!any) root.classList.remove('min');
  };
  const mo = new MutationObserver(syncToggle);
  mo.observe(dockLeft, { childList: true });
  mo.observe(dockRight, { childList: true });
  syncToggle();

  // El joystick y los bocadillos se colocan a mano sobre la escena, así que
  // necesitan saber cuánto ocupa el HUD para no quedar debajo. El HUD cambia de
  // alto al envolverse en móvil, de ahí el observer en vez de una constante.
  const setVar = (name: string, px: number) => root.style.setProperty(name, `${Math.round(px)}px`);
  const measure = () => {
    setVar('--hud-h', hud.getBoundingClientRect().height);
    setVar('--top-h', topbar.getBoundingClientRect().height);
  };
  const ro = new ResizeObserver(measure);
  ro.observe(hud);
  ro.observe(topbar);
  measure();

  return {
    root,
    tabs,
    stats,
    hud,
    dockLeft,
    dockRight,
    layer,
    clear() {
      dockLeft.replaceChildren();
      dockRight.replaceChildren();
      layer.replaceChildren();
      hud.replaceChildren();
    },
    dispose() {
      ro.disconnect();
      mo.disconnect();
      root.remove();
    },
  };
}
