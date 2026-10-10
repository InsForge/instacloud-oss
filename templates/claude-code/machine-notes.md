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
- Only the terminal's port is public, and the platform refuses SSH port forwarding. `-L`, `-R` and
  `-D` all come back `administratively prohibited: sshbridge: port forward refused`, because the
  certificate `insta compute ssh` issues carries `permit-pty` and nothing else. A server you start
  on another port here cannot be reached from the user's browser, and no tunnel on their side
  changes that, so do not offer to set one up. Something that has to be reachable belongs in its
  own compute service.
- The browser terminal is a tmux session named `main`, so closing the tab does not stop what runs
  in it. The machine still stops once nobody is connected unless the service is always-on.
- `/usage` shows plan usage and what is consuming it.
