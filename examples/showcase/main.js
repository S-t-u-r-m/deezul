import Deezul from './deezul.esm.js';
import modules from './modules.config.js';

// Auto-detect base path from <base href> (for GitHub Pages subdirectory hosting)
const baseEl = document.querySelector('base');
const basePath = baseEl ? baseEl.getAttribute('href').replace(/\/$/, '') : '';

Deezul.init({
    rootElement: 'app',
    basePath,
    modules,
    routes: [
        { path: '/', component: 'home-page', layouts: ['app-layout'] },
        { path: '/about', component: 'about-page', layouts: ['app-layout'] },
        { path: '/counter', component: 'counter-page', layouts: ['app-layout'] },
    ]
});
