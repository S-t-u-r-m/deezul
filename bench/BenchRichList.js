/**
 * BenchRichList - bench variant with multiple bindings on a deeper node.
 *
 * The inner <span> sits at template path [0, 0] (li → article → span) and has
 * 5 bindings — event handler, 3 attributes, and a text binding. Without
 * path-grouping, each row walks `childNodes[0].childNodes[0]` five times.
 * With path-grouping, it walks once. The point of this template is to
 * exercise the worst case for redundant path resolution.
 *
 * Data shape (items: string[]) and removeItem(index) match BenchList so the
 * same benchmark operations apply unchanged.
 */
export default Deezul.Component({
    template: `
        <div>
            <ul :if="items.length > 0">
                <li :for="item in items" :index="index">
                    <article class="row">
                        <span class="lbl" @click="removeItem(index)" :class="item" :title="item" :data-idx="index">{{ item }}</span>
                    </article>
                </li>
            </ul>
        </div>
    `,
    data: () => ({ items: [] }),
    methods: {
        removeItem(index) {
            this.items.splice(index, 1);
        }
    }
});
