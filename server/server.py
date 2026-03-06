"""
Tank CTF — Python WebSocket game server (v3 — Lobby, Timer, Share Link)

Loads the C++ game engine via ctypes, manages lobby, relays settings,
and bridges WebSocket clients to the engine. Serves static web files.

Usage:
    python server.py
    Open http://localhost:8080
"""

import asyncio
import ctypes
import json
import os
import pathlib
import socket
import http
import http.server
import threading
import sys

try:
    import websockets
    from websockets.asyncio.server import serve as ws_serve
except ImportError:
    print("ERROR: 'websockets' package required.  pip install websockets")
    sys.exit(1)

# ─── Paths ───────────────────────────────────────────────────────────────────

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENGINE_PATH = ROOT / "engine" / "libgame_engine.so"
WEB_DIR = ROOT / "web"

if not ENGINE_PATH.exists():
    print(f"ERROR: Engine not found at {ENGINE_PATH}")
    print("  Build: cd engine && make")
    sys.exit(1)

# ─── Load C++ Engine ─────────────────────────────────────────────────────────

lib = ctypes.CDLL(str(ENGINE_PATH))

lib.engine_init.argtypes = []
lib.engine_init.restype = None

lib.engine_add_player.argtypes = []
lib.engine_add_player.restype = ctypes.c_int

lib.engine_remove_player.argtypes = [ctypes.c_int]
lib.engine_remove_player.restype = None

lib.engine_set_input.argtypes = [
    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    ctypes.c_int, ctypes.c_int, ctypes.c_float,
]
lib.engine_set_input.restype = None

lib.engine_tick.argtypes = [ctypes.c_float]
lib.engine_tick.restype = None

lib.engine_get_state.argtypes = [ctypes.c_char_p, ctypes.c_int]
lib.engine_get_state.restype = ctypes.c_int

lib.engine_get_player_team.argtypes = [ctypes.c_int]
lib.engine_get_player_team.restype = ctypes.c_int

lib.engine_get_num_teams.argtypes = []
lib.engine_get_num_teams.restype = ctypes.c_int

lib.engine_set_config.argtypes = [ctypes.c_int, ctypes.c_float]
lib.engine_set_config.restype = None

lib.engine_start_game.argtypes = []
lib.engine_start_game.restype = None

lib.engine_restart.argtypes = []
lib.engine_restart.restype = None

TEAM_NAMES = ['Red', 'Blue', 'Green', 'Yellow']

# ─── State ───────────────────────────────────────────────────────────────────

STATE_BUF_SIZE = 1024 * 64
state_buf = ctypes.create_string_buffer(STATE_BUF_SIZE)

players = {}       # websocket -> player_id
TICK_RATE = 60
PORT_WS = 8765
PORT_HTTP = 8080

# ─── HTTP Server ─────────────────────────────────────────────────────────────

class GameHTTPHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)
    def log_message(self, format, *args):
        pass

def start_http_server():
    httpd = http.server.HTTPServer(("0.0.0.0", PORT_HTTP), GameHTTPHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd

# ─── WebSocket Handler ───────────────────────────────────────────────────────

async def handle_client(websocket):
    player_id = lib.engine_add_player()
    if player_id < 0:
        await websocket.send(json.dumps({"error": "Server full (max 8 players)"}))
        await websocket.close()
        return

    team = lib.engine_get_player_team(player_id)
    num_teams = lib.engine_get_num_teams()
    players[websocket] = player_id

    await websocket.send(json.dumps({
        "type": "welcome",
        "id": player_id,
        "team": team,
        "num_teams": num_teams,
        "server_ip": local_ip,
        "port": PORT_HTTP,
    }))

    tname = TEAM_NAMES[team] if team < len(TEAM_NAMES) else str(team)
    print(f"  Player {player_id} joined (team {tname}). Total: {len(players)}")

    try:
        async for message in websocket:
            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")

            if msg_type == "input":
                lib.engine_set_input(
                    player_id,
                    int(data.get("up", 0)),
                    int(data.get("down", 0)),
                    int(data.get("left", 0)),
                    int(data.get("right", 0)),
                    int(data.get("shoot", 0)),
                    ctypes.c_float(float(data.get("turret", 0.0))),
                )
            elif msg_type == "start":
                # Any player can start (when 2+ players present)
                lib.engine_start_game()
                print("  ▶ Game started!")

            elif msg_type == "restart":
                lib.engine_restart()
                print("  ↻ Game restarted → lobby")

            elif msg_type == "config":
                bounces = int(data.get("bounces", 8))
                duration = float(data.get("duration", 0))
                lib.engine_set_config(bounces, ctypes.c_float(duration))
                print(f"  ⚙ Config: bounces={bounces}, duration={duration}s")

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        lib.engine_remove_player(player_id)
        del players[websocket]
        print(f"  Player {player_id} left. Total: {len(players)}")

# ─── Game Loop ───────────────────────────────────────────────────────────────

async def game_loop():
    dt = 1.0 / TICK_RATE

    while True:
        lib.engine_tick(ctypes.c_float(dt))

        length = lib.engine_get_state(state_buf, STATE_BUF_SIZE)
        state_json = state_buf.value[:length].decode("utf-8")

        if players:
            msg = '{"type":"state","data":' + state_json + '}'
            tasks = []
            for ws in list(players.keys()):
                try:
                    tasks.append(ws.send(msg))
                except Exception:
                    pass
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

        await asyncio.sleep(dt)

# ─── Get local IP ────────────────────────────────────────────────────────────

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

local_ip = get_local_ip()

# ─── Main ────────────────────────────────────────────────────────────────────

async def main():
    print("=" * 58)
    print("  🎮  TANK CTF — Multiplayer Game Server")
    print("=" * 58)

    lib.engine_init()
    print("  ✓ C++ game engine initialized")

    start_http_server()
    print(f"  ✓ Web server:  http://{local_ip}:{PORT_HTTP}")
    print(f"  ✓ Localhost:   http://localhost:{PORT_HTTP}")

    async with ws_serve(handle_client, "0.0.0.0", PORT_WS):
        print(f"  ✓ WebSocket:   port {PORT_WS}")
        print()
        print(f"  Share this link with LAN players:")
        print(f"  →  http://{local_ip}:{PORT_HTTP}")
        print()
        print("  Waiting for players to join the lobby...")
        print("-" * 58)
        await game_loop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n  Server stopped.")
