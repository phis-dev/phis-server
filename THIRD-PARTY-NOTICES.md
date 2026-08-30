# Third-Party Notices

phi-server is licensed under Apache-2.0 (see `LICENSE`). It depends on third-party software
under its own terms. The overwhelming majority is MIT, ISC, BSD or Apache-2.0 and imposes no
obligation beyond attribution. This file records the cases that do.

## libvips, via `sharp` — LGPL-3.0-or-later

phi-server depends on `sharp` directly and calls it at runtime: `src/lib/image-variants.ts`
generates image variants, and the upload finalize route processes every uploaded image. This
is the one third-party obligation that reaches phi-server itself, not merely its tooling.

`sharp` itself is Apache-2.0. The image processing it performs is done by **libvips 8.18.3**,
shipped as a prebuilt shared library in the platform package `@img/sharp-libvips-<platform>`
(`lib/libvips-cpp.so.8.18.3`). libvips is licensed under **LGPLv3**, as are several libraries
bundled with it: fribidi, glib, libexif, libheif, librsvg, pango and proxy-libintl. cairo is
MPL-2.0. Everything else in that bundle is MIT, BSD-like or zlib — including libimagequant,
which is used in a BSD-2-Clause fork rather than the GPL-licensed original.

phi-server uses these libraries **unmodified**, loaded dynamically at runtime through a Node
native addon. This is the case LGPL section 4 provides for, and the obligations that follow are:

- this notice, naming the libraries and their licence;
- the source of libvips remains available at <https://github.com/libvips/libvips>, and the
  prebuilt bundle at <https://github.com/lovell/sharp-libvips>;
- the library must not be modified without placing the modifications under LGPLv3;
- the recipient must remain able to replace it with their own build. Installed through npm as a
  separate package, it already is.

**Relevant when redistributing**, i.e. when a container image or a `standalone` build carries
the `.so` file. It does not apply to merely operating the service.

**Add-ons**: the above covers phi-server's own use. Separately, an Add-on that bundles `sharp`
into its own artifact takes on these obligations for that artifact — including a closed-source
one. It remains permitted; it is not free of duties. An Add-on served by the core instead, once
an image capability exists, carries none of them: libvips stays inside phi-server.

## caniuse-lite — CC-BY-4.0

Browser support data, a production dependency of `next` and `browserslist`. CC-BY-4.0 asks for
attribution and nothing else; this notice is that attribution.

Data © the caniuse contributors, <https://github.com/browserslist/caniuse-lite>.

## Build-time only

`cfonts` (GPL-3.0-or-later, via `@ant-design/cli` in phi-shared-ui) and `axe-core` (MPL-2.0, via
`eslint-config-next`) are development dependencies. They are neither linked nor distributed, so
their terms do not reach any artifact produced here.

---

`phis licenses check` walks the production dependency closure and fails on anything that is not
permissive and not accepted in `src/cli/licenses.mts`. Run it after changing dependencies, and
record whatever it turns up here before accepting it there. `--package <directory>` points it at
another repository in the workspace.
