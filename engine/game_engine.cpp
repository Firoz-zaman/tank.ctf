/*
 * game_engine.cpp — 2D Tank CTF Game Engine (v4)
 *
 * Game phases: LOBBY → COUNTDOWN → PLAYING → GAMEOVER → (restart) → LOBBY
 * Features: 2/3/4-team config, fill-empty-teams-first, emotes, configurable bounces,
 *           game timer, kill tracking, separated wall serialization
 */

#include "game_engine.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <algorithm>

static GameState g_state;
static std::mutex g_mutex;

/* ─── Helpers ─── */

static float clampf(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

static float normalize_angle(float a) {
    while (a > (float)M_PI)  a -= 2.0f * (float)M_PI;
    while (a < -(float)M_PI) a += 2.0f * (float)M_PI;
    return a;
}

/* Team base positions (corners) */
static float base_x[MAX_TEAMS] = { 70.0f, MAP_WIDTH - 70.0f, 70.0f, MAP_WIDTH - 70.0f };
static float base_y[MAX_TEAMS] = { 70.0f, 70.0f, MAP_HEIGHT - 70.0f, MAP_HEIGHT - 70.0f };
static float spawn_angle[MAX_TEAMS] = { 0.785f, 2.356f, -0.785f, -2.356f };

/* ─── Map ─── */
static void add_wall(float x, float y, float w, float h) {
    if (g_state.wall_count >= MAX_WALLS) return;
    Wall& wall = g_state.walls[g_state.wall_count++];
    wall.x = x; wall.y = y; wall.w = w; wall.h = h;
}

static void build_map() {
    g_state.wall_count = 0;
    float T = 10.0f;

    /* Outer boundary */
    add_wall(0, 0, MAP_WIDTH, T);
    add_wall(0, MAP_HEIGHT - T, MAP_WIDTH, T);
    add_wall(0, 0, T, MAP_HEIGHT);
    add_wall(MAP_WIDTH - T, 0, T, MAP_HEIGHT);

    /* Central cross */
    add_wall(550, 350, 100, T);
    add_wall(550, 540, 100, T);
    add_wall(555, 350, T, 200);
    add_wall(645, 350, T, 200);

    /* Top corridor walls */
    add_wall(200, 150, T, 180);
    add_wall(400, 80,  T, 200);
    add_wall(800, 80,  T, 200);
    add_wall(1000, 150, T, 180);
    add_wall(150, 250, 120, T);
    add_wall(930, 250, 120, T);

    /* Bottom corridor walls */
    add_wall(200, 570, T, 180);
    add_wall(400, 620, T, 200);
    add_wall(800, 620, T, 200);
    add_wall(1000, 570, T, 180);
    add_wall(150, 640, 120, T);
    add_wall(930, 640, 120, T);

    /* Middle horizontal corridors */
    add_wall(130, 420, 150, T);
    add_wall(130, 470, 150, T);
    add_wall(920, 420, 150, T);
    add_wall(920, 470, 150, T);

    /* Cover blocks near bases */
    add_wall(140, 130, 35, 35);
    add_wall(1025, 130, 35, 35);
    add_wall(140, 735, 35, 35);
    add_wall(1025, 735, 35, 35);

    /* Mid-field cover */
    add_wall(350, 350, 35, 35);
    add_wall(815, 350, 35, 35);
    add_wall(350, 515, 35, 35);
    add_wall(815, 515, 35, 35);

    /* Extra corridors */
    add_wall(300, 80,  100, T);
    add_wall(800, 80,  100, T);
    add_wall(300, 810, 100, T);
    add_wall(800, 810, 100, T);
    add_wall(500, 180, T, 130);
    add_wall(700, 180, T, 130);
    add_wall(500, 590, T, 130);
    add_wall(700, 590, T, 130);
}

/* ─── Collision ─── */

static int rect_overlap(float ax, float ay, float aw, float ah,
                         float bx, float by, float bw, float bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

static int point_in_rect(float px, float py, float rx, float ry, float rw, float rh) {
    return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
}

static int tank_collides_wall(float tx, float ty) {
    float half = TANK_SIZE / 2.0f;
    for (int i = 0; i < g_state.wall_count; i++) {
        Wall& w = g_state.walls[i];
        if (rect_overlap(tx - half, ty - half, TANK_SIZE, TANK_SIZE, w.x, w.y, w.w, w.h))
            return 1;
    }
    return 0;
}

/* ─── Bullet helpers ─── */

static int count_player_bullets(int player_id) {
    int count = 0;
    for (int i = 0; i < MAX_BULLETS; i++)
        if (g_state.bullets[i].active && g_state.bullets[i].owner_id == player_id) count++;
    return count;
}

static void reflect_bullet(Bullet& b, float dt) {
    float nx = b.x + b.vx * dt;
    float ny = b.y + b.vy * dt;

    for (int i = 0; i < g_state.wall_count; i++) {
        Wall& w = g_state.walls[i];
        if (!point_in_rect(nx, ny, w.x - BULLET_RADIUS, w.y - BULLET_RADIUS,
                           w.w + 2 * BULLET_RADIUS, w.h + 2 * BULLET_RADIUS))
            continue;

        float dx_left  = fabsf(nx - w.x);
        float dx_right = fabsf(nx - (w.x + w.w));
        float dy_top   = fabsf(ny - w.y);
        float dy_bot   = fabsf(ny - (w.y + w.h));
        float min_d = fminf(fminf(dx_left, dx_right), fminf(dy_top, dy_bot));

        if (min_d == dx_left || min_d == dx_right) b.vx = -b.vx;
        else b.vy = -b.vy;

        b.bounces++;
        if (b.bounces >= g_state.max_bounces) { b.active = 0; return; }

        nx = b.x + b.vx * dt;
        ny = b.y + b.vy * dt;
        break;
    }

    b.x = nx; b.y = ny;
    if (b.x < 0 || b.x > MAP_WIDTH || b.y < 0 || b.y > MAP_HEIGHT) b.active = 0;
}

static void spawn_bullet(int player_id, float angle) {
    Tank& t = g_state.tanks[player_id];
    if (!t.active || !t.alive) return;
    if (count_player_bullets(player_id) >= MAX_BULLETS_PER_TANK) return;

    for (int i = 0; i < MAX_BULLETS; i++) {
        Bullet& b = g_state.bullets[i];
        if (!b.active) {
            b.active = 1;
            b.owner_id = player_id;
            b.owner_team = t.team;
            b.bounces = 0;
            b.x = t.x + cosf(angle) * (TANK_SIZE / 2.0f + BULLET_RADIUS + 2.0f);
            b.y = t.y + sinf(angle) * (TANK_SIZE / 2.0f + BULLET_RADIUS + 2.0f);
            b.vx = cosf(angle) * BULLET_SPEED;
            b.vy = sinf(angle) * BULLET_SPEED;
            return;
        }
    }
}

/* ─── Team helpers ─── */

static void update_team_has_players() {
    for (int i = 0; i < MAX_TEAMS; i++) g_state.team_has_players[i] = 0;
    for (int i = 0; i < MAX_PLAYERS; i++)
        if (g_state.tanks[i].active) g_state.team_has_players[g_state.tanks[i].team] = 1;
}

static void recalc_teams() {
    update_team_has_players();
    /* num_teams = configured_teams, but at least count of occupied teams */
    int occupied = 0;
    for (int i = 0; i < MAX_TEAMS; i++) occupied += g_state.team_has_players[i];
    g_state.num_teams = (g_state.configured_teams > occupied) ? g_state.configured_teams : occupied;
    if (g_state.num_teams < 2) g_state.num_teams = 2;
}

static void setup_flags() {
    /* Create flags only for active teams */
    for (int i = 0; i < MAX_TEAMS; i++) {
        g_state.flags[i].base_x = base_x[i];
        g_state.flags[i].base_y = base_y[i];
        g_state.flags[i].x = base_x[i];
        g_state.flags[i].y = base_y[i];
        g_state.flags[i].team = i;
        g_state.flags[i].carried = 0;
        g_state.flags[i].carrier_id = -1;
        g_state.flags[i].exists = (i < g_state.num_teams) ? 1 : 0;
    }
}

static void respawn_tank(int slot) {
    Tank& t = g_state.tanks[slot];
    t.alive = 1;
    t.respawn_timer = 0;
    t.carrying_flag = -1;
    t.x = base_x[t.team] + (slot % 2 == 0 ? -15.0f : 15.0f);
    t.y = base_y[t.team] + (slot % 2 == 0 ? -15.0f : 15.0f);
    t.angle = spawn_angle[t.team];
    t.turret_angle = t.angle;
}

/* ─── API Implementation ─── */

extern "C" {

void engine_init(void) {
    std::lock_guard<std::mutex> lock(g_mutex);
    memset(&g_state, 0, sizeof(g_state));
    g_state.winner_team = -1;
    g_state.num_teams = 2;
    g_state.configured_teams = 2;
    g_state.phase = PHASE_LOBBY;
    g_state.max_bounces = DEFAULT_MAX_BOUNCES;
    g_state.game_duration = 0; /* unlimited by default */
    g_state.game_timer = -1;
    g_state.win_reason = -1;

    for (int i = 0; i < MAX_PLAYERS; i++) {
        g_state.tanks[i].id = i;
        g_state.tanks[i].active = 0;
        g_state.tanks[i].carrying_flag = -1;
        g_state.tanks[i].emote = EMOTE_NONE;
        g_state.tanks[i].emote_timer = 0;
    }
    for (int i = 0; i < MAX_BULLETS; i++) g_state.bullets[i].active = 0;

    build_map();

    for (int i = 0; i < MAX_TEAMS; i++) {
        g_state.flags[i].exists = 0;
        g_state.flags[i].base_x = base_x[i];
        g_state.flags[i].base_y = base_y[i];
        g_state.flags[i].x = base_x[i];
        g_state.flags[i].y = base_y[i];
        g_state.flags[i].team = i;
        g_state.flags[i].carried = 0;
        g_state.flags[i].carrier_id = -1;
        g_state.team_has_players[i] = 0;
    }
}

int engine_add_player(void) {
    std::lock_guard<std::mutex> lock(g_mutex);

    int slot = -1;
    for (int i = 0; i < MAX_PLAYERS; i++)
        if (!g_state.tanks[i].active) { slot = i; break; }
    if (slot < 0) return -1;

    int nt = g_state.configured_teams;

    /* Count players per team */
    int team_counts[MAX_TEAMS] = {0};
    for (int i = 0; i < MAX_PLAYERS; i++)
        if (g_state.tanks[i].active) team_counts[g_state.tanks[i].team]++;

    /* Fill empty teams first, then pick the team with fewest players */
    int best_team = -1;
    for (int t = 0; t < nt; t++) {
        if (team_counts[t] == 0) { best_team = t; break; }
    }
    if (best_team < 0) {
        /* All teams have at least 1 player — pick smallest */
        best_team = 0;
        int min_count = team_counts[0];
        for (int t = 1; t < nt; t++) {
            if (team_counts[t] < min_count) { min_count = team_counts[t]; best_team = t; }
        }
    }

    Tank& t = g_state.tanks[slot];
    t.active = 1;
    t.team = best_team;
    t.alive = 1;
    t.respawn_timer = 0;
    t.carrying_flag = -1;
    t.kills = 0;
    t.emote = EMOTE_NONE;
    t.emote_timer = 0;
    t.angle = spawn_angle[t.team];
    t.turret_angle = t.angle;
    t.x = base_x[t.team] + (slot % 2 == 0 ? -15.0f : 15.0f);
    t.y = base_y[t.team] + (slot % 2 == 0 ? -15.0f : 15.0f);
    t.input_up = t.input_down = t.input_left = t.input_right = 0;
    t.input_shoot = 0;
    t.input_turret_angle = t.turret_angle;

    g_state.player_count++;
    recalc_teams();
    return slot;
}

void engine_remove_player(int player_id) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (player_id < 0 || player_id >= MAX_PLAYERS) return;
    Tank& t = g_state.tanks[player_id];
    if (!t.active) return;

    if (t.carrying_flag >= 0 && t.carrying_flag < MAX_TEAMS) {
        Flag& f = g_state.flags[t.carrying_flag];
        f.carried = 0; f.carrier_id = -1;
        f.x = t.x; f.y = t.y;
        t.carrying_flag = -1;
    }

    t.active = 0;
    g_state.player_count--;
    recalc_teams();
}

void engine_set_input(int player_id,
                      int up, int down, int left, int right,
                      int shoot, float turret_angle) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (player_id < 0 || player_id >= MAX_PLAYERS) return;
    Tank& t = g_state.tanks[player_id];
    if (!t.active) return;
    t.input_up = up; t.input_down = down;
    t.input_left = left; t.input_right = right;
    t.input_shoot = shoot;
    t.input_turret_angle = turret_angle;
}

void engine_set_config(int max_bounces, float game_duration) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (max_bounces >= 1 && max_bounces <= 20) g_state.max_bounces = max_bounces;
    if (game_duration >= 0) g_state.game_duration = game_duration;
}

