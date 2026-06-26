# Layout — LayoutNode Tree

## LayoutNode Type

Layout is a recursive tree of two node types:

- **LayoutLeaf** — references a single pane (`pane`, optional `size`, optional `focus`)
- **LayoutSplit** — splits space into `rows` or `columns` with `children: LayoutNode[]` (optional `size`)

```ts
export interface LayoutLeaf {
  pane: string;
  size?: string;
  focus?: boolean;
}
export interface LayoutSplit {
  direction: "rows" | "columns";
  children: LayoutNode[];
  size?: string;
}
export type LayoutNode = LayoutLeaf | LayoutSplit;
```

## Direction

- `"rows"` — children stack **top to bottom**
- `"columns"` — children stack **left to right**

## @tui Special Pane

`@tui` is the ZAPS interactive dashboard pane. Every layout **must** include it.

- If no custom layout is provided, `@tui` is auto-added

## Size

Percentage string representing portion of parent split.

```ts
{ pane: "server", size: "70" }  // 70% of parent
{ pane: "@tui", size: "30" }    // 30% of parent
```

**Gotcha**: `size` is a **string**, not a number.

## Focus

`focus: true` on a leaf sets that pane as the initially focused pane.

Defaults to `@tui` if no pane has `focus: true`.

```ts
{ pane: "server", focus: true }
```

## Validation Rules

1. Every pane name must reference an existing service or `@tui`
2. **Detached services must NOT appear in layout** — throws: `"Detached service '<name>' cannot appear in the layout — detached services run pane-less."`

## Default Layout

When no `layout` is specified, ZAPS auto-generates:

- `@tui` gets the main pane
- Each non-detached service gets its own **background tmux window** (not a split in the `@tui` view)
- Focus defaults to `@tui`

## Example — Nested Layout

```ts
layout: {
  direction: "columns",
  children: [
    {
      direction: "rows",
      size: "70",
      children: [
        { pane: "server", size: "50" },
        { pane: "watcher", size: "50" },
      ],
    },
    { pane: "@tui", size: "30", focus: true },
  ],
}
```

Result:

```
┌──────────────┬──────┐
│   server     │      │
│──────────────│ @tui │
│   watcher    │      │
└──────────────┴──────┘
```

Outer split is `columns` (left/right). Left column splits into `rows` (top/bottom) with `server` and `watcher`. Right column is `@tui` at 30% width.
