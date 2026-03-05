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
        { path: '/getting-started', component: 'getting-started-page', layouts: ['app-layout'] },
        { path: '/components', component: 'components-page', layouts: ['app-layout'] },
        { path: '/reactivity', component: 'reactivity-page', layouts: ['app-layout'] },
        { path: '/template-syntax', component: 'template-page', layouts: ['app-layout'] },
        { path: '/loops-conditionals', component: 'loops-page', layouts: ['app-layout'] },
        { path: '/computed', component: 'computed-page', layouts: ['app-layout'] },
        { path: '/routing', component: 'routing-page', layouts: ['app-layout'] },
        { path: '/data-stores', component: 'data-stores-page', layouts: ['app-layout'] },
        { path: '/lifecycle', component: 'lifecycle-page', layouts: ['app-layout'] },
    ]
});
