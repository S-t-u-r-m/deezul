export default [
    { ref: 'app-layout', path: './compiled/AppLayout.compiled.js' },
    { ref: 'home-page', path: './compiled/HomePage.compiled.js' },
    { ref: 'about-page', path: './compiled/AboutPage.compiled.js' },
    { ref: 'counter-page', path: './compiled/CounterPage.compiled.js' },

    // Data stores
    { ref: 'counter-store', type: 'data', data: { count: 0 } },
];
