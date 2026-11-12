# caju-ui vs React

2026-11-12 · headless Chromium (Playwright 1.58.2) · React 18.3.1 production build · 10 runs per operation (median, min–max), after one warm-up run · lower is better

| operation | React | caju-ui | caju-ui / React |
|---|--:|--:|--:|
| startup (load to first render) | 84.1 ms <sub>(83–90)</sub> | 91.1 ms <sub>(90–104)</sub> | 1.08× |
| create 1,000 rows | 56.0 ms <sub>(49–66)</sub> | 93.5 ms <sub>(80–121)</sub> | 1.67× |
| replace all 1,000 rows | 62.0 ms <sub>(57–72)</sub> | 93.1 ms <sub>(83–148)</sub> | 1.50× |
| partial update (every 10th) | 25.8 ms <sub>(21–30)</sub> | 29.0 ms <sub>(26–50)</sub> | 1.13× |
| select row | 2.3 ms <sub>(2–19)</sub> | 4.1 ms <sub>(3–6)</sub> | 1.76× |
| swap rows | 51.8 ms <sub>(44–58)</sub> | 55.4 ms <sub>(46–59)</sub> | 1.07× |
| remove row | 11.0 ms <sub>(10–13)</sub> | 14.6 ms <sub>(12–48)</sub> | 1.33× |
| create 10,000 rows | 672.8 ms <sub>(577–907)</sub> | 1058.2 ms <sub>(863–1492)</sub> | 1.57× |
| append 1,000 to 1,000 | 60.7 ms <sub>(54–81)</sub> | 103.9 ms <sub>(86–146)</sub> | 1.71× |
| clear 1,000 rows | 11.4 ms <sub>(10–14)</sub> | 10.2 ms <sub>(9–13)</sub> | 0.89× |
| compute (Mandelbrot 600×400×1000, CPU) | 144.6 ms <sub>(144–156)</sub> | 414.7 ms <sub>(407–422)</sub> | 2.87× |

The longest task on the page's main thread during each operation (the time the page cannot react to input; tasks under 50 ms are not reported by the browser, shown as "< 50"):

| operation | React | caju-ui |
|---|--:|--:|
| create 1,000 rows | < 50 ms | < 50 ms |
| replace all 1,000 rows | < 50 ms | < 50 ms |
| partial update (every 10th) | < 50 ms | < 50 ms |
| select row | < 50 ms | < 50 ms |
| swap rows | < 50 ms | < 50 ms |
| remove row | < 50 ms | < 50 ms |
| create 10,000 rows | 412 ms | 412 ms |
| append 1,000 to 1,000 | < 50 ms | 55 ms |
| clear 1,000 rows | < 50 ms | < 50 ms |
| compute (Mandelbrot 600×400×1000, CPU) | 144 ms | < 50 ms |

| size | React | caju-ui |
|---|--:|--:|
| code shipped (raw) | 143 KB | 784 KB |
| code shipped (gzip) | 46 KB | 105 KB |

## Notes

- Same app, same method: each time runs from the click until the DOM shows the result and the next
  frame starts (layout and paint included); for caju-ui it includes the trip to the worker and back.
- Where caju-ui's time goes (`node split.mjs`): creating 1,000 rows takes ~37 ms in the worker (the
  Caju code), ~23 ms applying the patches on the page, and the rest is layout and paint (the same as
  React's).
- The compute row runs the same Mandelbrot code in both. Outside the browser it takes 151 ms as a
  native Caju binary, 143 ms in Node (JavaScript) and 659 ms as Caju wasm in Node: Caju's wasm target
  does not yet optimize like its native one, which is where most of the gap comes from.
- The long-task table shows why the worker matters: with React the page cannot respond while a
  component computes; with caju-ui it can. For DOM-heavy work (10,000 rows) both block about the
  same, because the browser's own layout of the new rows dominates.
