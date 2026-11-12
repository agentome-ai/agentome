# Brand

The Agentome logo: a reconstruction in vector of the reference image, with the mark as two
shapes (its body and its fold) and the name as outlines.

| File                                      | Use                                                 |
| ----------------------------------------- | --------------------------------------------------- |
| `logo-light.svg`, `logo-dark.svg`         | The mark and the name: dark on light, light on dark |
| `logo-*-mono.svg`                         | The same in one colour                              |
| `symbol-*.svg`                            | The mark alone                                      |
| `app-icon-dark.svg`, `app-icon-light.svg` | The mark on a plate, for icons                      |
| `tokens.json`                             | Colours                                             |

In the product: `apps/web/src/ui/logo.tsx` draws `logo-light.svg` with its colours from the
`--brand-*` tokens, so one drawing serves both themes; `apps/web/public/icon.svg` is
`app-icon-dark.svg`; the phone's PNG icons are rendered from it without the plate's corners,
which the phone rounds itself, and the maskable one with the mark inside Android's safe zone.
