# 🎮 Tank CTF — Multiplayer 2D Capture the Flag

A LAN multiplayer 2D tank game played in the browser. Two teams battle in a maze-like arena with indestructible walls, shooting bullets that bounce off walls up to 5 times. Capture the enemy flag and return it to your base to score!

## Quick Start

### 1. Build the C++ engine
```bash
cd engine && make
```

### 2. Install Python dependencies
```bash
pip install -r server/requirements.txt
```

### 3. Start the server
```bash
python3 server/server.py
```

### 4. Play!
Open `http://localhost:8080` in your browser and click **JOIN GAME**.

Share the URL shown in the terminal with other players on your network.

## Controls

| Key / Action | Effect |
|---|---|
| **W** | Move forward |
| **A** | Rotate left |
| **S** | Move backward |
| **D** | Rotate right |
| **Mouse** | Aim turret |
| **Left Click** | Shoot |

## Rules

- **2 teams** (Red vs Blue), auto-assigned on join
- Bullets **bounce off walls 5 times** (perfectly elastic), then disappear
- Hit by a bullet → respawn at base after 2 seconds
- Drive over enemy flag to **pick it up**
- Return enemy flag to your base → **score +1**
- If the flag carrier dies, the flag **drops** at their location
- Teammates can return a dropped friendly flag by touching it
- **First to 3 captures wins!**

## Architecture

```
Browser (HTML5 Canvas + JS)
    ↕  WebSocket
Python Server (asyncio + websockets)
    ↕  ctypes FFI
C++ Engine (.so) — physics, collision, game state
```
