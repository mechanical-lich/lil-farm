# Lil Farm

A small idle farming game for the phone. You queue up work, a farmer gets on with
it, and the farm keeps running while the tab is closed — come back in the morning
and the crops have grown, the hens have laid, and the weeds are back.

Plain JavaScript, no dependencies, no build step. It's a folder of files a browser
can open.

**Play it:** https://mechanical-lich.github.io/lil-farm/

## Running it

```bash
node tools/devserver.mjs 8146
```

Then open http://localhost:8146.

Any static file server works, but use this one. It sends `Cache-Control: no-store`,
and without that the browser heuristically caches ES modules — which means a page
running a mix of old and new files, reporting errors about exports that plainly
exist. That cost hours more than once.

The service worker is skipped on localhost for the same reason. Append `?sw=1` to
test the installable build.

## Tests

```bash
npm test
```


## Credits

Art by [Kenney](https://kenney.nl) (CC0)
Tiny Creatures by Clint Bellanger (CC0)
Random additions by Mechanical Lich (CC0)
