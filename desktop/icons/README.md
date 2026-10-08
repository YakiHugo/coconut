# Coconut original B: one source, generated package icons

The sole checked-in image source is `reader/coconut-mark.png`, the approved
396 × 396 RGBA original-B crop. The desktop build reuses it directly. Do not
commit duplicate masters, ICNS, ICO or other generated icon binaries.

## Provenance

SHA-256:

| Original asset | Digest |
| --- | --- |
| `yakitori-coconut-visual-directions.png` comparison board, 1536 × 1024 | `3c7d836ab3bbb00a0ed702da6f7114c54b3978d1d836a3c0992bf4ee91fbcf35` |
| `coconut-original-b-source-crop.png`, 396 × 396, board crop `[624, 528, 1020, 924)` | `745293465121cea471fa67ecc576fb32b5a235909a2478aacfd0e1d688e6d3ff` |
| `coconut-original-b-native-rgba.png`, identical to `reader/coconut-mark.png` | `921df977931a7aba1b24bb98a5d8962489f904cc0076aa25d24b1b3754d7b55f` |
| Previously reviewed 1024px PNG file, retained as a provenance reference only | `60d7d8800e17acc5eea43e164a4adab9135973e44c4aeef625ed548d721730d2` |
| Raw RGBA pixels of that 1024px image | `b92ce52eec47b5149d44431edc4ed843ce95f02164be5f36e64685fd152ca45c` |

The prior extraction retained the native crop's RGB pixels and applied an
outer-boundary alpha matte. Its 1024px master was a Lanczos upscale, not native
high-resolution/vector artwork. The build does not redraw, recolor, recrop or
change that extraction. Its Node-only reconstruction reproduces **every RGBA
channel value** of the approved 1024px image, including transparency and hidden
RGB. This uses 8-bit premultiplication, separable Lanczos-3 with signed 22-bit
coefficients, per-axis rounding/clipping and 8-bit unpremultiplication. PNG
compression differs from the prior PNG file; all decoded pixels are identical.

The original full board and crop are provenance references, not files shipped
with the application. The existing web image stays byte-for-byte unchanged.

## Rebuild and verify

From a clean checkout, with Node.js 22+ and no additional dependencies:

```sh
node scripts/generate-app-icons.mjs
node scripts/generate-app-icons.mjs --check
node --test tests/desktop-icons.test.mjs
```

Equivalent desktop commands: `npm run icons:generate --prefix desktop` and
`npm run icons:check --prefix desktop`. The default output directory is ignored
`desktop/icon-build/`; `--output=/absolute/directory` selects another build
folder. Check-only mode requires generated files, checks every byte and never
repairs or writes files. Tests also exercise an otherwise empty source-only
checkout, so CI does not rely on pre-generated images.

Generated files are `coconut-icon.png` (1024px), `coconut.icns` (16–1024px,
including all eleven previously reviewed standard/Retina representations) and
`coconut.ico` (16, 32, 64, 128 and 256px). Smaller images retain the reviewed
integer area downsampling with premultiplied alpha. Generation checks the source
file hash and independent approved raw-RGBA hashes for **every** resolution.
All smaller PNG entries and the entire ICO remain byte-identical to the reviewed
candidate. The ICNS 1024px entry and standalone PNG share identical generated
bytes, with exactly the approved 1024px RGBA pixels. No resolution or quality is
removed to reduce repository size.

## Packaging and signature boundary

Packaging always generates and checks fresh files in its private temporary
build directory before calling `@electron/packager`. macOS receives ICNS via
`icon` and `CFBundleIconFile = coconut.icns`; Windows receives ICO. All packages
include the 1024px PNG as `resources/coconut-icon.png` (macOS:
`Contents/Resources/coconut-icon.png`) for `BrowserWindow.icon`. Development uses
`reader/coconut-mark.png` directly, so starting Electron from a clean checkout
does not require an icon-generation step. macOS development sets its Dock icon;
packaged macOS uses the signed bundle icon.

Package verification independently derives expected bytes from the checked-in
source, without trusting generated files on disk. It verifies the copied PNG
and macOS ICNS/metadata **before** the existing final inside-out development
signature. Nothing in the bundle is written afterward. The native macOS ZIP
signature proof checks both architectures' exact extracted icon bytes/metadata
and proves that changing ICNS invalidates the seal. Native proof remains a
macOS CI requirement; Linux tests do not assert Developer ID signing,
notarization or Gatekeeper acceptance.

Implementation references:
- [Electron Packager icon API](https://electron.github.io/packager/main/interfaces/Options.html#icon), checked against installed 20.3.0 `dist/types.d.ts` and `dist/mac.js`.
- [Pillow 12.3.0 resampling](https://github.com/python-pillow/Pillow/blob/12.3.0/src/libImaging/Resample.c) and [alpha conversion](https://github.com/python-pillow/Pillow/blob/12.3.0/src/libImaging/Convert.c), used to establish numerical compatibility with the approved master. Pillow is not a build/runtime dependency.
