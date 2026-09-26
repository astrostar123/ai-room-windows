# AI Room

A pixel-art office for your [Claude Code](https://code.claude.com) sessions, for
**Windows and Mac**. Every project folder is a room, every session is a robot at
a desk. You can see at a glance which one is waiting on you.

![Two pixel-art rooms full of robots at desks. One robot stands at the door asking to run "npm install phaser@3 --save", with Allow and Deny buttons.](docs/screenshot.png)

## Your computer, your Claude account

- **Runs only on your own computer.** The server listens only on `127.0.0.1`,
  so other computers can't connect to it. Every request needs a secret key that
  only your Room window knows, so other websites can't talk to it either.
- **Uses only your own Claude account.** AI Room has no login of its own. It
  reads the Claude Code chats saved on your computer, and Reply / + Robot run
  the `claude` command that *you* signed in to. It never sees, stores or sends
  your password or login. ⚙ Settings shows which account is signed in.
- **Nothing is sent anywhere.** No accounts, no tracking. The page doesn't load
  anything from the internet.
- **Each person runs their own copy.** Downloading it from GitHub gives you the
  app only, with no one else's chats, settings or keys.

## What you need

- **Windows 10 or 11**, or **macOS**
- [Node.js](https://nodejs.org) 18 or newer
- [Claude Code](https://code.claude.com), in the Claude desktop app or the terminal

No `npm install` needed: it has no dependencies.

## Get it

Download it with **Code → Download ZIP** on GitHub and unzip it, or:

```bash
git clone https://github.com/astrostar123/ai-room-windows.git
```

Just want a look first? Start it, then open
[http://127.0.0.1:4777/?demo](http://127.0.0.1:4777/?demo) for a pretend office
full of robots.

## Start it

### Windows

1. Double-click **`Start AI Room.bat`**. AI Room starts quietly in the
   background and the Room opens in its own window.
2. Optional: double-click **`Create Desktop Shortcut.bat`** for a robot icon on
   your desktop.

### Mac

1. Double-click **`Start AI Room.command`**. A Terminal window flashes up, AI
   Room starts in the background, and the Room opens (in its own window if you
   have Chrome, Edge or Brave, otherwise in your normal browser).
   - If macOS says it *can't be opened*, right-click the file → **Open** →
     **Open**. You only need to do that once.
   - Or in Terminal, in this folder: `node server.js --background --open`
2. Optional: drag `Start AI Room.command` to the right side of your Dock to keep
   it handy.
3. The first time you use **Terminal** in the Room or delete a chat's history,
   macOS asks whether AI Room may control Terminal or Finder. Click **OK**.

### Both

- Once: click **Connect hooks** in the yellow banner. That unlocks instant
  updates, the Stop button, and answering permission questions from the Room.
  Sessions you already had open pick up the hooks after a restart.
- Closing the Room window doesn't stop AI Room. Starting it again just reopens
  the window. To stop it: ⚙ → **Quit AI Room**.
- If something seems wrong, look in `~/.claude/ai-room/server.log`.

## What the colours mean

| Colour | State | What the robot does |
|---|---|---|
| 🟩 Green | Working | Types away while code scrolls on its screen |
| 🟨 Amber | Your turn: it finished and you haven't looked yet | Turns around, waves, shows "?" |
| 🟥 Red | Blocked: needs permission, or hit an error | Walks to the door holding the exact command, with **Allow / Deny** |
| ⬜ Grey | Idle | Screensaver if the session is open; asleep (Zzz) if it's closed |

Amber turns grey when you click the robot, or press **All seen**.

## Room styles

![A space station room with round windows and an airlock next to a cozy office at night with hanging lamps.](docs/styles.png)

There are four styles: **Cozy office**, **Neon city**, **Space station** and
**Forest cabin**. By default every room gets its own. To change all of them, go
to ⚙ → **Room style**. To change just one room, use its **Style** button.

The windows follow the real time of day: sunny in the afternoon, stars and snow
at night. Every room has a pet, a cat or a little hover-drone, that wanders
around and naps on top of the computers.

## Things you can do

- **Click a robot** (or its row) to read the conversation and see its **Scan**:
  - the folder and branch it's working in, and what it's doing right now
  - its **helpers**: sub-agents it started, and how many are working now (working helpers also show up as tiny robots on its desk)
  - its **connections**: MCP servers and connectors it used, like the browser, GitHub or Unity, with how often it used each
  - the files it changed, its last command, and how busy it's been
- **Allow / Deny** at the door. "Ask in the app instead" sends the question back.
- **Stop**: the robot stops at its next step.
- **Reply** to any robot that isn't busy. The conversation continues in the
  background with `claude -p --resume`.
- **+ Robot** starts a new background session in that folder with a task you type.
- **Terminal** opens a terminal (Windows Terminal or Mac Terminal) running
  `claude` in that folder.
- **Remove** a robot (button in its side panel) or a whole room (the **✕** on the room).
  It just leaves the Room, so nothing is deleted, and it comes back if that chat or
  folder gets busy again. Tick the box to also move closed chats' history to the
  **Recycle Bin** (Windows) or **Trash** (Mac). Your project files are never
  touched. To bring everything back: ⚙ → **Show them all again**.
- Rooms grow with your robots: up to 4 desks per row, then a new row starts and
  the room gets taller, so nothing has to shrink.
- The **chips at the top** (blocked / your turn / working / idle) jump to the
  next robot in that state.
- ⚙ **Settings**: room style, sounds, desktop notifications, zoom, how long to
  show old sessions.

## Honest limits

- **Replying to a chat that's open in the Claude app or a terminal** runs the
  reply in the Room. That window can't be typed into from outside, so it won't
  show the new messages until you close and reopen the chat there. The Room
  asks you once before doing this. You can't reply while a robot is busy.
- **Reply and + Robot need the terminal `claude` signed in.** The Claude
  desktop app has its own login. Open a terminal, run `claude`, and type `/login`.
- **Permission questions only come to the Room while its window is on screen.**
  Otherwise the app asks as usual. If you don't answer in the Room within
  2 minutes (you can change this), the question goes back to the app.
- **Questions that need typed answers** (like Claude asking you to pick an
  option) always stay in the app. The robot still goes red so you notice.
- **Without hooks**, the Room still works by reading transcripts, but it
  updates a bit slower and can't stop other sessions or answer permissions.
- **Mac support is new.** If something doesn't work on your Mac, please open an
  issue.

## Where things live

| What | Where |
|---|---|
| This app | this folder |
| AI Room's settings, seen list, secret key, log, backups | `~/.claude/ai-room/` (on Windows: `%USERPROFILE%\.claude\ai-room\`) |
| Hooks (after Connect) | `~/.claude/settings.json`. A backup is saved before every change |

What it reads: `~/.claude/projects` (your chat transcripts) and
`~/.claude/sessions` (the list of running Claude sessions), both on your own
computer.

## Uninstall

1. ⚙ → **Disconnect hooks**. This removes only AI Room's hooks; your other
   settings stay.
2. Delete this folder and `~/.claude/ai-room`.

## How it's built (for tinkering)

No npm packages. Needs Node.js 18 or newer.

| File | Job |
|---|---|
| `server.js` | Local web server: state updates, buttons, hook events |
| `lib/transcripts.js` | Reads the end of each transcript to see what a session is doing |
| `lib/sessions.js` | Decides each robot's colour, name and room |
| `lib/scan.js` | The Scan: counts helpers, connections, files changed (reads only new transcript lines) |
| `lib/cleanup.js` | Removing robots/rooms (hidden list) and moving chat history to the Recycle Bin / Trash |
| `lib/permissions.js` | Keeps track of Allow/Deny questions |
| `lib/runner.js` | Starts `claude -p` for Reply / New robot, opens terminals and the Room window (Windows and Mac) |
| `lib/hooks-setup.js` | Adds/removes the hooks in `settings.json` |
| `hook.js` | What Claude Code runs for each hook event |
| `mcp-approve.js` | Tiny MCP tool so background robots can ask for permission |
| `public/room.js` | Draws the desks, robots and screens, and moves robots and pets around |
| `public/themes.js` | The four room styles: walls, floors, windows, doors, decorations |
| `public/sprites.js` | Robot sprites and the 3×5 pixel font |
| `public/app.js` | The page: rooms, side panel, dialogs, sounds, demo mode |
| `tools/make-icon.js` | Draws `ai-room.ico` (the Windows robot icon) |
