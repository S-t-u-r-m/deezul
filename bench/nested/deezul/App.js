/**
 * Deezul nested-tree component.
 *
 * Renders a depth-3 tree using nested `:for` loops and `:if` for collapsed
 * subtrees. Collapsed branches unmount (real conditional render) so the
 * benchmark measures honest mount/unmount cost. The `tree` array is whatever
 * the adapter assigns — proxy-based deep reactivity handles per-node mutation.
 *
 * No event handlers in the template — all ops drive the data directly from
 * the adapter, matching the harness pattern in bench/krausest/.
 */
export default Deezul.Component({
    template: `
        <ul class="tree">
            <li :for="root in tree" class="lvl-0">
                <span>{{ root.label }}</span>
                <ul :if="root.expanded">
                    <li :for="mid in root.children" class="lvl-1">
                        <span>{{ mid.label }}</span>
                        <ul :if="mid.expanded">
                            <li :for="leaf in mid.children" class="lvl-2">
                                <span>{{ leaf.label }}</span>
                            </li>
                        </ul>
                    </li>
                </ul>
            </li>
        </ul>
    `,
    data: () => ({
        tree: []
    }),

    styles: `
        ul.tree, ul.tree ul { list-style: none; padding-left: 14px; margin: 0; }
        ul.tree > li > span,
        ul.tree ul > li > span { font-size: 12px; padding: 1px 4px; font-family: 'SF Mono', Consolas, monospace; }
        ul.tree li.lvl-0 > span { color: #1a1a2e; font-weight: 600; }
        ul.tree li.lvl-1 > span { color: #2563eb; }
        ul.tree li.lvl-2 > span { color: #666; }
    `
});