void engine_set_team_count(int count) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (count < 2) count = 2;
    if (count > 4) count = 4;
    g_state.configured_teams = count;
    recalc_teams();
}

void engine_set_emote(int player_id, int emote) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (player_id < 0 || player_id >= MAX_PLAYERS) return;
    Tank& t = g_state.tanks[player_id];
    if (!t.active || !t.alive) return;
    if (emote < EMOTE_NONE || emote > EMOTE_SAD) return;
    t.emote = emote;
    t.emote_timer = (emote != EMOTE_NONE) ? EMOTE_DURATION : 0;
}

void engine_start_game(void) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_state.phase != PHASE_LOBBY) return;
    if (g_state.player_count < 2) return;

    /* Setup flags for active teams */
    recalc_teams();
    setup_flags();

    /* Reset scores and kills */
    for (int i = 0; i < MAX_TEAMS; i++) {
        g_state.scores[i] = 0;
        g_state.team_kills[i] = 0;
    }

    /* Reset all players */
    for (int i = 0; i < MAX_PLAYERS; i++) {
        Tank& t = g_state.tanks[i];
        if (!t.active) continue;
        t.kills = 0;
        t.emote = EMOTE_NONE;
        t.emote_timer = 0;
        respawn_tank(i);
    }

    /* Clear bullets */
    for (int i = 0; i < MAX_BULLETS; i++) g_state.bullets[i].active = 0;

    g_state.winner_team = -1;
    g_state.win_reason = -1;
    g_state.phase = PHASE_COUNTDOWN;
    g_state.countdown_timer = COUNTDOWN_SECS;
}

