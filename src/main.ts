import './style.css';
import { createApp } from './app';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app no encontrado');

createApp(root);
