The mylasso.ca website

Vercel (project lasso-website, Root Directory "website") deploys this folder whenever main is pushed.
The site that was live before the 21 November 2026 redesign is kept in ../website-previous.

To view it on a Mac: double-click "Open Lasso site.command" (if macOS blocks it, right-click it and choose Open). It opens the site at http://localhost:8765. Close the Terminal window to stop it.

Anywhere else: in this folder run  python3 -m http.server 8765  and visit http://localhost:8765.

Opening index.html directly will not work fully; the browser blocks the 3D mascot and the demos without a local server. An internet connection is needed for the fonts and the 3D mascot library. The waitlist and share links need the Vercel functions in api/, so they only work when deployed.

Card pictures and clips (assets/media) are drawn from media-src/scenes.html. To make them again after
changing a scene: start the site as above, then run  node media-src/render.mjs  (or name scenes:
node media-src/render.mjs writer loop). It needs Google Chrome and ffmpeg. media-src is not deployed (.vercelignore).