void engine_restart(void) {
    std::lock_guard<std::mutex> lock(g_mutex);

    /* Go back to lobby */
    g_state.phase = PHASE_LOBBY;
    g_state.winner_team = -1;
    g_state.win_reason = -1;
    g_state.game_timer = -1;
    g_state.countdown_timer = 0;

    for (int i = 0; i < MAX_TEAMS; i++) {
        g_state.scores[i] = 0;
        g_state.team_kills[i] = 0;
    }

    for (int i = 0; i < MAX_BULLETS; i++) g_state.bullets[i].active = 0;

    for (int i = 0; i < MAX_TEAMS; i++) {
        g_state.flags[i].exists = 0;
        g_state.flags[i].carried = 0;
        g_state.flags[i].carrier_id = -1;
        g_state.flags[i].x = g_state.flags[i].base_x;
        g_state.flags[i].y = g_state.flags[i].base_y;
    }

    for (int i = 0; i < MAX_PLAYERS; i++) {
        Tank& t = g_state.tanks[i];
        if (!t.active) continue;
        t.kills = 0;
        t.carrying_flag = -1;
        t.emote = EMOTE_NONE;
        t.emote_timer = 0;
        respawn_tank(i);
    }
}

void engine_tick(float dt) {
    std::lock_guard<std::mutex> lock(g_mutex);

    /* Always update team_has_players */
    update_team_has_players();

    /* ─── LOBBY: do nothing, wait for start_game ─── */
    if (g_state.phase == PHASE_LOBBY) return;

    /* ─── COUNTDOWN ─── */
    if (g_state.phase == PHASE_COUNTDOWN) {
        g_state.countdown_timer -= dt;
        if (g_state.countdown_timer <= 0) {
            g_state.phase = PHASE_PLAYING;
            g_state.countdown_timer = 0;
            if (g_state.game_duration > 0)
                g_state.game_timer = g_state.game_duration;
            else
                g_state.game_timer = -1; /* unlimited */
        }
        return;
    }

    /* ─── GAMEOVER: do nothing ─── */
    if (g_state.phase == PHASE_GAMEOVER) return;

    /* ─── PLAYING ─── */

    /* Update game timer */
    if (g_state.game_timer > 0) {
        g_state.game_timer -= dt;
        if (g_state.game_timer <= 0) {
            g_state.game_timer = 0;
            /* Time's up — team with most kills wins */
            int best = 0;
            for (int i = 1; i < g_state.num_teams; i++)
                if (g_state.team_kills[i] > g_state.team_kills[best]) best = i;
            g_state.phase = PHASE_GAMEOVER;
            g_state.winner_team = best;
            g_state.win_reason = 1; /* kills */
            return;
        }
    }

    /* ─── Update tanks ─── */
    for (int i = 0; i < MAX_PLAYERS; i++) {
        Tank& t = g_state.tanks[i];
        if (!t.active) continue;

        /* Tick emote timer */
        if (t.emote != EMOTE_NONE) {
            t.emote_timer -= dt;
            if (t.emote_timer <= 0) {
                t.emote = EMOTE_NONE;
                t.emote_timer = 0;
            }
        }

        if (!t.alive) {
            t.respawn_timer -= dt;
            if (t.respawn_timer <= 0) respawn_tank(i);
            continue;
        }

        float move_x = 0, move_y = 0;
        if (t.input_up)    { move_x += cosf(t.angle); move_y += sinf(t.angle); }
        if (t.input_down)  { move_x -= cosf(t.angle); move_y -= sinf(t.angle); }
        if (t.input_left)  { t.angle -= TANK_ROT_SPEED * dt; }
        if (t.input_right) { t.angle += TANK_ROT_SPEED * dt; }
        t.angle = normalize_angle(t.angle);
        t.turret_angle = t.input_turret_angle;

        float new_x = t.x + move_x * TANK_SPEED * dt;
        float new_y = t.y + move_y * TANK_SPEED * dt;
        if (!tank_collides_wall(new_x, t.y)) t.x = new_x;
        if (!tank_collides_wall(t.x, new_y)) t.y = new_y;

        float half = TANK_SIZE / 2.0f;
        t.x = clampf(t.x, half + 10, MAP_WIDTH - half - 10);
        t.y = clampf(t.y, half + 10, MAP_HEIGHT - half - 10);

        if (t.input_shoot) {
            spawn_bullet(i, t.turret_angle);
            t.input_shoot = 0;
        }
    }

    /* ─── Update bullets ─── */
    for (int i = 0; i < MAX_BULLETS; i++) {
        Bullet& b = g_state.bullets[i];
        if (!b.active) continue;

        reflect_bullet(b, dt);
        if (!b.active) continue;

        for (int j = 0; j < MAX_PLAYERS; j++) {
            Tank& t = g_state.tanks[j];
            if (!t.active || !t.alive) continue;
            if (j == b.owner_id && b.bounces == 0) continue;
            if (t.team == b.owner_team && b.bounces == 0) continue;

            float half = TANK_SIZE / 2.0f;
            if (b.x >= t.x - half && b.x <= t.x + half &&
                b.y >= t.y - half && b.y <= t.y + half) {
                b.active = 0;
                t.alive = 0;
                t.respawn_timer = RESPAWN_TIME;

                /* Credit kill */
                if (b.owner_id >= 0 && b.owner_id < MAX_PLAYERS) {
                    g_state.tanks[b.owner_id].kills++;
                    g_state.team_kills[b.owner_team]++;
                }

                /* Drop carried flag */
                if (t.carrying_flag >= 0) {
                    Flag& f = g_state.flags[t.carrying_flag];
                    f.carried = 0; f.carrier_id = -1;
                    f.x = t.x; f.y = t.y;
                    t.carrying_flag = -1;
                }
                break;
            }
        }
    }

    /* ─── CTF Logic ─── */
    for (int i = 0; i < MAX_PLAYERS; i++) {
        Tank& t = g_state.tanks[i];
        if (!t.active || !t.alive) continue;

        /* Pick up enemy flag */
        if (t.carrying_flag < 0) {
            for (int fi = 0; fi < g_state.num_teams; fi++) {
                if (fi == t.team) continue;
                Flag& ef = g_state.flags[fi];
                if (!ef.exists || ef.carried) continue;

                float dx = t.x - ef.x, dy = t.y - ef.y;
                float dist = TANK_SIZE / 2.0f + FLAG_RADIUS;
                if (dx * dx + dy * dy < dist * dist) {
                    ef.carried = 1; ef.carrier_id = i;
                    t.carrying_flag = fi;
                    break;
                }
            }
        }

        /* Move carried flag */
        if (t.carrying_flag >= 0) {
            Flag& cf = g_state.flags[t.carrying_flag];
            cf.x = t.x; cf.y = t.y;

            /* Capture check */
            float dx = t.x - base_x[t.team];
            float dy = t.y - base_y[t.team];
            float cap = TANK_SIZE / 2.0f + FLAG_RADIUS + 10.0f;
            if (dx * dx + dy * dy < cap * cap) {
                g_state.scores[t.team]++;
                cf.x = cf.base_x; cf.y = cf.base_y;
                cf.carried = 0; cf.carrier_id = -1;
                t.carrying_flag = -1;

                if (g_state.scores[t.team] >= WIN_SCORE) {
                    g_state.phase = PHASE_GAMEOVER;
                    g_state.winner_team = t.team;
                    g_state.win_reason = 0; /* captures */
                }
            }
        }

        /* Return own dropped flag */
        Flag& own = g_state.flags[t.team];
        if (own.exists && !own.carried &&
            (own.x != own.base_x || own.y != own.base_y)) {
            float dx = t.x - own.x, dy = t.y - own.y;
            float dist = TANK_SIZE / 2.0f + FLAG_RADIUS;
            if (dx * dx + dy * dy < dist * dist) {
                own.x = own.base_x; own.y = own.base_y;
            }
        }
    }
}

