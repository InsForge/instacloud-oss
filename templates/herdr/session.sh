#!/bin/bash
# ttyd runs this once per browser connection.
#
# The browser lands in herdr rather than in a bash prompt someone would have to know to type
# `herdr` into: herdr is the whole point of the box, and it is also what makes the session survive
# the browser. Its first run spawns a setsid-detached server that owns every pane, so closing the
# tab leaves the work running and the next connection reattaches to it. A reload IS the reattach.
cd "$HOME" || cd /

herdr
status=$?

# Exiting is normal: `ctrl+b q` detaches and `q` quits the client, both leaving the server and its
# panes alive. Handing the session a shell afterwards means a detach does not look like a broken
# terminal, reattaching is one word, and a herdr that failed to start leaves its reason on screen
# instead of taking it down with the websocket.
echo
echo "herdr client exited (status $status). panes keep running in the background server."
echo "run 'herdr' to reattach, or 'exit' to close this terminal session."
exec bash -l
