# Third-party notices

`modern-screenshot.umd.js` and `worker.js` were copied from the locally installed
`html2canvas-pro` SillyTavern extension and are derived from the
[modern-screenshot](https://github.com/qq15725/modern-screenshot) project.

The copied upstream files did not embed an exact package version. Their original
local SHA-256 values before removing missing source-map references were:

- `modern-screenshot.umd.js`: `F066CE193A8190845386C922C06F71641C87AB275E0125B5D84B4ACAE09FBD23`
- `worker.js`: `5E12C4B4BA4E6D2A76E21CDF96387840D3E526CBE545331069A5B2C4988503B6`

The exact upstream npm package version/tag could not be recovered from the local
reference files because they contain no version banner. The original and
resulting hashes below are therefore the reproducible provenance baseline.

The vendored copies only remove the two missing `sourceMappingURL` comments so
browser developer tools do not request absent `.map` files. Their resulting
SHA-256 values are:

- `modern-screenshot.umd.js`: `C877C920ABCB62D2AF60B42A8B90362452C81AB24477CDC477379AB62830D080`
- `worker.js`: `903CD245A58898D5D465158B7A1D55674C370BA0794EAC20E1B084033E6B97A7`

The worker is kept for upstream traceability, but st-toolbox intentionally does
not pass `workerUrl`: this bundled build's `destroyContext()` does not terminate
created workers, so main-thread fetching avoids leaking workers across repeated
screenshots.

## Local patch: `embedWebFont` no longer mutates page stylesheets

Upstream `embedWebFont()` fetches every `@import`ed stylesheet and calls
`styleSheet.insertRule()` on the **live document stylesheet**. In SillyTavern
(custom fonts via `#custom-style`, themes, Google Fonts) this triggers a global
style recalculation, font reloads and text reflow on every screenshot, which
shifts the chat layout ("the page jumps/refreshes when a screenshot finishes")
and accumulates duplicated rules over time.

The vendored copy instead parses the imported CSS into a detached stylesheet
(constructable `CSSStyleSheet`, falling back to a `<style>` in a document created
by `document.implementation.createHTMLDocument()`), keeps only `@font-face`
rules, and reads them from there. The page's own stylesheets are never modified.
The SHA-256 of `modern-screenshot.umd.js` therefore no longer matches the value
above; the patch is confined to the `embedWebFont` function and is marked with
`[st-toolbox patch]`.

## modern-screenshot license

MIT License

Copyright (c) 2021-present wxm

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
