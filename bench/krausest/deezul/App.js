/**
 * Deezul implementation of the krausest js-framework-benchmark spec.
 *
 * Data shape: items = [{ id, label }, ...], selected = id|null.
 * Same row template as the official krausest reference rows:
 *   <tr [danger if selected]>
 *     <td>{id}</td>
 *     <td><a @click=select(id)>{label}</a></td>
 *     <td><a @click=remove(id)>x</a></td>
 *     <td></td>
 *   </tr>
 */
export default Deezul.Component({
    template: `
        <div class="krausest-app">
            <table class="ktbl">
                <tbody>
                    <tr :for="item in items" :class="item.id === selected ? 'danger' : ''">
                        <td class="col-md-1">{{ item.id }}</td>
                        <td class="col-md-4"><a @click="select(item.id)">{{ item.label }}</a></td>
                        <td class="col-md-1"><a @click="remove(item.id)">x</a></td>
                        <td class="col-md-6"></td>
                    </tr>
                </tbody>
            </table>
        </div>
    `,
    // Page-level CSS can't cross the shadow boundary, so the bench rows
    // rendered unstyled vs React/Solid/Vue (which render to light DOM).
    // Mirror the page's .ktbl rules here so they live inside this shadow root.
    styles: `
        table.ktbl { font-size: 12px; border-collapse: collapse; width: 100%; }
        table.ktbl td { padding: 2px 6px; border-bottom: 1px solid #f0f0f0; }
        table.ktbl tr.danger { background: #fee; }
        table.ktbl a { color: #2563eb; cursor: pointer; text-decoration: none; }
    `,
    data: () => ({
        items: [],
        selected: null
    }),
    methods: {
        select(id) { this.selected = id; },
        remove(id) {
            const idx = this.items.findIndex(it => it.id === id);
            if (idx >= 0) this.items.splice(idx, 1);
        }
    }
});
