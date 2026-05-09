const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const W = canvas.width;
const H = canvas.height;

// ===== 定数 =====
const GRAVITY = 0.6;
const JUMP_FORCE = -14;
const MOVE_SPEED = 4.5;
const BLAST_ZONE = { left: -200, right: W + 200, top: -300, bottom: H + 100 };
const GAME_DURATION = 180; // 3分
const MAX_STOCKS = 3;
const LONG_PRESS_MS = 800;
const KNOCKBACK_BASE = 0.08;

// ===== ステージ定義 =====
const MAIN_PLATFORM = { x: 200, y: 420, w: 600, h: 20 };
const PLATFORMS = [
  { x: 150, y: 300, w: 160, h: 14 },
  { x: 420, y: 240, w: 160, h: 14 },
  { x: 690, y: 300, w: 160, h: 14 },
];

// ===== ゲーム状態 =====
let gameState = 'countdown'; // countdown | playing | result
let countdown = 3;
let countdownTimer = 0;
let gameTimer = GAME_DURATION;
let gameTimerMs = 0;
let winner = null;
let particles = [];
let projectiles = [];

// ===== キャラクタークラス =====
class Player {
  constructor(id, x, color, keys) {
    this.id = id;
    this.x = x;
    this.y = 200;
    this.w = 36;
    this.h = 52;
    this.vx = 0;
    this.vy = 0;
    this.color = color;
    this.keys = keys;

    this.stocks = MAX_STOCKS;
    this.damage = 0;
    this.onGround = false;
    this.onPlatform = null;
    this.facing = id === 1 ? 1 : -1;
    this.jumpsLeft = 2;

    // 状態フラグ
    this.isDead = false;
    this.respawnTimer = 0;
    this.isGuarding = false;
    this.isCrouching = false;
    this.isAttacking = false;
    this.attackTimer = 0;
    this.attackType = null;
    this.attackHit = false; // 1回の攻撃でヒット済みか

    // 長押し管理
    this.attackKeyHeld = false;
    this.attackHoldStart = 0;
    this.attackReleased = true;

    // つかみ
    this.isGrabbing = false;
    this.grabTarget = null;
    this.grabTimer = 0;

    // ノックバック
    this.hitstunTimer = 0;
  }

  get centerX() { return this.x + this.w / 2; }
  get centerY() { return this.y + this.h / 2; }
  get footY() { return this.y + this.h; }

  get inHitstun() { return this.hitstunTimer > 0; }
  get canControl() { return !this.inHitstun && !this.isDead && !this.isGrabbing; }

  update(dt, other) {
    if (this.isDead) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn();
      return;
    }

    if (this.hitstunTimer > 0) this.hitstunTimer -= dt;

