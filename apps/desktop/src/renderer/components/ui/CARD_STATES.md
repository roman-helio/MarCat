# Card states

MarCat uses one lifecycle language for entity cards, list rows and board columns.

## Anatomy

1. The 4 px left spine communicates lifecycle state. It stays visible in cards, compact cards and stateful list rows.
2. The state badge repeats the same tone in text, so color is never the only signal.
3. The card surface stays neutral. Priority, deadline, platform, fit, price and other domain signals belong to metadata and never recolor the whole card.
4. Optional metadata may differ by entity type; the shared shell, state semantics and interaction behavior may not.

## Tones

| Tone             | Meaning                                    | Typical mappings                                                            |
| ---------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| Neutral / grey   | Passive, unstarted or merely recorded      | task to do, creator candidate/contacted, festival not started               |
| Info / blue      | Work is actively moving                    | task in progress, festival materials/submitted, source syncing              |
| Warning / yellow | A new decision or response needs attention | creator replied, festival replied, open comment                             |
| Success / green  | Desired outcome reached                    | task done, agreed/published creator, approved festival, healthy source      |
| Danger / red     | Progress is stopped or failed              | blocked/cancelled task, cancelled outreach, rejected festival, source error |

## Interaction

- Interactive cards use the shared `CardSurface`: 10 px radius, neutral surface, layered shadow, visible keyboard focus and 0.96 press scale.
- Compact cards use an 8 px radius with the same state spine.
- Dragging changes opacity only. Selection uses the accent focus ring; neither creates a new lifecycle color.
- Numeric metrics use tabular numerals. Titles use balanced or pretty wrapping when they may wrap.
- Category colors such as a platform or project color are allowed as small dots or badges, never as the lifecycle spine.

## Cross-view consistency

- Board cards and list rows use the same order: state, primary title, then domain metadata. A board column may repeat the state, but it never replaces the state badge on the card.
- The same metric uses one component and one scale in every view. In particular, creator Fit is always a labelled, tabular badge with the same thresholds in lists, boards and drawers.
- Dense list rows follow the task-list rhythm: 36 px header, at least 40 px rows, a 4 px state spine, status near the leading edge and a trailing open affordance.
- Board columns have a stable minimum width. Titles may truncate; numeric metrics and state badges never shrink or overflow.
- Entity drawers use a responsive two-column grid at 800 px: editable content and history in the flexible main column, compact state and metrics in the 272 px side column. Below the breakpoint the columns stack in reading order.
