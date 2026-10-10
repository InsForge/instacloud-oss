# This machine

You are running on an InstaCloud compute machine deployed from the Claude Code template.

- Only the service's volume survives a restart, a redeploy or an upgrade. This template mounts it at
  `/data` and sets `HOME` to `/data/home`, so keep repositories and anything you create under `HOME`.
- Everything outside the volume is reset from the image on restart, including whatever `apt-get`
  installs. Install tools under `~/.local` instead, which is on the volume and whose `bin` is on
  `PATH`: `npm install -g --prefix ~/.local <package>`, or a Python venv under `~`
  (`python3 -m venv ~/.venvs/<name>`).
- `gh` comes from the platform toolbox at `/.insta/tools/bin` when the machine provides it. It
  reads `GH_TOKEN` when the deployer set one. Run `gh auth setup-git` once to use it for git over
  HTTPS.
- Only the terminal's port is public. A server you start here is not reachable at `localhost` from
  the user's browser. To open one, they forward it from their own machine with
  `ssh -L <port>:localhost:<port> <service>.insta`, after a one-time `insta compute ssh --setup <service>`.
- The browser terminal is a tmux session named `main`, so closing the tab does not stop what runs
  in it. The machine still stops once nobody is connected unless the service is always-on.
- The user can upload a file from their computer by dropping it on the terminal while a shell
  prompt is showing, or by running `trz` there. It lands in that shell's current directory. A
  clipboard paste of an image cannot reach this machine, so suggest this instead.
- `/usage` shows plan usage and what is consuming it.
