/**
 * registries.js - Pre-created Registry Instances
 *
 * Exports singleton registry instances for the application.
 */

import { createModuleRegistry } from './ModuleRegistry.js';

// Component registry - for UI components
export const componentRegistry = createModuleRegistry('components');

// Data registry - for reactive data stores (with localStorage support)
export const dataRegistry = createModuleRegistry('data', {
    enableLocalStorage: true,
    enableProxy: true
});
