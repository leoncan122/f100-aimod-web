import './style.css';
import { createViewer } from './viewer';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app no encontrado');

app.innerHTML = `
  <div id="viewport"></div>
  <header class="hud">
    <h1>F100 — aimod_web</h1>
    <p>three.js · glTF</p>
  </header>
  <footer class="hud hud-bottom">
    <span>Arrastrar: orbitar · Rueda: zoom · Click derecho: desplazar</span>
    <span><kbd>R</kbd> auto-rotar · <kbd>F</kbd> encuadrar</span>
  </footer>
  <div id="status" class="status">Iniciando…</div>
`;

createViewer(
  document.querySelector<HTMLDivElement>('#viewport')!,
  document.querySelector<HTMLDivElement>('#status')!,
);
