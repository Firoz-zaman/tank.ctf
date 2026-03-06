#ifndef GAME_ENGINE_H
#define GAME_ENGINE_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

/* ─── Constants ─── */
#define MAX_PLAYERS          8
#define MAX_TEAMS            4
#define MAX_BULLETS          64
#define MAX_BULLETS_PER_TANK 3
#define MAX_WALLS            200
#define MAP_WIDTH            1200.0f
#define MAP_HEIGHT           900.0f
#define TANK_SIZE            24.0f
#define TANK_SPEED           180.0f
#define TANK_ROT_SPEED       4.0f
#define BULLET_SPEED         350.0f
#define BULLET_RADIUS        4.0f
#define DEFAULT_MAX_BOUNCES  8
#define RESPAWN_TIME         2.0f
#define FLAG_RADIUS          24.0f
#define WIN_SCORE            3
#define COUNTDOWN_SECS       3.0f

/* Game phases */
#define PHASE_LOBBY     0
#define PHASE_COUNTDOWN 1
#define PHASE_PLAYING   2
#define PHASE_GAMEOVER  3

/* Emotes */
#define EMOTE_NONE      0
#define EMOTE_HAPPY     1
#define EMOTE_SAD       2
#define EMOTE_DURATION  3.0f

/* ─── Structs ─── */

typedef struct {
    float x, y, w, h;
} Wall;

typedef struct {
    float x, y;
    float vx, vy;
    int   bounces;
    int   active;
    int   owner_id;
    int   owner_team;
} Bullet;

typedef struct {
    float x, y;
    float base_x, base_y;
    int   team;
    int   carried;
    int   carrier_id;
    int   exists;       /* 1 if this flag is in play */
} Flag;

typedef struct {
    int   id;
    int   active;
    int   team;
    float x, y;
    float angle;
    float turret_angle;
    int   alive;
    float respawn_timer;
    int   carrying_flag;    /* -1 = none, 0-3 = flag team index */
    int   kills;            /* kill count */
    int   emote;            /* EMOTE_NONE / HAPPY / SAD */
    float emote_timer;      /* seconds remaining for emote display */

    /* input state */
    int   input_up, input_down, input_left, input_right;
    int   input_shoot;
    float input_turret_angle;
} Tank;

typedef struct {
    Tank   tanks[MAX_PLAYERS];
    Bullet bullets[MAX_BULLETS];
    Wall   walls[MAX_WALLS];
    Flag   flags[MAX_TEAMS];
    int    scores[MAX_TEAMS];
    int    team_kills[MAX_TEAMS];       /* total kills per team */
    int    team_has_players[MAX_TEAMS]; /* 1 if any active tank on team */
    int    wall_count;
    int    player_count;
    int    num_teams;
    int    configured_teams;            /* user-selected: 2, 3, or 4 */

    /* Game flow */
    int    phase;               /* PHASE_LOBBY / COUNTDOWN / PLAYING / GAMEOVER */
    float  countdown_timer;     /* countdown seconds remaining */
    float  game_timer;          /* game timer (counts down if timed, -1 if unlimited) */
    float  game_duration;       /* configured duration in seconds (0 = unlimited) */
    int    max_bounces;         /* configurable bounce count */

    int    winner_team;         /* -1 if not over */
    int    win_reason;          /* 0=captures, 1=kills(timeout) */
} GameState;

/* ─── API ─── */

void engine_init(void);
int  engine_add_player(void);
void engine_remove_player(int player_id);
void engine_set_input(int player_id,
                      int up, int down, int left, int right,
                      int shoot, float turret_angle);
void engine_tick(float dt);
int  engine_get_state(char* buf, int buf_size);
int  engine_get_walls(char* buf, int buf_size);
int  engine_get_player_team(int player_id);
int  engine_get_num_teams(void);

/* Game flow */
void engine_set_config(int max_bounces, float game_duration);
void engine_set_team_count(int count);   /* set configured team count 2/3/4 */
void engine_set_emote(int player_id, int emote);
void engine_start_game(void);    /* lobby → countdown → playing */
void engine_restart(void);       /* gameover → lobby */

#ifdef __cplusplus
}
#endif

#endif /* GAME_ENGINE_H */
