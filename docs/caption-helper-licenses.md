# Minimal caption helper: notices and release evidence

The caption helper is assembled from the pinned official `yt-dlp` Python wheel,
CPython, an unmodified PyInstaller bootloader/runtime, and the explicitly pinned
`certifi` CA bundle. It is a Coconut build, not the upstream all-dependencies
`yt-dlp_macos` release executable. The build must not use that executable's
third-party inventory as its own, or assume that `--no-deps` alone proves the
contents of a frozen application.

This document records the licensing inputs and required release checks. It is
not a claim that an uninspected executable is cleared for redistribution. The
final native-architecture inventory, tests and packaged notices are the evidence
for each release.

## Pinned components

- **yt-dlp 2026.08.19**: upstream source is under the Unlicense. Keep
  `LICENSE.yt-dlp`. The [pinned upstream license][yt-license] is distinct from the
  licenses of optional packages that upstream's complete binary includes.
- **PyInstaller 6.22.3**: `COPYING.PyInstaller` is the complete upstream license,
  including GPL-2.0-or-later, its bootloader exception, Apache-2.0 and MIT texts.
  The [exception][pyinstaller-license] covers the embedded bootloader and loader
  combination, not arbitrary modifications or separate distribution of the
  bootloader. Runtime hooks and additional runtime modules are Apache-2.0. Keep
  the original files unmodified and preserve their notices. The accompanying
  `LICENSE.PyInstaller-zlib` covers the bootloader's vendored zlib code.
- **CPython 3.14.8**: `LICENSE.Python` preserves the PSF and historical licenses;
  `PYTHON-THIRD-PARTY-LICENSES.rst` preserves the upstream third-party notices.
  CPython labels that third-party list incomplete. `CPYTHON-BUNDLED-NOTICES.txt`
  additionally reproduces the source copyright/license blocks for the bundled
  HACL*/Karamel and mimalloc code. `LICENSE.HACL-Apache-2.0` and `LICENSE.expat`
  retain further exact upstream texts. This packaging changes the selection and
  layout of distributed Python files, freezes modules and may narrow universal2
  binaries to the target architecture; Coconut makes no source changes to
  CPython, its bundled libraries or PyInstaller's bootloader/runtime.
- **certifi 2026.7.22**: this is an explicit dependency, installed independently
  of yt-dlp extras. Keep `LICENSE.certifi` and the complete `LICENSE.MPL-2.0`.
  Its unmodified source archive, including the exact `cacert.pem`, is distributed
  in `sources/certifi-2026.7.22.tar.gz` alongside the notices. The final build
  must verify that the packaged CA data matches that archive. Its purpose is
  verifiable HTTPS on a Mac without a user-installed Python certificate store;
  never disable certificate verification as a fallback.

All these files live in `desktop/vendor/caption-helper-notices/`.
`sources.json` records each file's exact source URL, archive member where
applicable, SHA-256 and any extraction method. Verbatim license files have not
been paraphrased. Extracted source comments retain their source paths.

## Exact Python distribution matters

The inspected build input is the official standard-GIL universal2
`python-3.14.8-macos11.pkg`, included in the
[actions/python-versions 3.14.8-36806082737 release][python-actions]. The Actions
macOS builder uses the python.org installer for Python >=3.11; its older
Homebrew/source-build branch must not be mistaken for this runtime. A version
number alone is insufficient to identify a rebuilt or cached distribution.

`python-runtime-input.json` records the inspected Actions archive and inner
installer sizes and SHA-256s, plus the CPython source archive identity. The
installer SHA-256 is
`507fc086c5c006ff875d344a75b4e67b8fb3c401f1bc4908c6250adb673d4907`.
These are content measurements; native CI must establish that the runtime it
actually uses is the approved distribution. Preserve its provenance, and verify
the python.org installer signature when installing the package directly.

The installer contains more than the helper should ship. Its declared component
versions and direct Mach-O dependencies were inspected; they are not a final
helper SBOM. The relevant native components are:

| Component | Version in installer | How it may enter the helper | Notice |
| --- | --- | --- | --- |
| OpenSSL | 3.5.9 | `_ssl`, `_hashlib`, `libssl.3.dylib`, `libcrypto.3.dylib` | `LICENSE.OpenSSL` |
| XZ/liblzma | 5.2.3 | Statically linked into `_lzma` | `COPYING.XZ` |
| libmpdec | 4.0.1 | Statically linked into `_decimal` | `COPYRIGHT.libmpdec` |
| SQLite | 3.50.4 | Statically linked into `_sqlite3` | `NOTICE.SQLite` |
| Zstandard | 1.5.7 | `_zstd`, `libzstd.1*.dylib` | `LICENSE.Zstandard` (BSD option) |
| Expat | CPython vendored revision | `pyexpat`/`_elementtree` | `LICENSE.expat` |
| HACL*/Karamel and mimalloc | CPython vendored revisions | Hash modules / interpreter | `CPYTHON-BUNDLED-NOTICES.txt` and Python notices |

