# Renderer style architecture

`src/styles/index.css` is the only renderer style entry. Import order is the
public cascade contract. Existing rules remain in `src/styles.css` as bounded
legacy debt; that file may shrink but architecture tests prevent it from growing.
`src/styles/features/application-surfaces.css` is the first migrated feature
module and intentionally remains after the legacy import to preserve its former
tail-of-file cascade precedence.

New feature styles belong under `src/styles/` and must use semantic variables
provided by `ThemeProvider` (`--color-*`, `--app-*`, `--theme-*`, `--shadow-*`).
Stylelint rejects hexadecimal colors in these modules so a light-theme contrast
change always has an explicit dark-theme mapping. Interaction states must use
the same semantic foreground/surface pair for default, hover, focus, expanded,
disabled, running, and terminal states.

Motion is opt-in through an existing shared class or motion helper. Every new
animation must include a `prefers-reduced-motion` fallback and must not encode
task lifecycle truth that belongs to Runtime events.
