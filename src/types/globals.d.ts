// globals.d.ts — the ambient `Deezul` that component sources use.
//
// Hand-written, unlike everything else under types/: `Deezul.Component` is read by the
// compiler and never exists at runtime, so there is no JSDoc for tsc to generate from.
// The `types` script copies this file next to the generated declarations and points the
// package's type entry at it, so an app gets it by installing deezul.
//
// WHY THIS FILE EXISTS
// A component source never imports anything -- the compiler reads
// `Deezul.Component({...})` and emits a plain data module -- so `Deezul` is a free name
// that an editor would otherwise flag. Worse, inside methods, computed getters, watchers
// and lifecycle hooks, `this` is not the object literal that was written: it is the
// assembled INSTANCE -- the properties `data()` returned, the sibling methods, and each
// computed's RETURN VALUE rather than its getter. TypeScript cannot infer that from a
// literal, so every `this.whatever` reads as a missing property.
//
// `ThisType<T>` is the marker that corrects it. It requires `noImplicitThis`, so an app
// checking its JavaScript wants that on:
//
//     { "compilerOptions": { "checkJs": true, "noImplicitThis": true } }
//
// PROPS have no separate declaration: the runtime does
// `Object.assign(component.data, props)`, so a prop lands in the data bag. Declare it in
// `data()` with a default, which types it and documents the value used when a parent
// omits it.

type DzFn = (...args: any[]) => any;

/** A computed's value is what its getter returns, and is read-only from outside. */
type DzComputedValues<C> = {
    readonly [K in keyof C]: C[K] extends (...args: any[]) => infer R ? R : never;
};

/** What `this` is inside a component's methods, computed getters and hooks. */
type DzInstance<D, M, C> = D & M & DzComputedValues<C> & {
    /** Dispatch a CustomEvent from this component's host element. */
    $emit(event: string, payload?: any): void;
    /** Elements carrying a ref in this component's template, by ref name. */
    $refs: Record<string, HTMLElement>;
};

interface DzComponentDefinition<D, M, C> {
    /** Required. Compiled to bytecode, so it is not readable as a string at runtime. */
    template: string;
    /** Scoped into this component's shadow root. */
    styles?: string;
    /** A FACTORY, run once per instance before `this` exists -- so it takes no `this`. */
    data?: () => D;
    methods?: M;
    computed?: C;
    watch?: Record<string, (newValue: any, oldValue: any) => void>;
    /** Shared by every instance and never reactive. */
    static?: Record<string, any>;
    /** The component's public interface for the page builder. The runtime ignores it. */
    schema?: Record<string, any>;
    $created?(): void;
    $mounted?(): void;
    $updated?(): void;
    $unmounted?(): void;
    $error?(error: unknown): void;
}

declare const Deezul: {
    Component<
        D = {},
        M extends Record<string, DzFn> = {},
        C extends Record<string, DzFn> = {}
    >(
        definition: DzComponentDefinition<D, M, C> & ThisType<DzInstance<D, M, C>>
    ): DzComponentDefinition<D, M, C>;
};
