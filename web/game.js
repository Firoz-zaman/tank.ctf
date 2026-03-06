/**
 * Tank CTF — Web Game Client (v3 — Lobby, Game Flow, Timer, Kills)
 *
 * Connects to the Python WebSocket server, captures input,
 * renders the game on HTML5 Canvas with neon/glassmorphism aesthetic.
 *
 * Game flow: Menu → Connect → Lobby → Countdown → Playing → Game Over → Lobby
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const MAP_W = 1200;
const MAP_H = 900;
const TANK_SIZE = 24;
const FLAG_RADIUS = 24;

const PHASE_LOBBY = 0;
const PHASE_COUNTDOWN = 1;
const PHASE_PLAYING = 2;
const PHASE_GAMEOVER = 3;

// 4-team color palette
const TEAMS = [
    { name: 'Red', pri: '#ff3b5c', dark: '#b0203a', glow: 'rgba(255,59,92,0.5)', base: 'rgba(255,59,92,0.10)', baseStroke: 'rgba(255,59,92,0.35)', bullet: '#ff6b82', bulletGlow: 'rgba(255,59,92,0.7)', icon: '🔴' },
    { name: 'Blue', pri: '#3ba0ff', dark: '#2060b0', glow: 'rgba(59,160,255,0.5)', base: 'rgba(59,160,255,0.10)', baseStroke: 'rgba(59,160,255,0.35)', bullet: '#6bc0ff', bulletGlow: 'rgba(59,160,255,0.7)', icon: '🔵' },
    { name: 'Green', pri: '#3bff6b', dark: '#1da040', glow: 'rgba(59,255,107,0.5)', base: 'rgba(59,255,107,0.10)', baseStroke: 'rgba(59,255,107,0.35)', bullet: '#6bffa0', bulletGlow: 'rgba(59,255,107,0.7)', icon: '🟢' },
    { name: 'Yellow', pri: '#ffc53b', dark: '#b08a20', glow: 'rgba(255,197,59,0.5)', base: 'rgba(255,197,59,0.10)', baseStroke: 'rgba(255,197,59,0.35)', bullet: '#ffe06b', bulletGlow: 'rgba(255,197,59,0.7)', icon: '🟡' },
];

const COL = {
    bg: '#0a0e17',
    grid: 'rgba(25, 35, 55, 0.35)',
    wallFill: '#161d2e',
    wallTop: '#1f2940',
    wallStroke: '#2a3858',
    wallGlow: 'rgba(80, 140, 255, 0.04)',
    turret: '#c8d0e0',
    turretTip: '#e8f0ff',
};

// ─── State ──────────────────────────────────────────────────────────────────

let ws = null;
let myId = -1;
let myTeam = -1;
let numTeams = 2;
let gameState = null;
let prevState = null;
let connected = false;
let serverIp = '';
let serverPort = 8080;
let currentPhase = -1;  // Track phase transitions

// Input
const keys = { up: false, down: false, left: false, right: false };
let mouseX = 0, mouseY = 0;
let shootQueued = false;

// Canvas
let canvas, ctx;
let scale = 1;
let offsetX = 0, offsetY = 0;

// Particles / effects
let particles = [];
let bulletTrails = [];
let muzzleFlashes = [];
let ambientParticles = [];
let screenShake = { x: 0, y: 0, intensity: 0 };
let time = 0;

// Previous bullet state for detecting deaths/impacts
let prevBulletCount = 0;

// ─── Ambient particle system ────────────────────────────────────────────────

function initAmbient() {
    for (let i = 0; i < 40; i++) {
        ambientParticles.push({
            x: Math.random() * MAP_W,
            y: Math.random() * MAP_H,
            vx: (Math.random() - 0.5) * 8,
            vy: (Math.random() - 0.5) * 8,
            size: 1 + Math.random() * 2,
            alpha: 0.1 + Math.random() * 0.2,
            pulse: Math.random() * Math.PI * 2,
        });
    }
}

function updateAmbient(dt) {
    for (const p of ambientParticles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.pulse += dt * 1.5;
        if (p.x < 0) p.x = MAP_W;
        if (p.x > MAP_W) p.x = 0;
        if (p.y < 0) p.y = MAP_H;
        if (p.y > MAP_H) p.y = 0;
    }
}

// ─── Connection ─────────────────────────────────────────────────────────────

function connectToServer() {
    const statusEl = document.getElementById('connection-status');
    const btnEl = document.getElementById('join-btn');

    statusEl.textContent = 'Connecting...';
    statusEl.className = 'status';
    btnEl.disabled = true;

    const wsHost = window.location.hostname || 'localhost';
    const wsUrl = `ws://${wsHost}:8765`;

    try { ws = new WebSocket(wsUrl); }
    catch (e) {
        statusEl.textContent = 'Connection failed: ' + e.message;
        statusEl.className = 'status error';
        btnEl.disabled = false;
        return;
    }

    ws.onopen = () => { statusEl.textContent = 'Connected! Joining...'; };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'welcome') {
            myId = msg.id;
            myTeam = msg.team;
            numTeams = msg.num_teams || 2;
            serverIp = msg.server_ip || window.location.hostname;
            serverPort = msg.port || 8080;
            connected = true;
            showLobby();
        } else if (msg.type === 'state') {
            prevState = gameState;
            gameState = msg.data;
            if (gameState.num_teams) numTeams = gameState.num_teams;
            handlePhaseChange();
            detectDeaths();
        } else if (msg.error) {
            statusEl.textContent = 'Error: ' + msg.error;
            statusEl.className = 'status error';
            btnEl.disabled = false;
        }
    };

    ws.onclose = () => {
        if (connected) {
            connected = false;
            showScreen('menu');
            const statusEl = document.getElementById('connection-status');
            statusEl.textContent = 'Disconnected.';
            statusEl.className = 'status error';
            document.getElementById('join-btn').disabled = false;
        } else {
            const statusEl = document.getElementById('connection-status');
            statusEl.textContent = 'Could not connect. Is the server running?';
            statusEl.className = 'status error';
            document.getElementById('join-btn').disabled = false;
        }
    };
    ws.onerror = () => {
        const statusEl = document.getElementById('connection-status');
        statusEl.textContent = 'Connection error.';
        statusEl.className = 'status error';
        document.getElementById('join-btn').disabled = false;
    };
}

// ─── Screen Management ──────────────────────────────────────────────────────

function showScreen(name) {
    document.getElementById('menu-screen').style.display = (name === 'menu') ? '' : 'none';
    document.getElementById('lobby-screen').style.display = (name === 'lobby') ? '' : 'none';
    document.getElementById('game-screen').style.display = (name === 'game') ? '' : 'none';
}

// ─── Lobby ──────────────────────────────────────────────────────────────────

let lobbyInitialized = false;

function showLobby() {
    showScreen('lobby');

    // Set share URL
    document.getElementById('share-url').textContent = `http://${serverIp}:${serverPort}`;

    // Wire up settings
    if (!lobbyInitialized) {
        const bouncesSlider = document.getElementById('setting-bounces');
        const bouncesValue = document.getElementById('bounces-value');
        bouncesSlider.addEventListener('input', () => {
            bouncesValue.textContent = bouncesSlider.value;
            sendConfig();
        });

        const durationSelect = document.getElementById('setting-duration');
        durationSelect.addEventListener('change', () => {
            sendConfig();
        });

        lobbyInitialized = true;
    }
}

function sendConfig() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const bounces = parseInt(document.getElementById('setting-bounces').value);
    const duration = parseFloat(document.getElementById('setting-duration').value);
    ws.send(JSON.stringify({ type: 'config', bounces, duration }));
}

function startGame() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'start' }));
}

function restartGame() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'restart' }));
}

function updateLobby() {
    if (!gameState) return;

    const playerList = document.getElementById('lobby-player-list');
    const tanks = gameState.tanks || [];

    if (tanks.length === 0) {
        playerList.innerHTML = '<div class="player-empty">Waiting for players...</div>';
    } else {
        let html = '';
        for (const t of tanks) {
            const team = TEAMS[t.team] || TEAMS[0];
            const isMe = t.id === myId;
            html += `<div class="player-item${isMe ? ' is-me' : ''}">
                <span class="player-dot" style="background:${team.pri}"></span>
                <span class="player-name" style="color:${team.pri}">${team.name} Tank #${t.id}</span>
                ${isMe ? '<span class="player-you">YOU</span>' : ''}
            </div>`;
        }
        playerList.innerHTML = html;
    }

    // Update player count
    const count = gameState.player_count || tanks.length;
    document.getElementById('lobby-player-count').textContent = `${count}/8`;

    // Update min players hint
    const hintEl = document.getElementById('min-players-hint');
    const startBtn = document.getElementById('start-btn');
    if (count >= 2) {
        hintEl.textContent = '✓ Ready to start!';
        hintEl.className = 'min-players-hint ready';
        startBtn.disabled = false;
    } else {
        hintEl.textContent = '⚠ Need at least 2 players to start';
        hintEl.className = 'min-players-hint';
        startBtn.disabled = true;
    }

    // Sync settings from server state
    if (gameState.max_bounces !== undefined) {
        const slider = document.getElementById('setting-bounces');
        const valEl = document.getElementById('bounces-value');
        slider.value = gameState.max_bounces;
        valEl.textContent = gameState.max_bounces;
    }
    if (gameState.duration !== undefined) {
        const select = document.getElementById('setting-duration');
        const dur = gameState.duration;
        // Find closest option
        for (const opt of select.options) {
            if (parseFloat(opt.value) === dur) {
                select.value = opt.value;
                break;
            }
        }
    }
}

// ─── Phase Handling ─────────────────────────────────────────────────────────

let canvasReady = false;

function handlePhaseChange() {
    if (!gameState) return;
    const phase = gameState.phase;

    if (phase === PHASE_LOBBY) {
        // Show lobby
        if (currentPhase !== PHASE_LOBBY) {
            showLobby();
            document.getElementById('gameover-overlay').style.display = 'none';
            document.getElementById('countdown-overlay').style.display = 'none';
        }
        updateLobby();
        currentPhase = phase;
        return;
    }

    // For all non-lobby phases, show game screen
    if (!canvasReady) {
        showScreen('game');
        canvas = document.getElementById('game-canvas');
        ctx = canvas.getContext('2d');
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
        initAmbient();

        const badge = document.getElementById('team-badge');
        const team = TEAMS[myTeam];
        badge.textContent = team.icon + ' ' + team.name.toUpperCase() + ' TEAM';
        badge.style.color = team.pri;

        buildScoreHUD();
        requestAnimationFrame(gameLoop);
        setInterval(sendInput, 1000 / 60);
        canvasReady = true;
    } else if (currentPhase === PHASE_LOBBY) {
        showScreen('game');
    }

    if (phase === PHASE_COUNTDOWN) {
        const cd = document.getElementById('countdown-overlay');
        cd.style.display = '';
        const num = document.getElementById('countdown-number');
        const secs = Math.ceil(gameState.countdown);
        if (secs <= 0) {
            num.textContent = 'GO!';
        } else {
            num.textContent = secs;
        }
        document.getElementById('gameover-overlay').style.display = 'none';
    } else {
        document.getElementById('countdown-overlay').style.display = 'none';
    }

    if (phase === PHASE_PLAYING) {
        document.getElementById('gameover-overlay').style.display = 'none';
        updateHUD();
    }

    if (phase === PHASE_GAMEOVER) {
        updateHUD();
        showGameOver();
    }

    currentPhase = phase;
}

// ─── Detect deaths for explosion effects ────────────────────────────────────

function detectDeaths() {
    if (!prevState || !gameState) return;
    for (const t of gameState.tanks) {
        const prev = prevState.tanks.find(p => p.id === t.id);
        if (prev && prev.alive && !t.alive) {
            spawnExplosion(t.x, t.y, TEAMS[t.team]?.pri || '#fff', true);
            if (t.id === myId) { screenShake.intensity = 8; }
        }
    }
}

// ─── Show Game Screen ───────────────────────────────────────────────────────

function buildScoreHUD() {
    const container = document.getElementById('hud-left');
    container.innerHTML = '';
    for (let i = 0; i < numTeams; i++) {
        const div = document.createElement('div');
        div.className = 'team-score';
        div.style.color = TEAMS[i].pri;
        div.innerHTML = `<span class="team-icon">${TEAMS[i].icon}</span><span id="score-${i}">0</span>`;
        container.appendChild(div);
    }
}

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const scaleX = canvas.width / MAP_W;
    const scaleY = canvas.height / MAP_H;
    scale = Math.min(scaleX, scaleY);
    offsetX = (canvas.width - MAP_W * scale) / 2;
    offsetY = (canvas.height - MAP_H * scale) / 2;
}

// ─── Input ──────────────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
    switch (e.key.toLowerCase()) {
        case 'w': case 'arrowup': keys.up = true; break;
        case 's': case 'arrowdown': keys.down = true; break;
        case 'a': case 'arrowleft': keys.left = true; break;
        case 'd': case 'arrowright': keys.right = true; break;
    }
});

document.addEventListener('keyup', (e) => {
    switch (e.key.toLowerCase()) {
        case 'w': case 'arrowup': keys.up = false; break;
        case 's': case 'arrowdown': keys.down = false; break;
        case 'a': case 'arrowleft': keys.left = false; break;
        case 'd': case 'arrowright': keys.right = false; break;
    }
});

document.addEventListener('mousemove', (e) => { mouseX = e.clientX; mouseY = e.clientY; });
document.addEventListener('mousedown', (e) => { if (e.button === 0 && connected) shootQueued = true; });
document.addEventListener('contextmenu', (e) => { if (connected) e.preventDefault(); });

function getTurretAngle() {
    if (!gameState) return 0;
    const myTank = gameState.tanks.find(t => t.id === myId);
    if (!myTank) return 0;
    const sx = myTank.x * scale + offsetX + screenShake.x;
    const sy = myTank.y * scale + offsetY + screenShake.y;
    return Math.atan2(mouseY - sy, mouseX - sx);
}

function sendInput() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!gameState || gameState.phase !== PHASE_PLAYING) return;
    ws.send(JSON.stringify({
        type: 'input',
        up: keys.up ? 1 : 0,
        down: keys.down ? 1 : 0,
        left: keys.left ? 1 : 0,
        right: keys.right ? 1 : 0,
        shoot: shootQueued ? 1 : 0,
        turret: getTurretAngle(),
    }));
    shootQueued = false;
}

// ─── HUD ────────────────────────────────────────────────────────────────────

function formatTime(seconds) {
    if (seconds < 0) return '∞';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateHUD() {
    if (!gameState) return;

    // Update scores
    for (let i = 0; i < numTeams; i++) {
        const el = document.getElementById(`score-${i}`);
        if (el) el.textContent = gameState.scores[i];
    }
    // Rebuild if team count changed
    if (gameState.num_teams && gameState.num_teams !== numTeams) {
        numTeams = gameState.num_teams;
        buildScoreHUD();
    }

    // Timer
    const timerEl = document.getElementById('hud-timer');
    const timer = gameState.timer;
    if (timer < 0) {
        timerEl.textContent = '∞';
        timerEl.className = 'hud-timer';
    } else {
        timerEl.textContent = formatTime(timer);
        if (timer <= 10) {
            timerEl.className = 'hud-timer critical';
        } else if (timer <= 30) {
            timerEl.className = 'hud-timer warning';
        } else {
            timerEl.className = 'hud-timer';
        }
    }

    // Kills
    const myTank = gameState.tanks.find(t => t.id === myId);
    const killsEl = document.getElementById('hud-kills');
    if (myTank) {
        killsEl.textContent = myTank.kills + ' kill' + (myTank.kills !== 1 ? 's' : '');
    }

    // Player count
    document.getElementById('player-count').textContent = gameState.tanks.length + ' player' + (gameState.tanks.length !== 1 ? 's' : '');

    // Death overlay
    document.getElementById('death-overlay').style.display = (myTank && !myTank.alive) ? '' : 'none';
}

// ─── Game Over ──────────────────────────────────────────────────────────────

function showGameOver() {
    if (!gameState) return;

    const goEl = document.getElementById('gameover-overlay');
    goEl.style.display = '';

    const winText = document.getElementById('winner-text');
    const winSub = document.getElementById('gameover-sub');
    const reasonEl = document.getElementById('gameover-reason');
    const statsEl = document.getElementById('gameover-stats');

    const wt = gameState.winner;
    const winnerTeam = TEAMS[wt] || TEAMS[0];

    if (wt === myTeam) {
        winText.textContent = 'VICTORY';
        winText.style.color = '#00f0ff';
        winSub.textContent = 'Your team wins!';
    } else {
        winText.textContent = 'DEFEAT';
        winText.style.color = '#ff3b5c';
        winSub.textContent = (winnerTeam.name || 'Team ' + wt) + ' team wins!';
    }

    // Win reason
    const reason = gameState.win_reason;
    if (reason === 0) {
        reasonEl.textContent = `Won by captures (${gameState.scores[wt]} flags)`;
    } else if (reason === 1) {
        reasonEl.textContent = `Won by kills (time expired)`;
    } else {
        reasonEl.textContent = '';
    }

    // Stats table
    let statsHtml = '';
    for (let i = 0; i < numTeams; i++) {
        const team = TEAMS[i];
        const isWinner = i === wt;
        statsHtml += `<div class="stats-row${isWinner ? ' stats-winner' : ''}">
            <span class="stats-team-dot" style="background:${team.pri}"></span>
            <span class="stats-team-name" style="color:${team.pri}">${team.name}</span>
            <span class="stats-team-score" style="color:${team.pri}">${gameState.scores[i]} ⚑</span>
            <span class="stats-team-kills">${gameState.team_kills[i]} kills</span>
        </div>`;
    }
    statsEl.innerHTML = statsHtml;
}

// ─── Particle Systems ───────────────────────────────────────────────────────

function spawnExplosion(x, y, color, big) {
    const count = big ? 24 : 10;
    for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 / count) * i + Math.random() * 0.5;
        const speed = big ? (60 + Math.random() * 140) : (30 + Math.random() * 70);
        particles.push({
            x, y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: 0.4 + Math.random() * 0.4,
            maxLife: 0.8,
            color,
            size: big ? (2 + Math.random() * 4) : (1.5 + Math.random() * 2.5),
        });
    }
    // Shockwave ring for big explosions
    if (big) {
        particles.push({
            x, y, vx: 0, vy: 0,
            life: 0.35, maxLife: 0.35,
            color, size: 5, ring: true, ringRadius: 0,
        });
    }
}

function spawnMuzzleFlash(x, y, angle, color) {
    muzzleFlashes.push({
        x, y, angle, color,
        life: 0.08,
    });
    for (let i = 0; i < 4; i++) {
        const a2 = angle + (Math.random() - 0.5) * 0.6;
        particles.push({
            x, y,
            vx: Math.cos(a2) * (80 + Math.random() * 60),
            vy: Math.sin(a2) * (80 + Math.random() * 60),
            life: 0.12 + Math.random() * 0.1,
            maxLife: 0.25,
            color: '#ffe8a0',
            size: 1.5 + Math.random() * 1.5,
        });
    }
}

function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        if (p.ring) {
            p.ringRadius += 250 * dt;
        } else {
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vx *= 0.95;
            p.vy *= 0.95;
        }
        p.life -= dt;
        if (p.life <= 0) particles.splice(i, 1);
    }
    for (let i = muzzleFlashes.length - 1; i >= 0; i--) {
        muzzleFlashes[i].life -= dt;
        if (muzzleFlashes[i].life <= 0) muzzleFlashes.splice(i, 1);
    }
    // Screen shake decay
    if (screenShake.intensity > 0) {
        screenShake.x = (Math.random() - 0.5) * screenShake.intensity * 2;
        screenShake.y = (Math.random() - 0.5) * screenShake.intensity * 2;
        screenShake.intensity *= 0.88;
        if (screenShake.intensity < 0.3) { screenShake.intensity = 0; screenShake.x = 0; screenShake.y = 0; }
    }
}

function drawParticles() {
    for (const p of particles) {
        const alpha = Math.max(0, p.life / p.maxLife);
        if (p.ring) {
            ctx.globalAlpha = alpha * 0.5;
            ctx.strokeStyle = p.color;
            ctx.lineWidth = 2 * scale;
            ctx.beginPath();
            ctx.arc(p.x * scale + offsetX, p.y * scale + offsetY, p.ringRadius * scale, 0, Math.PI * 2);
            ctx.stroke();
        } else {
            ctx.globalAlpha = alpha;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x * scale + offsetX, p.y * scale + offsetY, p.size * scale, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.globalAlpha = 1;
}

function drawMuzzleFlashes() {
    for (const m of muzzleFlashes) {
        const mx = m.x * scale + offsetX;
        const my = m.y * scale + offsetY;
        const alpha = m.life / 0.08;
        ctx.globalAlpha = alpha * 0.9;
        const grad = ctx.createRadialGradient(mx, my, 0, mx, my, 18 * scale);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.4, m.color);
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(mx, my, 18 * scale, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

// ─── Bullet Trails ──────────────────────────────────────────────────────────

function trackBulletTrails() {
    if (!gameState) return;
    for (const b of gameState.bullets) {
        bulletTrails.push({ x: b.x, y: b.y, team: b.team, life: 0.2 });
    }
    for (let i = bulletTrails.length - 1; i >= 0; i--) {
        bulletTrails[i].life -= 1 / 60;
        if (bulletTrails[i].life <= 0) bulletTrails.splice(i, 1);
    }
}

function drawBulletTrails() {
    for (const t of bulletTrails) {
        const alpha = Math.max(0, t.life / 0.2) * 0.35;
        ctx.globalAlpha = alpha;
        const team = TEAMS[t.team] || TEAMS[0];
        ctx.fillStyle = team.bullet;
        ctx.beginPath();
        ctx.arc(t.x * scale + offsetX, t.y * scale + offsetY, 3 * scale, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

let lastTime = performance.now();
let prevBullets = [];

function gameLoop(timestamp) {
    const dt = Math.min((timestamp - lastTime) / 1000, 0.05);
    lastTime = timestamp;
    time += dt;

    updateParticles(dt);
    updateAmbient(dt);
    trackBulletTrails();

    // Detect new bullets for muzzle flash
    if (gameState && prevState) {
        const curBullets = gameState.bullets;
        const pBullets = prevState.bullets;
        if (curBullets.length > pBullets.length) {
            // New bullets appeared
            for (let i = pBullets.length; i < curBullets.length; i++) {
                const b = curBullets[i];
                if (b) {
                    const team = TEAMS[b.team] || TEAMS[0];
                    const angle = Math.atan2(b.vy, b.vx);
                    spawnMuzzleFlash(b.x - Math.cos(angle) * 15, b.y - Math.sin(angle) * 15, angle, team.pri);
                }
            }
        }
    }

    draw();
    requestAnimationFrame(gameLoop);
}

function draw() {
    if (!gameState) return;

    ctx.save();
    ctx.translate(screenShake.x, screenShake.y);

    // Clear
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawGrid();
    drawAmbient();
    drawBases();
    drawWalls();
    drawFlags();
    drawBulletTrails();
    drawBullets();
    drawTanks();
    drawMuzzleFlashes();
    drawParticles();

    ctx.restore();
}

// ─── Ambient ────────────────────────────────────────────────────────────────

function drawAmbient() {
    for (const p of ambientParticles) {
        const a = p.alpha * (0.6 + 0.4 * Math.sin(p.pulse));
        ctx.globalAlpha = a;
        ctx.fillStyle = 'rgba(100, 180, 255, 0.8)';
        ctx.beginPath();
        ctx.arc(p.x * scale + offsetX, p.y * scale + offsetY, p.size * scale, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

// ─── Grid ───────────────────────────────────────────────────────────────────

function drawGrid() {
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 0.5;
    const step = 60;
    for (let x = 0; x <= MAP_W; x += step) {
        ctx.beginPath();
        ctx.moveTo(x * scale + offsetX, offsetY);
        ctx.lineTo(x * scale + offsetX, MAP_H * scale + offsetY);
        ctx.stroke();
    }
    for (let y = 0; y <= MAP_H; y += step) {
        ctx.beginPath();
        ctx.moveTo(offsetX, y * scale + offsetY);
        ctx.lineTo(MAP_W * scale + offsetX, y * scale + offsetY);
        ctx.stroke();
    }
}

// ─── Bases ──────────────────────────────────────────────────────────────────

function drawBases() {
    for (let i = 0; i < numTeams; i++) {
        const flag = gameState.flags[i];
        if (!flag) continue;
        const team = TEAMS[i];
        const bx = flag.bx * scale + offsetX;
        const by = flag.by * scale + offsetY;
        const r = 55 * scale;

        // Pulsing glow
        const pulse = 0.7 + 0.3 * Math.sin(time * 2 + i);

        // Outer glow
        const grad = ctx.createRadialGradient(bx, by, 0, bx, by, r * 1.3);
        grad.addColorStop(0, team.base);
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.globalAlpha = pulse;
        ctx.beginPath();
        ctx.arc(bx, by, r * 1.3, 0, Math.PI * 2);
        ctx.fill();

        // Base circle
        ctx.globalAlpha = pulse * 0.6;
        ctx.strokeStyle = team.baseStroke;
        ctx.lineWidth = 2 * scale;
        ctx.setLineDash([8 * scale, 4 * scale]);
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.globalAlpha = 1;
    }
}

// ─── Walls ──────────────────────────────────────────────────────────────────

function drawWalls() {
    for (const w of gameState.walls) {
        const x = w[0] * scale + offsetX;
        const y = w[1] * scale + offsetY;
        const width = w[2] * scale;
        const height = w[3] * scale;

        // Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(x + 2 * scale, y + 2 * scale, width, height);

        // Wall body with gradient
        const grad = ctx.createLinearGradient(x, y, x, y + height);
        grad.addColorStop(0, COL.wallTop);
        grad.addColorStop(1, COL.wallFill);
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, width, height);

        // Top highlight
        ctx.fillStyle = 'rgba(100, 160, 255, 0.06)';
        ctx.fillRect(x, y, width, Math.min(3 * scale, height));

        // Border
        ctx.strokeStyle = COL.wallStroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
    }
}

// ─── Flags ──────────────────────────────────────────────────────────────────

function drawFlags() {
    for (let i = 0; i < numTeams; i++) {
        const flag = gameState.flags[i];
        if (!flag || flag.carried) continue;

        const fx = flag.x * scale + offsetX;
        const fy = flag.y * scale + offsetY;
        const r = FLAG_RADIUS * scale;
        const team = TEAMS[flag.team] || TEAMS[0];

        // Glow circle
        const pulse = 0.6 + 0.4 * Math.sin(time * 3 + i * 1.5);
        ctx.globalAlpha = pulse * 0.3;
        const fg = ctx.createRadialGradient(fx, fy, 0, fx, fy, r * 2);
        fg.addColorStop(0, team.pri);
        fg.addColorStop(1, 'transparent');
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.arc(fx, fy, r * 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        // Flag pole
        ctx.strokeStyle = '#8899aa';
        ctx.lineWidth = 2.5 * scale;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(fx, fy + r * 0.8);
        ctx.lineTo(fx, fy - r * 0.9);
        ctx.stroke();

        // Flag triangle with gradient
        const flagGrad = ctx.createLinearGradient(fx, fy - r, fx + r * 1.2, fy);
        flagGrad.addColorStop(0, team.pri);
        flagGrad.addColorStop(1, team.dark);
        ctx.fillStyle = flagGrad;
        ctx.beginPath();
        ctx.moveTo(fx + 1 * scale, fy - r * 0.9);
        ctx.lineTo(fx + r * 1.3, fy - r * 0.25);
        ctx.lineTo(fx + 1 * scale, fy + r * 0.2);
        ctx.closePath();
        ctx.fill();

        // Flag outline
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
    }
}

// ─── Bullets ────────────────────────────────────────────────────────────────

function drawBullets() {
    for (const b of gameState.bullets) {
        const bx = b.x * scale + offsetX;
        const by = b.y * scale + offsetY;
        const r = 5 * scale;
        const team = TEAMS[b.team] || TEAMS[0];

        // Outer glow
        ctx.shadowColor = team.bulletGlow;
        ctx.shadowBlur = 16 * scale;

        // Bullet body with gradient
        const bg = ctx.createRadialGradient(bx, by, 0, bx, by, r);
        bg.addColorStop(0, '#ffffff');
        bg.addColorStop(0.3, team.bullet);
        bg.addColorStop(1, team.pri);
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowBlur = 0;

        // Bounce count indicator: fading opacity
        const fadeAlpha = 1.0 - (b.bounces / 6);
        if (fadeAlpha < 1) {
            ctx.globalAlpha = 0.3;
            ctx.strokeStyle = 'rgba(255,255,255,0.5)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(bx, by, r + 3 * scale, 0, Math.PI * 2 * fadeAlpha);
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
    }
}

// ─── Tanks ──────────────────────────────────────────────────────────────────

function drawTanks() {
    for (const tank of gameState.tanks) {
        const tx = tank.x * scale + offsetX;
        const ty = tank.y * scale + offsetY;
        const half = (TANK_SIZE / 2) * scale;
        const isMe = tank.id === myId;
        const team = TEAMS[tank.team] || TEAMS[0];

        if (!tank.alive) {
            // Wreckage
            ctx.globalAlpha = 0.3;
            ctx.save();
            ctx.translate(tx, ty);
            ctx.rotate(tank.angle);
            ctx.fillStyle = '#222';
            ctx.fillRect(-half, -half, half * 2, half * 2);
            // Scorch marks
            ctx.fillStyle = 'rgba(80,40,0,0.4)';
            ctx.beginPath();
            ctx.arc(0, 0, half * 0.6, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            ctx.globalAlpha = 1;
            continue;
        }

        // Self highlight glow
        if (isMe) {
            ctx.shadowColor = team.pri;
            ctx.shadowBlur = 22 * scale;
        }

        // ── Tank body ──
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(tank.angle);

        // Tracks with tread pattern
        ctx.fillStyle = team.dark;
        ctx.fillRect(-half * 1.05, -half, half * 2.1, half * 0.35);
        ctx.fillRect(-half * 1.05, half * 0.65, half * 2.1, half * 0.35);

        // Tread marks
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 1;
        const treadOffset = (time * 60) % 6;
        for (let tx2 = -half; tx2 < half; tx2 += 6) {
            const xp = tx2 + treadOffset;
            ctx.beginPath();
            ctx.moveTo(xp, -half);
            ctx.lineTo(xp, -half + half * 0.35);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(xp, half * 0.65);
            ctx.lineTo(xp, half);
            ctx.stroke();
        }

        // Body with gradient
        const bodyGrad = ctx.createLinearGradient(-half * 0.85, -half * 0.65, half * 0.85, half * 0.65);
        bodyGrad.addColorStop(0, team.pri);
        bodyGrad.addColorStop(0.5, team.dark);
        bodyGrad.addColorStop(1, team.pri);
        ctx.fillStyle = bodyGrad;
        ctx.beginPath();
        // Rounded rectangle body
        const bw = half * 1.7, bh = half * 1.3;
        const br = 3 * scale;
        ctx.moveTo(-bw / 2 + br, -bh / 2);
        ctx.lineTo(bw / 2 - br, -bh / 2);
        ctx.arcTo(bw / 2, -bh / 2, bw / 2, -bh / 2 + br, br);
        ctx.lineTo(bw / 2, bh / 2 - br);
        ctx.arcTo(bw / 2, bh / 2, bw / 2 - br, bh / 2, br);
        ctx.lineTo(-bw / 2 + br, bh / 2);
        ctx.arcTo(-bw / 2, bh / 2, -bw / 2, bh / 2 - br, br);
        ctx.lineTo(-bw / 2, -bh / 2 + br);
        ctx.arcTo(-bw / 2, -bh / 2, -bw / 2 + br, -bh / 2, br);
        ctx.closePath();
        ctx.fill();

        // Body highlight line
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Team emblem (small diamond)
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.beginPath();
        ctx.moveTo(0, -half * 0.3);
        ctx.lineTo(half * 0.2, 0);
        ctx.lineTo(0, half * 0.3);
        ctx.lineTo(-half * 0.2, 0);
        ctx.closePath();
        ctx.fill();

        ctx.restore();

        // ── Turret ──
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(tank.turret);

        // Barrel
        const barrelGrad = ctx.createLinearGradient(half * 0.1, -half * 0.14, half * 0.1, half * 0.14);
        barrelGrad.addColorStop(0, '#dde4f0');
        barrelGrad.addColorStop(0.5, '#99a8c0');
        barrelGrad.addColorStop(1, '#dde4f0');
        ctx.fillStyle = barrelGrad;
        // Rounded barrel
        ctx.beginPath();
        ctx.moveTo(half * 0.15, -half * 0.12);
        ctx.lineTo(half * 1.1, -half * 0.1);
        ctx.lineTo(half * 1.15, 0);
        ctx.lineTo(half * 1.1, half * 0.1);
        ctx.lineTo(half * 0.15, half * 0.12);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.lineWidth = 0.5;
        ctx.stroke();

        // Barrel muzzle
        ctx.fillStyle = COL.turretTip;
        ctx.fillRect(half * 1.0, -half * 0.13, half * 0.18, half * 0.26);

        // Turret dome
        const domeGrad = ctx.createRadialGradient(-2 * scale, -2 * scale, 0, 0, 0, half * 0.5);
        domeGrad.addColorStop(0, 'rgba(255,255,255,0.15)');
        domeGrad.addColorStop(0.5, team.dark);
        domeGrad.addColorStop(1, team.pri);
        ctx.fillStyle = domeGrad;
        ctx.beginPath();
        ctx.arc(0, 0, half * 0.48, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.restore();
        ctx.shadowBlur = 0;

        // ── Flag carrier indicator ──
        if (tank.flag >= 0) {
            const flagTeam = TEAMS[tank.flag] || TEAMS[0];
            // Orbiting flag icon
            const orbitAngle = time * 3;
            const ox = tx + Math.cos(orbitAngle) * (half + 6 * scale);
            const oy = ty + Math.sin(orbitAngle) * (half + 6 * scale) - 12 * scale;
            ctx.fillStyle = flagTeam.pri;
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            ctx.arc(ox, oy, 5 * scale, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            // Flag text
            ctx.fillStyle = flagTeam.pri;
            ctx.font = `bold ${11 * scale}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText('⚑', tx, ty - half - 10 * scale);
        }

        // ── "You" pointer ──
        if (isMe) {
            const pointerY = ty - half - 18 * scale;
            const bob = Math.sin(time * 4) * 2 * scale;
            ctx.fillStyle = '#00f0ff';
            ctx.beginPath();
            ctx.moveTo(tx, pointerY + bob + 6 * scale);
            ctx.lineTo(tx - 5 * scale, pointerY + bob);
            ctx.lineTo(tx + 5 * scale, pointerY + bob);
            ctx.closePath();
            ctx.fill();
        }
    }
}

// Make globally accessible
window.connectToServer = connectToServer;
window.startGame = startGame;
window.restartGame = restartGame;