    this.handleInput(other);
    this.applyPhysics(dt);
    this.updateAttack(dt, other);
    this.updateGrab(dt, other);
    this.checkBlastZone();
  }

  handleInput(other) {
    if (!this.canControl) return;
    const k = keys;
    const left = k[this.keys.left];
    const right = k[this.keys.right];
    const up = k[this.keys.up];
    const down = k[this.keys.down];
    const atk = k[this.keys.attack];

    // ガード（左右同時押し）
    this.isGuarding = left && right && this.onGround;

    if (this.isGuarding) {
      this.vx *= 0.8;
      return;
    }

    // しゃがみ
    this.isCrouching = down && this.onGround;

    // 移動
    if (!this.isAttacking) {
      if (left && !right) {
        this.vx = -MOVE_SPEED;
        this.facing = -1;
      } else if (right && !left) {
        this.vx = MOVE_SPEED;
        this.facing = 1;
      } else {
        this.vx *= 0.75;
      }
    }

    // ジャンプ
    if (up && !this._prevUp) {
      if (this.jumpsLeft > 0) {
        this.vy = JUMP_FORCE;
        if (this.jumpsLeft === 1) this.vy = JUMP_FORCE * 0.85; // 2段ジャンプは少し低め
        this.jumpsLeft--;
        this.onGround = false;
        this.onPlatform = null;
      }
    }
    this._prevUp = up;

    // 攻撃キー長押し判定
    if (atk && !this.isAttacking && this.attackReleased) {
      if (!this.attackKeyHeld) {
        this.attackKeyHeld = true;
        this.attackHoldStart = Date.now();
      }
    }
    if (!atk && this.attackKeyHeld) {
      // 離したときに攻撃発動
      this.attackKeyHeld = false;
      this.attackReleased = false;
      const held = Date.now() - this.attackHoldStart;
      this.triggerAttack(held, left, right, up, down, other);
    }
    if (!atk) this.attackReleased = true;
  }

  triggerAttack(heldMs, left, right, up, down, other) {
    if (this.isAttacking) return;

    const horizInput = (left && !right) ? -1 : (right && !left) ? 1 : 0;

    if (!this.onGround) {
      // 空中攻撃
      this.startAttack('air_slam', 25);
      return;
    }

    if (heldMs >= LONG_PRESS_MS) {
      // 波動拳
      this.startAttack('hadouken', 40);
      return;
    }

    if (down) {
      // つかみ
      this.startAttack('grab', 30);
      return;
    }

    if (up) {
      // アッパー
      this.startAttack('upper', 22);
      return;
    }

    if (horizInput !== 0) {
      // スライド2段ジャブ
      this.facing = horizInput;
      this.startAttack('slide_jab', 20);
      return;
    }

    // 強パンチ
    this.startAttack('strong_punch', 25);
  }

  startAttack(type, duration) {
    this.isAttacking = true;
    this.attackType = type;
    this.attackTimer = duration;
    this.attackHit = false;

    if (type === 'slide_jab') {
      this.vx = this.facing * 5;
    }
    if (type === 'upper') {
      this.vy = -8;
    }
  }

  updateAttack(dt, other) {
    if (!this.isAttacking) return;
    this.attackTimer -= dt;

    // ハドーケン発射（attackTimer が duration-1 になった瞬間）
    if (this.attackType === 'hadouken' && this.attackTimer === 39) {
      projectiles.push(new Projectile(
        this.centerX + this.facing * 20,
        this.centerY - 5,
        this.facing,
        this.id
      ));
    }

    if (!this.attackHit && this.attackType !== 'hadouken') {
      this.checkAttackHit(other);
    }

    if (this.attackTimer <= 0) {
      this.isAttacking = false;
      this.attackType = null;
      this.isGrabbing = false;
    }
  }

  checkAttackHit(other) {
    if (other.isDead || other.stocks <= 0) return;
    const hitbox = this.getAttackHitbox();
    if (!hitbox) return;

    // ガード判定
    const otherBox = { x: other.x, y: other.y, w: other.w, h: other.h };
    if (rectsOverlap(hitbox, otherBox)) {
      if (other.isGuarding && this.attackType !== 'grab') {
        // ガード成功
        spawnParticles(other.centerX, other.centerY, '#aaaaff', 5);
        this.attackHit = true;
        return;
      }

      // ヒット！
      this.attackHit = true;
      const dmg = this.getAttackDamage();
      const kb = this.getKnockback(dmg, other.damage);
      const kbDir = this.getKnockbackDir();

      other.takeDamage(dmg, kb.x * kbDir, kb.y);
      spawnParticles(other.centerX, other.centerY, '#ff4444', 10);

      if (this.attackType === 'grab') {
        this.isGrabbing = true;
        this.grabTarget = other;
        this.grabTimer = 20;
        other.isGrabbing = true;
      }
    }
  }

  getAttackHitbox() {
    const cx = this.centerX;
    const cy = this.centerY;
    const f = this.facing;

    switch (this.attackType) {
      case 'strong_punch':
        // しゃがみに当たらない（y範囲を上半分に限定）
        return { x: cx + f * 10, y: this.y - 5, w: 40, h: 25 };
      case 'upper':
        return { x: cx - 15, y: this.y - 40, w: 30, h: 40 };
      case 'slide_jab':
        return { x: cx + f * 5, y: cy - 15, w: 45, h: 30 };
      case 'grab':
        return { x: cx + f * 10, y: cy - 10, w: 45, h: 30 };
      case 'air_slam':
        return { x: cx + f * 5, y: cy + 10, w: 40, h: 30 };
      default:
        return null;
    }
  }

  getAttackDamage() {
    const table = {
      strong_punch: 12,
      upper: 10,
      slide_jab: 7,
      grab: 8,
      air_slam: 11,
      hadouken: 9,
    };
    return table[this.attackType] || 8;
  }

  getKnockback(dmg, receiverDmg) {
    const base = (dmg + receiverDmg) * KNOCKBACK_BASE;
    return { x: base * 1.2, y: -(base * 0.8 + 5) };
  }

  getKnockbackDir() {
    return this.facing;
  }

  updateGrab(dt, other) {
    if (!this.isGrabbing || !this.grabTarget) return;
    this.grabTimer -= dt;
    other.x = this.x + this.facing * (this.w + 2);
    other.y = this.y;
    other.vx = 0;
    other.vy = 0;
    if (this.grabTimer <= 0) {
      this.releaseGrab();
    }
  }

  releaseGrab() {
    if (this.grabTarget) {
      const target = this.grabTarget;
      target.isGrabbing = false;
      target.vx = this.facing * 8;
      target.vy = -5;
      target.hitstunTimer = 20;
    }
    this.isGrabbing = false;
    this.grabTarget = null;
  }

  takeDamage(dmg, kbx, kby) {
    this.damage += dmg;
    this.vx = kbx;
    this.vy = kby;
    this.hitstunTimer = 18 + dmg * 0.5;
    this.onGround = false;
    this.onPlatform = null;
  }

  applyPhysics(dt) {
    if (this.isDead) return;

    // 重力
    this.vy += GRAVITY;

    this.x += this.vx;
    this.y += this.vy;

    this.onGround = false;
    this.onPlatform = null;

    // メインステージとの衝突
    this.collideWithPlatform(MAIN_PLATFORM, true);

    // サブプラットフォームとの衝突（下から貫通可能）
    for (const plat of PLATFORMS) {
      this.collideWithPlatform(plat, false);
    }

    // 画面左右の壁（ブラストゾーン内のみ）
    if (this.x < BLAST_ZONE.left || this.x > BLAST_ZONE.right ||
        this.y < BLAST_ZONE.top || this.y > BLAST_ZONE.bottom) {
      return; // ブラストゾーン判定はcheckBlastZoneで処理
    }
  }

  collideWithPlatform(plat, solid) {
    const wasAbove = (this.y + this.h - this.vy) <= plat.y + 2;
    const feetY = this.y + this.h;
    const inXRange = this.x + this.w > plat.x && this.x < plat.x + plat.w;

    if (inXRange && wasAbove && feetY >= plat.y && feetY <= plat.y + plat.h + 10 && this.vy >= 0) {
      this.y = plat.y - this.h;
      this.vy = 0;
      this.onGround = true;
      this.onPlatform = plat;
      this.jumpsLeft = 2;
      this.isCrouching = keys[this.keys.down] || false;
    }

    // メインステージのみ左右・下の衝突判定
    if (solid) {
      // 左壁
      if (this.x + this.w > plat.x && this.x < plat.x && this.y + this.h > plat.y) {
        this.x = plat.x - this.w;
        this.vx = 0;
      }
      // 右壁
      if (this.x < plat.x + plat.w && this.x + this.w > plat.x + plat.w && this.y + this.h > plat.y) {
        this.x = plat.x + plat.w;
        this.vx = 0;
      }
    }
  }

  checkBlastZone() {
    if (this.isDead) return;
    if (this.x + this.w < BLAST_ZONE.left || this.x > BLAST_ZONE.right ||
        this.y + this.h < BLAST_ZONE.top || this.y > BLAST_ZONE.bottom) {
      this.die();
    }
  }

  die() {
    this.stocks--;
    this.isDead = true;
    this.isAttacking = false;
    this.isGrabbing = false;
    this.respawnTimer = 90;
    spawnParticles(this.centerX, this.centerY, this.color, 20);
  }

  respawn() {
    this.isDead = false;
    this.x = this.id === 1 ? 280 : 620;
    this.y = 100;
    this.vx = 0;
    this.vy = 0;
    this.damage = 0;
    this.jumpsLeft = 2;
    this.hitstunTimer = 0;
    this.isAttacking = false;
    this.isGuarding = false;
    this.isCrouching = false;
  }

  draw(ctx) {
    if (this.isDead) return;

    const x = this.x;
    const y = this.y;
    const w = this.w;
    const h = this.h;

    ctx.save();

    // 無敵点滅（リスポーン後）
    if (this.respawnTimer < 0 && Math.floor(Date.now() / 100) % 2 === 0 && !this.isDead) {
      ctx.globalAlpha = 0.5;
    }

    // ガードエフェクト
    if (this.isGuarding) {
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w * 0.8, h * 0.7, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(100, 150, 255, 0.4)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(100, 150, 255, 0.9)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // 体（下半身：大きい円）
    const bodyR = w * 0.5;
    const bodyX = x + w / 2;
    const bodyY = y + h * 0.65;
    ctx.beginPath();
    ctx.arc(bodyX, bodyY, bodyR, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.strokeStyle = this.inHitstun ? '#ffffff' : '#00000055';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 頭（上半身：小さい円）
    const headR = w * 0.38;
    const headX = x + w / 2;
    const headY = y + h * 0.28;
    ctx.beginPath();
    ctx.arc(headX, headY, headR, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.strokeStyle = this.inHitstun ? '#ffffff' : '#00000055';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 目
    const eyeOffX = this.facing * headR * 0.35;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(headX + eyeOffX - headR * 0.15, headY - 2, 4, 0, Math.PI * 2);
    ctx.arc(headX + eyeOffX + headR * 0.2, headY - 2, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#222222';
    ctx.beginPath();
    ctx.arc(headX + eyeOffX - headR * 0.15 + this.facing, headY - 2, 2, 0, Math.PI * 2);
    ctx.arc(headX + eyeOffX + headR * 0.2 + this.facing, headY - 2, 2, 0, Math.PI * 2);
    ctx.fill();

    // しゃがみ時は体を少し下げて潰す
    if (this.isCrouching) {
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.ellipse(bodyX, bodyY + 5, bodyR * 1.1, bodyR * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 攻撃エフェクト
    if (this.isAttacking) {
      this.drawAttackEffect(ctx, x, y, w, h);
    }

    ctx.restore();
  }

  drawAttackEffect(ctx, x, y, w, h) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const f = this.facing;
    const progress = 1 - this.attackTimer / this.getAttackDuration();

    ctx.save();
    ctx.strokeStyle = '#ffdd00';
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.8;

    switch (this.attackType) {
      case 'strong_punch':
        ctx.beginPath();
        ctx.arc(cx + f * 30 * progress, y + 10, 12 * progress + 5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ff8800';
        ctx.stroke();
        break;
      case 'upper':
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + f * 10, cy - 40 * progress);
        ctx.stroke();
        break;
      case 'slide_jab':
        ctx.beginPath();
        ctx.arc(cx + f * 35, cy, 10, 0, Math.PI * 2);
        ctx.stroke();
        if (progress > 0.5) {
          ctx.beginPath();
          ctx.arc(cx + f * 45, cy - 5, 8, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      case 'grab':
        ctx.strokeStyle = '#00ff88';
        ctx.beginPath();
        ctx.arc(cx + f * 30, cy, 14, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'air_slam':
        ctx.strokeStyle = '#ff4488';
        ctx.beginPath();
        ctx.arc(cx + f * 20, cy + 20, 13, 0, Math.PI * 2);
        ctx.stroke();
        break;
    }
    ctx.restore();
  }

  getAttackDuration() {
    const table = {
      strong_punch: 25,
      upper: 22,
      slide_jab: 20,
      grab: 30,
      air_slam: 25,
      hadouken: 40,
    };
    return table[this.attackType] || 25;
  }
}

// ===== 飛び道具クラス =====
class Projectile {
  constructor(x, y, dir, ownerId) {
    this.x = x;
    this.y = y;
    this.vx = dir * 8;
    this.vy = 0;
    this.ownerId = ownerId;
    this.w = 18;
    this.h = 18;
    this.alive = true;
    this.age = 0;
  }

  update(players) {
    this.x += this.vx;
    this.age++;

    if (this.age > 120 || this.x < -50 || this.x > W + 50) {
      this.alive = false;
      return;
    }

    for (const p of players) {
      if (p.id === this.ownerId || p.isDead) continue;
      if (rectsOverlap({ x: this.x - this.w / 2, y: this.y - this.h / 2, w: this.w, h: this.h },
                        { x: p.x, y: p.y, w: p.w, h: p.h })) {
        if (p.isGuarding) {
          spawnParticles(p.centerX, p.centerY, '#aaaaff', 5);
        } else {
          const dmg = 9;
          const kb = (dmg + p.damage) * KNOCKBACK_BASE;
          p.takeDamage(dmg, this.vx > 0 ? kb * 1.2 : -kb * 1.2, -(kb * 0.5 + 3));
          spawnParticles(p.centerX, p.centerY, '#ff4444', 10);
        }
        this.alive = false;
        spawnParticles(this.x, this.y, '#ffaa00', 8);
      }
    }
  }

  draw(ctx) {
    if (!this.alive) return;
    ctx.save();
    // 波動拳：青白い球
    const grd = ctx.createRadialGradient(this.x, this.y, 2, this.x, this.y, this.w / 2);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(0.5, '#44aaff');
    grd.addColorStop(1, 'rgba(0, 100, 255, 0)');
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.w / 2, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();
    // リング
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.w / 2 + 3, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(100, 200, 255, 0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
}

// ===== パーティクル =====
function spawnParticles(x, y, color, count) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 4 + 1;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 30 + Math.random() * 20,
      maxLife: 50,
      color,
      r: Math.random() * 4 + 2,
    });
  }
}

function updateParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.15;
    p.life--;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function drawParticles(ctx) {
  for (const p of particles) {
    ctx.save();
    ctx.globalAlpha = p.life / p.maxLife;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ===== ユーティリティ =====
function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

// ===== キー入力 =====
const keys = {};
window.addEventListener('keydown', e => {
  keys[e.code] = true;
  e.preventDefault();
});
window.addEventListener('keyup', e => {
  keys[e.code] = false;
});

// ===== プレイヤー設定 =====
const player1Keys = {
  left: 'KeyA', right: 'KeyD', up: 'KeyW', down: 'KeyS', attack: 'Space'
};
const player2Keys = {
  left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', attack: 'Enter'
};

let player1, player2;

function initPlayers() {
  player1 = new Player(1, 280, '#e84040', player1Keys);
  player2 = new Player(2, 620, '#4060e8', player2Keys);
  player1.facing = 1;
  player2.facing = -1;
}

// ===== 描画 =====
function drawBackground(ctx) {
  // 空のグラデーション
  const skyGrd = ctx.createLinearGradient(0, 0, 0, H);
  skyGrd.addColorStop(0, '#0a1628');
  skyGrd.addColorStop(0.6, '#0f3460');
  skyGrd.addColorStop(1, '#1a1a4e');
  ctx.fillStyle = skyGrd;
  ctx.fillRect(0, 0, W, H);

  // 星
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  const starSeeds = [
    [80, 50], [200, 30], [350, 80], [500, 20], [650, 60],
    [750, 40], [880, 90], [120, 120], [420, 100], [900, 30]
  ];
  for (const [sx, sy] of starSeeds) {
    ctx.beginPath();
    ctx.arc(sx, sy, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // 雲っぽい背景装飾
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = '#ffffff';
  [[150, 180, 80, 35], [600, 150, 100, 40], [850, 200, 70, 30]].forEach(([cx, cy, rw, rh]) => {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
}

function drawStage(ctx) {
  // メインステージ（岩の島）
  const mp = MAIN_PLATFORM;

  // 島の影
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(mp.x + mp.w / 2, mp.y + mp.h + 15, mp.w * 0.4, 12, 0, 0, Math.PI * 2);
  ctx.fill();

  // 島本体（土台）
  const islandGrd = ctx.createLinearGradient(mp.x, mp.y, mp.x, mp.y + 50);
  islandGrd.addColorStop(0, '#8B7355');
  islandGrd.addColorStop(1, '#5C4A2A');
  ctx.fillStyle = islandGrd;
  ctx.beginPath();
  ctx.roundRect(mp.x - 10, mp.y, mp.w + 20, 50, [8]);
  ctx.fill();

  // 草の表面
  const grassGrd = ctx.createLinearGradient(mp.x, mp.y - 8, mp.x, mp.y + mp.h);
  grassGrd.addColorStop(0, '#4CAF50');
  grassGrd.addColorStop(1, '#2E7D32');
  ctx.fillStyle = grassGrd;
  ctx.beginPath();
  ctx.roundRect(mp.x - 8, mp.y - 8, mp.w + 16, mp.h + 12, [6, 6, 0, 0]);
  ctx.fill();

  // 草のライン
  ctx.strokeStyle = '#66BB6A';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mp.x - 8, mp.y - 2);
  ctx.lineTo(mp.x + mp.w + 8, mp.y - 2);
  ctx.stroke();

  // サブプラットフォーム
  for (const plat of PLATFORMS) {
    // 台の影
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.ellipse(plat.x + plat.w / 2, plat.y + 20, plat.w * 0.4, 8, 0, 0, Math.PI * 2);
    ctx.fill();

    // 台本体
    const platGrd = ctx.createLinearGradient(plat.x, plat.y, plat.x, plat.y + plat.h + 10);
    platGrd.addColorStop(0, '#5C8A3C');
    platGrd.addColorStop(1, '#3D5C28');
    ctx.fillStyle = platGrd;
    ctx.beginPath();
    ctx.roundRect(plat.x - 4, plat.y - 4, plat.w + 8, plat.h + 14, [4]);
    ctx.fill();

    // 台の表面
    ctx.fillStyle = '#66BB6A';
    ctx.beginPath();
    ctx.roundRect(plat.x - 3, plat.y - 4, plat.w + 6, plat.h + 4, [3, 3, 0, 0]);
    ctx.fill();
  }
}

function drawHUD(ctx) {
  // 上部バー背景
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, W, 70);

  // タイマー
  const minutes = Math.floor(gameTimer / 60);
  const seconds = Math.floor(gameTimer % 60);
  const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  ctx.fillStyle = gameTimer <= 30 ? '#ff4444' : '#ffffff';
  ctx.font = 'bold 28px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(timeStr, W / 2, 38);

  ctx.font = '13px Arial';
  ctx.fillStyle = '#aaaaaa';
  ctx.fillText('TIME', W / 2, 55);

  // P1 情報
  drawPlayerHUD(ctx, player1, 50);
  // P2 情報
  drawPlayerHUD(ctx, player2, W - 50);
}

function drawPlayerHUD(ctx, player, x) {
  const isP1 = player.id === 1;
  ctx.textAlign = isP1 ? 'left' : 'right';

  // ストックアイコン
  const stockX = isP1 ? x : x - (player.stocks - 1) * 22;
  for (let i = 0; i < player.stocks; i++) {
    ctx.beginPath();
    ctx.arc(stockX + i * 22 + (isP1 ? 0 : 22), 50, 8, 0, Math.PI * 2);
    ctx.fillStyle = player.color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // プレイヤー名
  ctx.font = 'bold 14px Arial';
  ctx.fillStyle = player.color;
  ctx.textAlign = isP1 ? 'left' : 'right';
  ctx.fillText(`P${player.id}`, x, 18);

  // ダメージ%
  const dmgColor = player.damage < 50 ? '#ffffff' :
                   player.damage < 100 ? '#ffaa00' : '#ff4444';
  ctx.font = 'bold 22px Arial';
  ctx.fillStyle = dmgColor;
  ctx.fillText(`${player.damage}%`, x + (isP1 ? 40 : -40), 38);
}

function drawCountdown(ctx) {
  const text = countdown > 0 ? countdown.toString() : 'GO!';
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 影
  ctx.font = 'bold 100px Arial';
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillText(text, W / 2 + 4, H / 2 + 4);

  // 本文
  ctx.fillStyle = countdown > 0 ? '#ffffff' : '#ffdd00';
  ctx.fillText(text, W / 2, H / 2);

  ctx.restore();
}

function drawResult(ctx) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const winColor = winner === 1 ? '#e84040' : winner === 2 ? '#4060e8' : '#ffffff';
  const winText = winner === 0 ? 'DRAW!' : `P${winner} WIN!`;

  ctx.font = 'bold 80px Arial';
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillText(winText, W / 2 + 4, H / 2 - 30 + 4);

  ctx.fillStyle = winColor;
  ctx.fillText(winText, W / 2, H / 2 - 30);

  ctx.font = '24px Arial';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('スペース / Enter でリトライ', W / 2, H / 2 + 50);

  ctx.restore();
}

// ===== ゲームロジック =====
function checkWin() {
  if (player1.stocks <= 0 && player2.stocks <= 0) {
    gameState = 'result';
    winner = 0; // 引き分け
  } else if (player1.stocks <= 0) {
    gameState = 'result';
    winner = 2;
  } else if (player2.stocks <= 0) {
    gameState = 'result';
    winner = 1;
  }
}

function checkTimeUp() {
  if (gameTimer <= 0) {
    gameState = 'result';
    if (player1.stocks > player2.stocks) winner = 1;
    else if (player2.stocks > player1.stocks) winner = 2;
    else if (player1.damage < player2.damage) winner = 1;
    else if (player2.damage < player1.damage) winner = 2;
    else winner = 0;
  }
}

function handleRetry() {
  if (keys['Space'] || keys['Enter']) {
    resetGame();
  }
}

function resetGame() {
  gameState = 'countdown';
  countdown = 3;
  countdownTimer = 0;
  gameTimer = GAME_DURATION;
  gameTimerMs = 0;
  winner = null;
  particles = [];
  projectiles = [];
  initPlayers();
}

// ===== メインループ =====
let lastTime = 0;

function gameLoop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 16.67, 3); // フレーム正規化
  lastTime = timestamp;

  ctx.clearRect(0, 0, W, H);

  drawBackground(ctx);
  drawStage(ctx);

  if (gameState === 'countdown') {
    countdownTimer++;
    if (countdownTimer % 60 === 0) {
      countdown--;
      if (countdown < 0) {
        gameState = 'playing';
        countdown = 0;
      }
    }
    drawCountdown(ctx);
    // カウントダウン中もプレイヤー表示
    player1.draw(ctx);
    player2.draw(ctx);

  } else if (gameState === 'playing') {
    // タイマー更新
    gameTimerMs += dt * (1000 / 60);
    if (gameTimerMs >= 1000) {
      gameTimerMs -= 1000;
      gameTimer--;
    }

    // 更新
    player1.update(dt, player2);
    player2.update(dt, player1);

    for (let i = projectiles.length - 1; i >= 0; i--) {
      projectiles[i].update([player1, player2]);
      if (!projectiles[i].alive) projectiles.splice(i, 1);
    }

    updateParticles();

    checkWin();
    checkTimeUp();

    // 描画
    for (const proj of projectiles) proj.draw(ctx);
    drawParticles(ctx);
    player1.draw(ctx);
    player2.draw(ctx);
    drawHUD(ctx);

  } else if (gameState === 'result') {
    player1.draw(ctx);
    player2.draw(ctx);
    drawParticles(ctx);
    drawHUD(ctx);
    drawResult(ctx);
    handleRetry();
  }

  requestAnimationFrame(gameLoop);
}

// ===== 起動 =====
initPlayers();
requestAnimationFrame(gameLoop);
