# This machine

You are running on an InstaCloud compute machine deployed from the Claude Code template.

- Only `/data` survives a restart, a redeploy or an upgrade. `HOME` is `/data/home`, so keep
  repositories and anything you create under it.
- Everything outside `/data` is reset from the image on restart, including whatever `apt-get`
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
- `/usage` shows plan usage and what is consuming it.
