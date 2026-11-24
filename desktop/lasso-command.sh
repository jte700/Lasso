#!/bin/zsh -f
# The `lasso` terminal command inside Lasso.app (Contents/Resources/bin/lasso),
# run with the app's own Node.js, so a Mac needs nothing else installed. The
# app links it into a folder on the PATH (TerminalCommand.swift); this finds
# the app through that link.
contents=${0:A:h:h:h}
exec "$contents/MacOS/node" --disable-warning=ExperimentalWarning "$contents/Resources/app/src/cli/main.js" "$@"
