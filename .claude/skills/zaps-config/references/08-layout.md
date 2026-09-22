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
- Each non-detached service gets its own **vertical split pane in the `@tui` window** (split off the `@tui` pane via `split-window -v`)
- Focus defaults to `@tui`

## Recommended Layout

For a new custom layout, place `@tui` at the top left and focus it. Give the left column 60% of the terminal and give `@tui` 60% of that column's height. Put the main app below it and supporting services in the right column.

```ts
layout: {
  direction: "columns",
  children: [
    {
      direction: "rows",
      size: "60",
      children: [
        { pane: "@tui", size: "60", focus: true },
        { pane: "app", size: "40" },
      ],
    },
    {
      direction: "rows",
      size: "40",
      children: [
        { pane: "database" },
        { pane: "mail" },
        { pane: "database-ui" },
      ],
    },
  ],
}
```

Result:

```
┌──────────────────┬────────────┐
│      @tui        │  database  │
│                  │────────────│
│──────────────────│    mail    │
│       app        │────────────│
│                  │database-ui │
└──────────────────┴────────────┘
```

Optional or unavailable services are removed from the layout and the remaining panes reflow. Non-autostart services use lazy panes by default, so their pane appears when started and disappears after an explicit stop.