The minimal profile should exclude unused optional modules, especially
`tkinter`, `_tkinter`, `readline`, `curses`, `_curses`, `_curses_panel` and their
native dependencies. SQLite/browser-cookie support, decimal, LZMA and Zstandard
may be excluded only when imports and the required extraction path still pass.
The notice directory deliberately retains the candidate XZ/libmpdec/SQLite/
Zstandard notices; this does not assert that those components are in every
helper. `COPYING.XZ` describes the upstream source distribution's different
parts; only liblzma is a candidate here, not its GPL command-line utilities.

Tcl, Tk and ncurses are not approved helper components. If they appear, fail the
build rather than treating their presence in the Python installer as permission
to include them. The inspected Python extensions use macOS system zlib, bzip2
and libffi; system-linked libraries must remain system dependencies, not be
silently copied into the helper. Any other distribution/platform needs a new
native inventory and corresponding notices.

## Build and final-artifact gates

The build/release implementation must enforce the following, not merely print a
successful `pip freeze` or a binary version:

1. **Pin inputs.** Require the selected CPython distribution/version and every
   wheel/build dependency version, download URL and SHA-256. Build in an isolated
   environment. Install yt-dlp without extras and add only certifi explicitly.
   Archive the build recipe, dependency lock, source identities and build logs.
2. **Inspect frozen code.** Check PyInstaller's Analysis/PYZ/archive inventory,
   resolving modules to approved input files. Allow only CPython standard
   library, yt-dlp, certifi and the specified PyInstaller runtime modules in the
   executable. Build-only packages such as setuptools, packaging, altgraph,
   macholib and hook tooling do not become approved runtime packages merely
   because they were used to build it. Reject unapproved dependencies, plugins,
   a second Python distribution and unexpected runtime hooks. Explicitly ensure
   mutagen, curl_cffi, requests, urllib3, websockets, Crypto/Cryptodome, brotli,
   secretstorage, yt_dlp_ejs, browser-cookie tooling and executable JS runtimes
   are absent. No ffmpeg/ffprobe or download/ASR fallback is part of this helper.
3. **Inspect all native code.** Examine every Mach-O executable, extension,
   framework and dylib; recursively resolve load commands. Reject unexpected
   architecture slices, absolute build-machine dependencies, unapproved copied
   libraries and unresolved loader paths. Approve exact library provenance and
   version, not just an ABI basename such as `libcrypto.3.dylib`. Track static
   libraries through the source/build recipe and extension inventory: a clean
   dylib list does not prove absence of liblzma, libmpdec or SQLite.
4. **Preserve and verify notices/source.** Verify `sources.json` hashes; include
   the entire notice directory in each final app/archive, outside an opaque
   executable. Keep the certifi source archive and source-access notice below
   accessible to recipients. Compare the frozen certifi Python modules and
   `cacert.pem` with the pinned source/wheel. Any modifications require retained
   notices and the applicable updated source, not this unchanged-source claim.
5. **Bind evidence to the shipped bytes.** Generate a per-architecture inventory
   with paths, components, versions, hashes, licenses and source references.
   Verify the extracted final app/ZIP rather than only a staging directory.
   Record the helper hash, app/release hash and exact source commit alongside
   import, HTTPS/certificate, extraction and network-boundary tests. A smoke test
   alone is not an inventory review.
6. **Fail closed.** New libraries, modules, runtime provenance, source changes,
   missing licenses/source archives or hash mismatches must block release until
   reviewed. Do not switch to upstream's full executable to get a green build.

These gates are the release requirements; the existence of this document and
its vendored texts does not mean every gate has run. CI and the release's
inventory report must state which have passed for the final commit and bytes.

## Recipient source-access notice

The certifi component is provided under Mozilla Public License 2.0. Its complete,
unmodified Source Code Form is included with these notices at
`sources/certifi-2026.7.22.tar.gz`. The exact upstream download URL and SHA-256 are
also in `sources.json`. Recipients may use, modify and redistribute that covered
source under MPL-2.0. The license text is in `LICENSE.MPL-2.0`. No Coconut term is
intended to restrict rights granted for that component.

For the other components, `sources.json`, `python-runtime-input.json` and the
build lock provide pinned source/artifact references. Keep those references
available with published builds. This minimal profile's recorded notices and
PyInstaller exception should not be replaced by an unsupported blanket claim
that all of Coconut is GPL, or that every possible helper dependency is
permissive. If a different build introduces GPL/LGPL code or modifies
exception-covered files, assess its actual obligations and deliver the required
source/relinking materials before release. An upstream project's offer to
provide source is not automatically Coconut's own compliant source delivery.

[yt-license]: https://raw.githubusercontent.com/yt-dlp/yt-dlp/2026.08.19/LICENSE
[pyinstaller-license]: https://raw.githubusercontent.com/pyinstaller/pyinstaller/v6.22.3/COPYING.txt
[python-actions]: https://github.com/actions/python-versions/releases/tag/3.14.8-36806082737