/* ─── JSON Serialization ─── */

#define W(fmt, ...) do { \
    off += snprintf(buf + off, buf_size - off, fmt, ##__VA_ARGS__); \
} while(0)

int engine_get_walls(char* buf, int buf_size) {
    std::lock_guard<std::mutex> lock(g_mutex);
    int off = 0;
    W("[");
    for (int i = 0; i < g_state.wall_count; i++) {
        Wall& w = g_state.walls[i];
        if (i > 0) W(",");
        W("[%.0f,%.0f,%.0f,%.0f]", w.x, w.y, w.w, w.h);
    }
    W("]");
    return off;
}

int engine_get_state(char* buf, int buf_size) {
    std::lock_guard<std::mutex> lock(g_mutex);
    int off = 0;

    W("{");

    /* Phase & flow */
    W("\"phase\":%d,", g_state.phase);
    W("\"countdown\":%.1f,", g_state.countdown_timer);
    W("\"timer\":%.1f,", g_state.game_timer);
    W("\"duration\":%.0f,", g_state.game_duration);
    W("\"max_bounces\":%d,", g_state.max_bounces);
    W("\"configured_teams\":%d,", g_state.configured_teams);

    /* Meta */
    W("\"scores\":[%d,%d,%d,%d],", g_state.scores[0], g_state.scores[1],
      g_state.scores[2], g_state.scores[3]);
    W("\"team_kills\":[%d,%d,%d,%d],", g_state.team_kills[0], g_state.team_kills[1],
      g_state.team_kills[2], g_state.team_kills[3]);
    W("\"team_has_players\":[%d,%d,%d,%d],",
      g_state.team_has_players[0], g_state.team_has_players[1],
      g_state.team_has_players[2], g_state.team_has_players[3]);
    W("\"num_teams\":%d,", g_state.num_teams);
    W("\"player_count\":%d,", g_state.player_count);
    W("\"winner\":%d,\"win_reason\":%d,", g_state.winner_team, g_state.win_reason);

    /* Flags (only existing) */
    W("\"flags\":[");
    int ff = 1;
    for (int i = 0; i < MAX_TEAMS; i++) {
        Flag& f = g_state.flags[i];
        if (!f.exists) continue;
        if (!ff) W(",");
        ff = 0;
        W("{\"x\":%.1f,\"y\":%.1f,\"bx\":%.1f,\"by\":%.1f,\"team\":%d,\"carried\":%d}",
          f.x, f.y, f.base_x, f.base_y, f.team, f.carried);
    }
    W("],");

    /* Tanks (only active) */
    W("\"tanks\":[");
    int ft = 1;
    for (int i = 0; i < MAX_PLAYERS; i++) {
        Tank& t = g_state.tanks[i];
        if (!t.active) continue;
        if (!ft) W(",");
        ft = 0;
        W("{\"id\":%d,\"team\":%d,\"x\":%.1f,\"y\":%.1f,"
          "\"angle\":%.3f,\"turret\":%.3f,"
          "\"alive\":%d,\"flag\":%d,\"kills\":%d,"
          "\"emote\":%d,\"emote_t\":%.1f}",
          t.id, t.team, t.x, t.y,
          t.angle, t.turret_angle,
          t.alive, t.carrying_flag, t.kills,
          t.emote, t.emote_timer);
    }
    W("],");

    /* Bullets (only active) */
    W("\"bullets\":[");
    int fb2 = 1;
    for (int i = 0; i < MAX_BULLETS; i++) {
        Bullet& b = g_state.bullets[i];
        if (!b.active) continue;
        if (!fb2) W(",");
        fb2 = 0;
        W("{\"x\":%.1f,\"y\":%.1f,\"vx\":%.1f,\"vy\":%.1f,\"team\":%d,\"bounces\":%d}",
          b.x, b.y, b.vx, b.vy, b.owner_team, b.bounces);
    }
    W("]");

    W("}");
    return off;
}

#undef W

int engine_get_player_team(int player_id) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (player_id < 0 || player_id >= MAX_PLAYERS) return -1;
    if (!g_state.tanks[player_id].active) return -1;
    return g_state.tanks[player_id].team;
}

int engine_get_num_teams(void) {
    std::lock_guard<std::mutex> lock(g_mutex);
    return g_state.num_teams;
}

} /* extern "C" */
