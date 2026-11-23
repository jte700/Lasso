# Lasso website avatar kit

The same silhouette, colours and expressions as the comparison sheet. The default component has no dependencies, network requests or build step. It renders static SVG expressions; it does not animate or track the pointer. The optional native renderer provides those behaviours.

## Plain HTML / JavaScript

Copy this folder into your site. Serve it over HTTP (ES modules do not generally work from file://). To preview locally, run `python3 -m http.server 8000` inside this folder, then visit http://localhost:8000.

```html
<div id="lasso"></div>
<script type="module">
  import { mountLasso } from './lasso-avatar.js';
  const avatar = mountLasso(document.querySelector('#lasso'), {
    palette: 'forest', expression: 'idle', size: 128
  });
  // Call these when your app's state changes:
  avatar.update({ expression: 'thinking' });
  // avatar.update({ expression: 'happy' });
  // avatar.update({ palette: 'lime' });
  // avatar.destroy();
</script>
```

Expressions: `idle`, `thinking`, `happy`.
Palettes: `forest`, `lime`, `sage`, `rope`, `terracotta`, `ink`.
Options: `palette`, `expression`, `size` in pixels, `color`, `eyeColor`, accessible `label`.
Colours accept `#RGB` or `#RRGGBB`. Custom colours override the palette until you reset them with `color: null, eyeColor: null`.

## No JavaScript

All 18 combinations are in `svg/`. Example:

```html
<img src="./svg/forest-happy.svg" width="128" height="128" alt="Lasso is happy">
```

## Animated avatar with pointer tracking

For a bundled site (Vite, Next.js, etc.), install the original engine:

```sh
npm install open-bot-avatar@0.2.1
```

```js
import { mountAnimatedLasso } from './animated-lasso.js';
const host = document.querySelector('#lasso');
host.style.width = '128px';
host.style.aspectRatio = '1';
const avatar = mountAnimatedLasso(host, { palette: 'forest', mood: 'idle' });
avatar.update({ mood: 'thinking' });
// avatar.update({ mood: 'happy' });
// avatar.update({ color: '#d4f75c', eyeColor: '#20281b' });
// avatar.destroy();
```

The animated engine uses `mood`; the dependency-free static component uses `expression`. Animation respects system reduced-motion preferences. In React, mount inside an effect and call `destroy()` in its cleanup. In server-rendered frameworks, mounting must run on the client.

Geometry is exported separately in `lasso-definition.js` for direct use with the original engine. Generated renderer geometry and the optional animation integration use Open Bot Avatar by Dominik Scholz, MIT licensed. Preserve LICENSE.open-bot-avatar when redistributing this kit.
