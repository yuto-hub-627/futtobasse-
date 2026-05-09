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
let gameState = 'menu'; // menu | countdown | playing | result
let gameMode  = '2p';   // '2p' | 'cpu'
let menuCursor = 0;     // 0=2P, 1=CPU
let menuNavCooldown = 0;
let countdown = 3;
let countdownTimer = 0;
let gameTimer = GAME_DURATION;
let gameTimerMs = 0;
let winner = null;
let particles = [];
let projectiles = [];
let screenShake = { x: 0, y: 0, timer: 0, intensity: 0 };

function triggerScreenShake(intensity) {
  screenShake.timer = 8;
  screenShake.intensity = intensity;
}

function updateScreenShake() {
  if (screenShake.timer > 0) {
    screenShake.timer--;
    const factor = screenShake.timer / 8;
    screenShake.x = (Math.random() - 0.5) * screenShake.intensity * factor;
    screenShake.y = (Math.random() - 0.5) * screenShake.intensity * factor;
  } else {
    screenShake.x = 0;
    screenShake.y = 0;
  }
}

// ===== キャラクタークラス =====
class Player {
  constructor(id, x, color, keys, isCPU = false) {
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
    this.isAttacking = false;
    this.attackTimer = 0;
    this.attackType = null;
    this.attackHit = false; // 1回の攻撃でヒット済みか
    this.hadoukenFired = false; // 波動拳発射済みか

    // 長押し管理
    this.attackKeyHeld = false;
    this.attackHoldStart = 0;
    this.attackReleased = true;
    this.attackDirSnapshot = { up: false, down: false, left: false, right: false };

    // つかみ
    this.isGrabbing = false;
    this.grabTarget = null;
    this.grabTimer = 0;

    // ノックバック
    this.hitstunTimer = 0;

    // ジャンプバッファ（上攻撃入力猶予）
    this.jumpBufferTimer = 0;

    // 台貫通タイマー
    this.dropTimer = 0;

    // CPU 制御
    this.isCPU = isCPU;
    this.cpuInput  = { left:false, right:false, up:false, down:false, attack:false };
    this.cpuActionCooldown  = 0;
    this.cpuAttackState     = null; // null | 'holding' | 'releasing'
    this.cpuAttackFrames    = 0;
    this.cpuAttackInputs    = {};

    // ジャストガード
    this.justGuardTimer  = 0; // ガード解除後のウィンドウ（フレーム）
    this.frozenTimer     = 0; // ジャストガードを食らった側が止まる時間
    this.speedBoostTimer = 0; // ジャストガード成功側の加速時間
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

    // ジャストガードによる凍結中：入力・物理を止め、ゆっくり静止する
    if (this.frozenTimer > 0) {
      this.frozenTimer -= dt;
      this.vx *= 0.82;
      this.vy *= 0.82;
      this.checkBlastZone();
      return;
    }

    if (this.isCPU) this.computeCPUInput(other);
    this.handleInput(other);
    this.applyPhysics(dt);
    this.updateAttack(dt, other);
    this.updateGrab(dt, other);
    this.checkBlastZone();
  }

  handleInput(other) {
    if (!this.canControl) return;
    let left, right, up, down, atk;
    if (this.isCPU) {
      ({ left, right, up, down, attack: atk } = this.cpuInput);
    } else {
      const k = keys;
      left  = k[this.keys.left];
      right = k[this.keys.right];
      up    = k[this.keys.up];
      down  = k[this.keys.down];
      atk   = k[this.keys.attack];
    }

    // ガード（左右同時押し）
    const wasGuarding = this.isGuarding;
    this.isGuarding = left && right && this.onGround;

    // ガードを離した瞬間にジャストガードウィンドウ開始
    if (wasGuarding && !this.isGuarding) {
      this.justGuardTimer = 5;
    }
    if (this.justGuardTimer > 0) this.justGuardTimer--;

    if (this.isGuarding) {
      this.vx *= 0.8;
      return;
    }

    // 移動（ジャストガード成功中は速度アップ）
    if (this.speedBoostTimer > 0) this.speedBoostTimer--;
    const spd = MOVE_SPEED * (this.speedBoostTimer > 0 ? 1.8 : 1.0);
    if (!this.isAttacking) {
      if (left && !right) {
        this.vx = -spd;
        this.facing = -1;
      } else if (right && !left) {
        this.vx = spd;
        this.facing = 1;
      } else {
        this.vx *= 0.75;
      }
    }

    // サブ台を下キーで貫通
    if (down && !this._prevDown && this.onGround && this.onPlatform !== MAIN_PLATFORM) {
      this.dropTimer = 12;
      this.y += 3;
      this.onGround = false;
      this.onPlatform = null;
    }
    this._prevDown = down;

    // ジャンプ（5フレームバッファ：その間に攻撃キーを押せば上攻撃が出る）
    if (up && !this._prevUp) {
      this.jumpBufferTimer = 5;
    }
    this._prevUp = up;

    // バッファ消費（攻撃キーを押している間は停止）
    if (this.jumpBufferTimer > 0 && !this.attackKeyHeld) {
      this.jumpBufferTimer--;
      if (this.jumpBufferTimer === 0) {
        if (this.jumpsLeft > 0) {
          this.vy = this.jumpsLeft === 2 ? JUMP_FORCE : JUMP_FORCE * 0.85;
          this.jumpsLeft--;
          this.onGround = false;
          this.onPlatform = null;
        }
      }
    }

    // 攻撃キー長押し判定
    if (atk && !this.isAttacking && this.attackReleased) {
      if (!this.attackKeyHeld) {
        this.attackKeyHeld = true;
        this.attackHoldStart = Date.now();
        // 押した瞬間の方向をスナップショット（上攻撃の入力バッファ）
        this.attackDirSnapshot = { up, down, left, right };
      }
    }
    if (!atk && this.attackKeyHeld) {
      // 離したときに攻撃発動
      this.attackKeyHeld = false;
      this.attackReleased = false;
      const held = Date.now() - this.attackHoldStart;
      // 押した時か離した時のどちらかで方向が入力されていれば有効
      const mergedUp   = up   || this.attackDirSnapshot.up;
      const mergedDown = down || this.attackDirSnapshot.down;
      const mergedLeft = left || this.attackDirSnapshot.left;
      const mergedRight= right|| this.attackDirSnapshot.right;
      this.triggerAttack(held, mergedLeft, mergedRight, mergedUp, mergedDown, other);
    }
    if (!atk) this.attackReleased = true;
  }

  triggerAttack(heldMs, left, right, up, down, other) {
    if (this.isAttacking) return;
    this.jumpBufferTimer = 0;

    const horizInput = (left && !right) ? -1 : (right && !left) ? 1 : 0;
    const anyDir = up || down || left || right;

    // 方向入力あり → 方向攻撃（地上・空中共通）
    if (anyDir) {
      if (down) {
        // 地上：つかみ　空中：下パンチ
        this.startAttack(this.onGround ? 'grab' : 'down_punch', this.onGround ? 60 : 22);
        return;
      }
      if (up) {
        this.startAttack('upper', 22);
        return;
      }
      if (horizInput !== 0) {
        this.facing = horizInput;
        this.startAttack('slide_jab', 20);
        return;
      }
    }

    // 方向入力なし
    if (heldMs >= LONG_PRESS_MS) {
      this.startAttack('hadouken', 40);
      return;
    }

    this.startAttack('strong_punch', 25);
  }

  startAttack(type, duration) {
    this.isAttacking = true;
    this.attackType = type;
    this.attackTimer = duration;
    this.attackHit = false;
    this.hadoukenFired = false;

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

    // 波動拳発射（最初の1フレームのみ）
    if (this.attackType === 'hadouken' && !this.hadoukenFired) {
      this.hadoukenFired = true;
      projectiles.push(new Projectile(
        this.centerX + this.facing * 24,
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
      // isGrabbing は grabTimer が管理するためここではクリアしない
    }
  }

  checkAttackHit(other) {
    if (other.isDead || other.stocks <= 0) return;
    const hitbox = this.getAttackHitbox();
    if (!hitbox) return;

    // ガード判定
    const otherBox = { x: other.x, y: other.y, w: other.w, h: other.h };
    if (rectsOverlap(hitbox, otherBox)) {
      // ジャストガード判定（ガード解除直後のウィンドウ内に被弾）
      if (other.justGuardTimer > 0 && this.attackType !== 'grab') {
        other.justGuardTimer  = 0;
        this.frozenTimer      = 48;        // 攻撃側が0.8秒止まる
        this.vx *= 0.05;
        this.vy *= 0.05;
        other.speedBoostTimer = 65;        // 防御側が約1秒加速
        spawnParticles(other.centerX, other.centerY, '#ffee44', 20);
        spawnParticles(other.centerX, other.centerY, '#ffffff', 10);
        triggerScreenShake(5);
        this.attackHit = true;
        return;
      }

      if (other.isGuarding && this.attackType !== 'grab') {
        // 通常ガード成功
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
      triggerScreenShake(dmg > 10 ? 8 : 5);

      if (this.attackType === 'grab') {
        this.isGrabbing = true;
        this.grabTarget = other;
        this.grabTimer = 45;
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
        return { x: f > 0 ? cx + 10 : cx - 50, y: this.y - 5,  w: 40, h: 25 };
      case 'upper':
        return { x: cx - 15,                   y: this.y - 40, w: 30, h: 40 };
      case 'slide_jab':
        return { x: f > 0 ? cx + 5  : cx - 50, y: cy - 15,    w: 45, h: 30 };
      case 'grab':
        return { x: f > 0 ? cx + 10 : cx - 55, y: cy - 10,    w: 45, h: 30 };
      case 'air_slam':
        return { x: f > 0 ? cx + 5  : cx - 45, y: cy + 10,    w: 40, h: 30 };
      case 'down_punch':
        return { x: cx - 18, y: cy + 5, w: 36, h: 35 };
      default:
        return null;
    }
  }

  getAttackDamage() {
    const table = {
      strong_punch: 20,  // 短押しのみ
      hadouken:     15,  // 長押しのみ
      upper:        10,  // 上＋攻撃
      slide_jab:    10,  // 横＋攻撃
      air_slam:     10,
      down_punch:   10,  // 空中下パンチ
      grab:          8,  // 下＋攻撃（つかみ）
    };
    return table[this.attackType] || 8;
  }

  getKnockback(dmg, receiverDmg) {
    const base = (dmg + receiverDmg) * KNOCKBACK_BASE;
    // 下パンチはスパイク（下方向ノックバック）
    if (this.attackType === 'down_punch') {
      return { x: base * 0.35, y: base * 2.0 + 5 }; // 正のy＝下向き
    }
    const mul = {
      strong_punch: 2.2,
      upper:        1.3,
      air_slam:     1.4,
      slide_jab:    0.8,
    }[this.attackType] ?? 1.0;
    return { x: base * 1.2 * mul, y: -(base * 0.8 + 5) * mul };
  }

  getKnockbackDir() {
    return this.facing;
  }

  updateGrab(dt, other) {
    if (!this.isGrabbing || !this.grabTarget) return;
    this.grabTimer -= dt;

    if (this.grabTimer > 25) {
      // 引き寄せフェーズ：相手をこちらへ引っ張る
      const targetX = this.x + this.facing * (this.w + 4);
      const targetY = this.y + 4;
      other.x += (targetX - other.x) * 0.28;
      other.y += (targetY - other.y) * 0.28;
    } else if (this.grabTimer > 5) {
      // 保持フェーズ：固定
      other.x = this.x + this.facing * (this.w + 3);
      other.y = this.y + 4;
    }
    // grabTimer <= 5 は releaseGrab に委ねる
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
      target.vx = this.facing * 10;
      target.vy = -7;
      target.hitstunTimer = 22;
      triggerScreenShake(10);
      spawnParticles(target.centerX, target.centerY, '#ff6600', 16);
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
    this.isGuarding = false;
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
    // 貫通タイマー中はサブ台の衝突をスキップ
    if (!solid && this.dropTimer > 0) {
      this.dropTimer--;
      return;
    }

    const wasAbove = (this.y + this.h - this.vy) <= plat.y + 2;
    const feetY = this.y + this.h;
    const inXRange = this.x + this.w > plat.x && this.x < plat.x + plat.w;

    if (inXRange && wasAbove && feetY >= plat.y && feetY <= plat.y + plat.h + 10 && this.vy >= 0) {
      this.y = plat.y - this.h;
      this.vy = 0;
      this.onGround = true;
      this.onPlatform = plat;
      this.jumpsLeft = 2;
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
    this.x = this.id === 1 ? 322 : 642;
    this.y = 100;
    this.vx = 0;
    this.vy = 0;
    this.damage = 0;
    this.jumpsLeft = 2;
    this.hitstunTimer = 0;
    this.isAttacking = false;
    this.isGuarding = false;
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

    const midX  = x + w / 2;
    const stroke = this.inHitstun ? '#ffffff' : '#00000055';

    // 体（下半身）
    const bodyR = w * 0.5;
    const bodyY = y + h * 0.65;
    ctx.beginPath();
    ctx.arc(midX, bodyY, bodyR, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();

    // 頭（上半身）
    const headR = w * 0.38;
    const headY = y + h * 0.28;
    ctx.beginPath();
    ctx.arc(midX, headY, headR, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();

    // 目
    const eyeOffX = this.facing * headR * 0.35;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(midX + eyeOffX - headR * 0.15, headY - 2, 4, 0, Math.PI * 2);
    ctx.arc(midX + eyeOffX + headR * 0.2,  headY - 2, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#222222';
    ctx.beginPath();
    ctx.arc(midX + eyeOffX - headR * 0.15 + this.facing, headY - 2, 2, 0, Math.PI * 2);
    ctx.arc(midX + eyeOffX + headR * 0.2  + this.facing, headY - 2, 2, 0, Math.PI * 2);
    ctx.fill();

    // ジャストガード凍結ビジュアル（攻撃側：青白い氷結リング）
    if (this.frozenTimer > 0) {
      const t = this.frozenTimer / 48;
      ctx.save();
      ctx.strokeStyle = `rgba(140,220,255,${t * 0.85})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(midX, bodyY, bodyR * 1.3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(200,240,255,${t * 0.5})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(midX, headY, headR * 1.3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // ジャストガード速度ブーストビジュアル（防御側：黄金のオーラ）
    if (this.speedBoostTimer > 0) {
      const t = this.speedBoostTimer / 65;
      const pulse = Math.sin(Date.now() / 60) * 0.5 + 0.5;
      ctx.save();
      ctx.strokeStyle = `rgba(255,220,50,${t * (0.6 + pulse * 0.3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(midX, bodyY, bodyR * (1.2 + pulse * 0.1), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 波動拳チャージ完了グロー（控えめ）
    if (this.attackKeyHeld && !this.isAttacking) {
      const heldMs = Date.now() - this.attackHoldStart;
      if (heldMs >= LONG_PRESS_MS) {
        const pulse = Math.sin(Date.now() / 120) * 0.5 + 0.5;
        ctx.save();
        ctx.strokeStyle = `rgba(120,200,255,${0.3 + pulse * 0.2})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(midX, bodyY, bodyR * (1.25 + pulse * 0.15), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 攻撃エフェクト（つかみは攻撃側のみ描画）
    if (this.isAttacking || (this.isGrabbing && this.grabTarget !== null)) {
      this.drawAttackEffect(ctx, x, y, w, h);
    }

    ctx.restore();
  }

  drawAttackEffect(ctx, x, y, w, h) {
    // isGrabbing 中は attackType が null になる場合があるのでフォールバック
    const type = this.attackType ?? (this.isGrabbing ? 'grab' : null);
    if (!type) return;

    const cx = x + w / 2;
    const cy = y + h / 2;
    const f = this.facing;
    const dur = this.getAttackDuration();
    const progress = dur > 0 ? 1 - this.attackTimer / dur : 1;

    ctx.save();

    switch (type) {
      case 'strong_punch': {
        const fistX = cx + f * (5 + 42 * progress);
        const fistY = y + h * 0.22;
        drawSpeedLines(ctx, fistX, fistY, f, progress, this.color);
        drawFist(ctx, fistX, fistY, f, 0.85 + progress * 0.35, this.color);
        if (progress > 0.6) drawImpactStar(ctx, fistX + f * 18, fistY, progress, '#ff8800');
        break;
      }
      case 'upper': {
        // 最初から上向きの拳が真上に突き上がる
        const fistY = cy - 50 * progress;
        drawSpeedLines(ctx, cx, fistY, f, progress, this.color, true);
        drawFist(ctx, cx, fistY, f, 0.9 + progress * 0.2, this.color, Math.PI * 0.5);
        if (progress > 0.5) drawImpactStar(ctx, cx, fistY - 10, progress, '#ffdd00');
        break;
      }
      case 'slide_jab': {
        if (progress < 0.55) {
          const p1 = progress / 0.55;
          const fistX = cx + f * (14 + 22 * p1);
          drawSpeedLines(ctx, fistX, cy - 4, f, p1, this.color);
          drawFist(ctx, fistX, cy - 4, f, 0.72, this.color);
        } else {
          const p2 = (progress - 0.55) / 0.45;
          const fistX = cx + f * (20 + 26 * p2);
          drawSpeedLines(ctx, fistX, cy - 10, f, p2, this.color);
          drawFist(ctx, fistX, cy - 10, f, 0.82, this.color);
          if (p2 > 0.7) drawImpactStar(ctx, fistX + f * 14, cy - 10, p2, '#ffaa00');
        }
        break;
      }
      case 'grab': {
        if (this.isGrabbing) {
          if (this.grabTimer <= 5) {
            // 吹っ飛ばし：両腕を大きく前に押し出す
            drawGrabHand(ctx, cx + f * 36, cy - 12, f, 1.05, this.color);
            drawGrabHand(ctx, cx + f * 28, cy + 8,  f, 1.0,  this.color);
            drawImpactStar(ctx, cx + f * 50, cy - 2, 0.95, '#00ff88');
          } else if (this.grabTimer <= 25) {
            // 保持：両手で掴んでいる
            drawGrabHand(ctx, cx + f * 22, cy - 6, f, 0.92, this.color);
            drawGrabHand(ctx, cx + f * 28, cy + 9, f, 0.88, this.color);
          } else {
            // 引き寄せ中：腕が前に伸びている
            const pull = 1 - (this.grabTimer - 25) / 20;
            drawGrabHand(ctx, cx + f * (20 + 8 * pull), cy - 5, f, 0.9, this.color);
            drawGrabHand(ctx, cx + f * (15 + 12 * pull), cy + 9, f, 0.9, this.color);
          }
        } else {
          // リーチ（まだ掴んでいない）
          const reach = Math.min(progress * 2.5, 1);
          drawGrabHand(ctx, cx + f * (5 + 30 * reach), cy - 8, f, 0.88, this.color);
          drawGrabHand(ctx, cx + f * (3 + 26 * reach), cy + 7, f, 0.88, this.color);
        }
        break;
      }
      case 'hadouken': {
        // チャージ後の発射ポーズ：両拳を前に押し出す
        const push = Math.min(progress * 3, 1);
        drawFist(ctx, cx + f * (12 + 14 * push), cy - 4, f, 0.72, this.color);
        drawFist(ctx, cx + f * (8  + 10 * push), cy + 7, f, 0.72, this.color);
        break;
      }
      case 'air_slam': {
        const fistY = cy + 12 + 32 * progress;
        drawSpeedLines(ctx, cx + f * 12, fistY, f, progress, this.color, true);
        drawFist(ctx, cx + f * 12, fistY, f, 1.1, this.color, Math.PI * 0.5);
        if (progress > 0.6) drawImpactStar(ctx, cx + f * 12, fistY + 15, progress, '#ff4488');
        break;
      }
      case 'down_punch': {
        // 真下へ振り下ろす拳（スパイク）
        const fistY = cy + 10 + 30 * progress;
        drawSpeedLines(ctx, cx, fistY, f, progress, this.color, true);
        drawFist(ctx, cx, fistY, f, 1.1, this.color, -Math.PI * 0.5);
        if (progress > 0.6) drawImpactStar(ctx, cx, fistY + 14, progress, '#cc44ff');
        break;
      }
    }

    ctx.restore();
  }

  getAttackDuration() {
    const table = {
      strong_punch: 25,
      upper:        22,
      slide_jab:    20,
      grab:         60,
      air_slam:     25,
      down_punch:   22,
      hadouken:     40,
    };
    return table[this.attackType] || 25;
  }

  // ===== CPU AI =====
  computeCPUInput(opponent) {
    const inp = { left:false, right:false, up:false, down:false, attack:false };
    if (opponent.isDead) { this.cpuInput = inp; return; }

    if (this.cpuActionCooldown > 0) this.cpuActionCooldown--;

    // アタックシーケンス進行中
    if (this.cpuAttackState === 'holding') {
      inp.attack = true;
      Object.assign(inp, this.cpuAttackInputs);
      if (--this.cpuAttackFrames <= 0) this.cpuAttackState = 'releasing';
      this.cpuInput = inp;
      return;
    }
    if (this.cpuAttackState === 'releasing') {
      // attack キー離す = 攻撃発動
      this.cpuAttackState = null;
      this.cpuInput = inp;
      return;
    }

    const dx    = opponent.centerX - this.centerX;
    const dy    = opponent.centerY - this.centerY;
    const absDx = Math.abs(dx);

    // --- 復帰：ステージ外なら戻る ---
    const inX = this.x + this.w > MAIN_PLATFORM.x - 60 &&
                this.x < MAIN_PLATFORM.x + MAIN_PLATFORM.w + 60;
    if (!this.onGround && (!inX || this.y > MAIN_PLATFORM.y)) {
      inp[this.centerX < MAIN_PLATFORM.x + MAIN_PLATFORM.w / 2 ? 'right' : 'left'] = true;
      if (this.jumpsLeft > 0 && this.vy > -2) inp.up = true;
      this.cpuInput = inp;
      return;
    }

    // --- 飛び道具回避 ---
    for (const proj of projectiles) {
      if (!proj.alive || proj.ownerId === this.id) continue;
      const pdx = proj.x - this.centerX;
      if (Math.sign(pdx) !== Math.sign(proj.vx)) continue;
      if (Math.abs(pdx) < 260 && Math.abs(proj.y - this.centerY) < 40) {
        if (this.onGround) inp.up = true;
        this.cpuInput = inp;
        return;
      }
    }

    // --- ガード（相手の攻撃に反応） ---
    if (opponent.isAttacking && absDx < 140 && this.onGround &&
        this.cpuActionCooldown <= 0 && Math.random() < 0.28) {
      inp.left = true; inp.right = true;
      this.cpuActionCooldown = 14;
      this.cpuInput = inp;
      return;
    }

    // --- 向き合い移動 ---
    if (!this.isAttacking) inp[dx > 0 ? 'right' : 'left'] = true;

    // --- 攻撃判断 ---
    if (!this.isAttacking && this.cpuAttackState === null && this.cpuActionCooldown <= 0) {
      if (absDx < 80 && Math.abs(dy) < 65) {
        // 近距離：近接攻撃
        const r = Math.random();
        // 方向なし=強パンチ、方向あり=方向攻撃（新仕様に合わせる）
        let fi = { left:false, right:false, up:false, down:false }; // 強パンチ
        if      (r < 0.22) fi = { left:false, right:false, up:true,  down:false }; // 上パンチ
        else if (r < 0.40) fi = { left:false, right:false, up:false, down:true  }; // つかみ
        else if (r < 0.60) fi = { left:dx<0,  right:dx>0,  up:false, down:false }; // 横パンチ
        // else: 強パンチ（方向なし）
        this.cpuAttackState  = 'holding';
        this.cpuAttackFrames = 2;
        this.cpuAttackInputs = fi;
        this.cpuActionCooldown = 20 + Math.floor(Math.random() * 14);
      } else if (!this.onGround && absDx < 140 && Math.abs(dy) < 90) {
        // 空中近距離：地上と同じ方向攻撃システム
        const r2 = Math.random();
        let fi2 = { left:false, right:false, up:false, down:false }; // 強パンチ
        if      (r2 < 0.25) fi2 = { left:dx<0,  right:dx>0, up:false, down:false }; // 横パンチ
        else if (r2 < 0.45 && dy > 20) fi2 = { left:false, right:false, up:false, down:true }; // 下パンチ（相手が下にいる時）
        else if (r2 < 0.60) fi2 = { left:false, right:false, up:true, down:false }; // 上パンチ
        this.cpuAttackState  = 'holding';
        this.cpuAttackFrames = 2;
        this.cpuAttackInputs = fi2;
        this.cpuActionCooldown = 18;
      } else if (absDx > 160 && absDx < 380 && this.onGround && Math.random() < 0.013) {
        // 中距離：波動拳チャージ
        this.cpuAttackState  = 'holding';
        this.cpuAttackFrames = Math.ceil(LONG_PRESS_MS / 16.67) + 10;
        this.cpuAttackInputs = { left:false, right:false, up:false, down:false };
        this.cpuActionCooldown = 55;
      }
    }

    // --- 高さ調整 ---
    if (dy < -95 && this.onGround && this.cpuActionCooldown <= 0 && !this.isAttacking) {
      inp.up = true;
      this.cpuActionCooldown = 10;
    }
    if (dy > 95 && this.onGround && this.onPlatform !== MAIN_PLATFORM) {
      inp.down = true;
    }

    this.cpuInput = inp;
  }
}

// ===== 飛び道具クラス（エネルギービーム） =====
class Projectile {
  constructor(x, y, dir, ownerId) {
    this.x = x;
    this.y = y;
    this.vx = dir * 15;
    this.vy = 0;
    this.ownerId = ownerId;
    this.w = 50;  // ビーム長
    this.h = 14;  // ビーム高さ
    this.alive = true;
    this.age = 0;
  }

  update(players) {
    this.x += this.vx;
    this.age++;

    if (this.age > 220 || this.x < -250 || this.x > W + 250) {
      this.alive = false;
      return;
    }

    const dir = this.vx > 0 ? 1 : -1;
    // ヒットボックス：ビームの前方寄りに設定
    const hbx = dir > 0 ? this.x - this.w * 0.3 : this.x - this.w * 0.7;
    for (const p of players) {
      if (p.id === this.ownerId || p.isDead) continue;
      if (rectsOverlap({ x: hbx, y: this.y - this.h / 2, w: this.w, h: this.h },
                        { x: p.x, y: p.y, w: p.w, h: p.h })) {
        if (p.isGuarding) {
          spawnParticles(p.centerX, p.centerY, '#aaaaff', 5);
        } else {
          const dmg = 12;
          const kb = (dmg + p.damage) * KNOCKBACK_BASE;
          p.takeDamage(dmg, dir * kb * 1.4, -(kb * 0.6 + 4));
          spawnParticles(p.centerX, p.centerY, '#44aaff', 14);
          triggerScreenShake(7);
        }
        this.alive = false;
        spawnParticles(this.x, this.y, '#88ccff', 10);
      }
    }
  }

  draw(ctx) {
    if (!this.alive) return;
    ctx.save();

    const dir  = this.vx > 0 ? 1 : -1;
    const len  = this.w;
    const bh   = this.h;
    const lx   = this.x - len / 2;
    const cy   = this.y;
    const frontX = this.x + dir * len / 2;

    // 外側グロー
    const gh = bh * 4.5;
    const og = ctx.createLinearGradient(0, cy - gh / 2, 0, cy + gh / 2);
    og.addColorStop(0,    'rgba(20,100,255,0)');
    og.addColorStop(0.3,  'rgba(50,140,255,0.18)');
    og.addColorStop(0.5,  'rgba(100,190,255,0.32)');
    og.addColorStop(0.7,  'rgba(50,140,255,0.18)');
    og.addColorStop(1,    'rgba(20,100,255,0)');
    ctx.fillStyle = og;
    ctx.fillRect(lx, cy - gh / 2, len, gh);

    // コアビーム（白→水色グラデーション）
    const bg = ctx.createLinearGradient(0, cy - bh / 2, 0, cy + bh / 2);
    bg.addColorStop(0,   'rgba(210,235,255,0.95)');
    bg.addColorStop(0.5, '#ffffff');
    bg.addColorStop(1,   'rgba(140,210,255,0.95)');
    ctx.fillStyle = bg;
    ctx.fillRect(lx, cy - bh / 2, len, bh);

    // トレイルフェード（後端を暗く）
    const tg = ctx.createLinearGradient(lx, 0, lx + len, 0);
    if (dir > 0) {
      tg.addColorStop(0,    'rgba(0,0,50,0.55)');
      tg.addColorStop(0.42, 'rgba(0,0,0,0)');
      tg.addColorStop(1,    'rgba(0,0,0,0)');
    } else {
      tg.addColorStop(0,    'rgba(0,0,0,0)');
      tg.addColorStop(0.58, 'rgba(0,0,0,0)');
      tg.addColorStop(1,    'rgba(0,0,50,0.55)');
    }
    ctx.fillStyle = tg;
    ctx.fillRect(lx, cy - bh / 2, len, bh);

    // 先端のエネルギーオーブ
    const eo = ctx.createRadialGradient(frontX, cy, 0, frontX, cy, bh * 3.2);
    eo.addColorStop(0,    '#ffffff');
    eo.addColorStop(0.18, 'rgba(210,240,255,0.95)');
    eo.addColorStop(0.55, 'rgba(60,160,255,0.55)');
    eo.addColorStop(1,    'rgba(0,80,200,0)');
    ctx.fillStyle = eo;
    ctx.beginPath();
    ctx.arc(frontX, cy, bh * 3.2, 0, Math.PI * 2);
    ctx.fill();

    // 脈動リング
    ctx.globalAlpha = 0.32 + Math.sin(this.age * 0.38) * 0.12;
    ctx.strokeStyle = 'rgba(150,225,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(this.x, cy, len * 0.44, bh * 1.7, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

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
  player1 = new Player(1, 322, '#e84040', player1Keys, false);
  player2 = new Player(2, 642, '#4060e8', player2Keys, gameMode === 'cpu');
  player1.facing = 1;
  player2.facing = -1;
}

// ===== メニュー描画 =====
function drawMenu(ctx) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // タイトル
  ctx.font = 'bold 68px Arial';
  ctx.shadowColor = 'rgba(100,180,255,0.8)';
  ctx.shadowBlur = 28;
  ctx.fillStyle = '#ffffff';
  ctx.fillText('フットバセ', W / 2, H / 2 - 120);
  ctx.shadowBlur = 0;

  // サブタイトル
  ctx.font = '16px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText('スマブラ風 2人対戦ゲーム', W / 2, H / 2 - 65);

  // モード選択
  const opts = ['2人対戦', 'CPU対戦'];
  opts.forEach((label, i) => {
    const sel = i === menuCursor;
    const oy  = H / 2 + i * 72;

    if (sel) {
      ctx.fillStyle = 'rgba(80,140,255,0.28)';
      ctx.strokeStyle = 'rgba(100,180,255,0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(W / 2 - 160, oy - 30, 320, 60, [10]);
      ctx.fill();
      ctx.stroke();
    }

    ctx.font = `bold ${sel ? 30 : 26}px Arial`;
    ctx.fillStyle = sel ? '#ffffff' : 'rgba(255,255,255,0.45)';
    ctx.fillText(label, W / 2, oy);
  });

  // 操作説明
  ctx.font = '14px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillText('↑↓ / WS  で選択　　Enter / Space  で決定', W / 2, H - 50);

  ctx.restore();
}

// ===== 攻撃エフェクト描画ヘルパー =====
function drawFist(ctx, cx, cy, facing, scale, color, angle = 0) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.scale(facing, 1);

  const s = scale;
  const fw = 28 * s;
  const fh = 20 * s;

  // 影
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.roundRect(-fw / 2 + 2 * s, -fh / 2 + 3 * s, fw, fh, [5 * s]);
  ctx.fill();

  // 拳本体
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 2.5 * s;
  ctx.beginPath();
  ctx.roundRect(-fw / 2, -fh / 2, fw, fh, [5 * s]);
  ctx.fill();
  ctx.stroke();

  // 上面ハイライト
  ctx.fillStyle = 'rgba(255,255,255,0.32)';
  ctx.beginPath();
  ctx.roundRect(-fw / 2 + 2 * s, -fh / 2 + 2 * s, fw - 4 * s, fh * 0.38, [4 * s, 4 * s, 0, 0]);
  ctx.fill();

  // ナックル（右面に3つ）
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    ctx.arc(fw / 2 + 3.5 * s, (-5 + i * 5) * s, 4.5 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.beginPath();
    ctx.arc(fw / 2 + 2.5 * s, (-6.5 + i * 5) * s, 2 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  // 親指
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.ellipse(fw * 0.18, fh * 0.46, 8 * s, 5.5 * s, -0.38, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

function drawSpeedLines(ctx, cx, cy, facing, progress, color, vertical = false) {
  if (progress < 0.08) return;
  ctx.save();
  const defs = [
    { offset: -7, len: 42 },
    { offset: 0,  len: 58 },
    { offset: 7,  len: 32 },
  ];
  for (let i = 0; i < defs.length; i++) {
    const { offset, len } = defs[i];
    ctx.globalAlpha = Math.max(0, (0.65 - i * 0.15) * progress);
    ctx.strokeStyle = color;
    ctx.lineWidth = (2.8 - i * 0.7) * Math.min(progress, 1);
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (!vertical) {
      ctx.moveTo(cx, cy + offset);
      ctx.lineTo(cx - facing * (len * progress), cy + offset);
    } else {
      ctx.moveTo(cx + offset, cy);
      ctx.lineTo(cx + offset, cy - len * progress);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawImpactStar(ctx, cx, cy, progress, color) {
  const t = (progress - 0.6) / 0.4;
  if (t <= 0) return;
  const outer = 24 * t;
  const inner = outer * 0.38;
  const rays = 8;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalAlpha = (1 - t) * 0.9;

  // 放射グロー
  const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, outer * 1.3);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(0.35, color);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(0, 0, outer * 1.3, 0, Math.PI * 2);
  ctx.fill();

  // 星形
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = (1 - t) * 0.8;
  ctx.beginPath();
  for (let i = 0; i < rays * 2; i++) {
    const a = (i / (rays * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    i === 0 ? ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

function drawGrabHand(ctx, cx, cy, facing, scale, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(facing, 1);

  const s = scale;

  // 手のひら
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.roundRect(-8 * s, -10 * s, 18 * s, 18 * s, [4 * s]);
  ctx.fill();
  ctx.stroke();

  // 4本指
  [-0.6, -0.2, 0.2, 0.6].forEach(a => {
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    ctx.ellipse(8 * s + Math.cos(a) * 13 * s, Math.sin(a) * 10 * s, 4 * s, 7 * s, a, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });

  // 親指
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1.5 * s;
  ctx.beginPath();
  ctx.ellipse(4 * s, 10 * s, 6 * s, 4 * s, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // グリーングロー
  ctx.globalAlpha = 0.35;
  const grd = ctx.createRadialGradient(8 * s, 0, 0, 8 * s, 0, 20 * s);
  grd.addColorStop(0, '#00ff88');
  grd.addColorStop(1, 'rgba(0,255,136,0)');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(8 * s, 0, 20 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.restore();
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
  const hudH = 74;

  ctx.fillStyle = 'rgba(4, 4, 18, 0.84)';
  ctx.fillRect(0, 0, W, hudH);

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, hudH);
  ctx.lineTo(W, hudH);
  ctx.stroke();

  drawTimer(ctx, W / 2, hudH / 2);
  drawPlayerPanel(ctx, player1, 12, 7, 215, 60);
  drawPlayerPanel(ctx, player2, W - 227, 7, 215, 60);
}

function drawTimer(ctx, cx, cy) {
  const minutes = Math.floor(gameTimer / 60);
  const seconds = Math.floor(gameTimer % 60);
  const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  const urgent = gameTimer <= 30;

  const bw = 86, bh = 52;

  ctx.fillStyle = urgent
    ? `rgba(150,0,0,${0.55 + Math.sin(Date.now() / 180) * 0.12})`
    : 'rgba(255,255,255,0.07)';
  ctx.strokeStyle = urgent ? '#ff5555' : 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, [8]);
  ctx.fill();
  ctx.stroke();

  ctx.font = '10px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.38)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('TIME', cx, cy - bh / 2 - 4);

  if (urgent) { ctx.shadowColor = '#ff2222'; ctx.shadowBlur = 10; }
  ctx.font = 'bold 26px monospace';
  ctx.fillStyle = urgent ? '#ff5555' : '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(timeStr, cx, cy);
  ctx.shadowBlur = 0;
  ctx.textBaseline = 'alphabetic';
}

function drawPlayerPanel(ctx, player, px, py, pw, ph) {
  const isP1 = player.id === 1;
  const col = player.color;

  // パネル背景グラデーション
  const grd = ctx.createLinearGradient(px, py, px + pw, py + ph);
  if (isP1) {
    grd.addColorStop(0, col + '44');
    grd.addColorStop(0.55, 'rgba(8,8,28,0.72)');
    grd.addColorStop(1, 'rgba(8,8,28,0.5)');
  } else {
    grd.addColorStop(0, 'rgba(8,8,28,0.5)');
    grd.addColorStop(0.45, 'rgba(8,8,28,0.72)');
    grd.addColorStop(1, col + '44');
  }
  ctx.fillStyle = grd;
  ctx.strokeStyle = col + '40';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(px, py, pw, ph, [7]);
  ctx.fill();
  ctx.stroke();

  // カラーアクセントバー
  const barGrd = ctx.createLinearGradient(0, py, 0, py + ph);
  barGrd.addColorStop(0, col);
  barGrd.addColorStop(1, col + '66');
  ctx.fillStyle = barGrd;
  ctx.beginPath();
  if (isP1) ctx.roundRect(px, py, 4, ph, [3, 0, 0, 3]);
  else       ctx.roundRect(px + pw - 4, py, 4, ph, [0, 3, 3, 0]);
  ctx.fill();

  // プレイヤーラベル
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = col;
  ctx.textAlign = isP1 ? 'left' : 'right';
  ctx.textBaseline = 'top';
  ctx.fillText(`P${player.id}`, isP1 ? px + 11 : px + pw - 11, py + 7);

  // ストック（ミニ雪だるま）
  const stockY = py + ph - 17;
  const sp = 20;
  const stocksX = isP1 ? px + 11 : px + pw - 11 - (MAX_STOCKS - 1) * sp;
  for (let i = 0; i < MAX_STOCKS; i++) {
    const sx = stocksX + i * sp + (isP1 ? 0 : sp * 0.5);
    ctx.globalAlpha = i < player.stocks ? 1 : 0.14;
    ctx.fillStyle = col;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(sx, stockY + 3, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(sx, stockY - 5, 3.8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ダメージ%
  const dmg = player.damage;
  const dmgColor = dmg === 0 ? '#ffffff'
    : dmg < 50  ? '#aaffaa'
    : dmg < 100 ? '#ffcc33'
    : '#ff4422';
  const dmgX = isP1 ? px + pw - 14 : px + 14;

  if (dmg > 80) { ctx.shadowColor = dmgColor; ctx.shadowBlur = 12 + (dmg - 80) * 0.15; }
  ctx.font = `bold ${dmg > 99 ? 26 : 30}px monospace`;
  ctx.fillStyle = dmgColor;
  ctx.textAlign = isP1 ? 'right' : 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${dmg}%`, dmgX, py + ph / 2 + 3);
  ctx.shadowBlur = 0;
  ctx.textBaseline = 'alphabetic';
}

function drawCountdown(ctx) {
  const text = countdown > 0 ? countdown.toString() : 'GO!';
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const size = countdown > 0 ? 108 : 92;
  ctx.font = `bold ${size}px Arial`;

  // 外枠グロー
  ctx.shadowColor = countdown > 0 ? 'rgba(200,220,255,0.7)' : 'rgba(255,200,0,0.85)';
  ctx.shadowBlur = 40;

  // アウトライン
  ctx.lineWidth = 9;
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.strokeText(text, 0, 0);

  // グラデーション塗り
  const grad = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
  if (countdown > 0) {
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#b0c8ff');
  } else {
    grad.addColorStop(0, '#ffe84a');
    grad.addColorStop(1, '#ff7700');
  }
  ctx.fillStyle = grad;
  ctx.fillText(text, 0, 0);
  ctx.shadowBlur = 0;
  ctx.restore();
}

function drawResult(ctx) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,8,0.8)';
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const winColor = winner === 1 ? '#e84040' : winner === 2 ? '#4060e8' : '#aaaacc';
  const winText = winner === 0 ? 'DRAW!' : `P${winner} WIN!`;

  // パネル
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.strokeStyle = winColor + '55';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(W / 2 - 290, H / 2 - 88, 580, 176, [16]);
  ctx.fill();
  ctx.stroke();

  // 勝利テキスト（グロー）
  ctx.shadowColor = winColor;
  ctx.shadowBlur = 35;
  ctx.font = 'bold 76px Arial';

  const grad = ctx.createLinearGradient(0, H / 2 - 60, 0, H / 2 + 10);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, winColor);
  ctx.fillStyle = grad;
  ctx.fillText(winText, W / 2, H / 2 - 20);
  ctx.shadowBlur = 0;

  // サブテキスト
  ctx.font = 'bold 15px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText('SPACE / ENTER  でリトライ　　ESC  でタイトルへ', W / 2, H / 2 + 44);

  // ストック残り表示
  ctx.font = '12px monospace';
  ctx.fillStyle = player1.color + 'aa';
  ctx.textAlign = 'left';
  ctx.fillText(`P1: ${player1.stocks} stocks`, W / 2 - 160, H / 2 + 68);
  ctx.fillStyle = player2.color + 'aa';
  ctx.textAlign = 'right';
  ctx.fillText(`P2: ${player2.stocks} stocks`, W / 2 + 160, H / 2 + 68);

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
  if (keys['Space'] || keys['Enter']) resetGame();
  if (keys['Escape']) { gameState = 'menu'; menuCursor = 0; }
}

function resolvePlayerCollision(p1, p2) {
  if (p1.isDead || p2.isDead) return;
  if (p1.isGrabbing || p2.isGrabbing) return;

  const ox = Math.min(p1.x + p1.w, p2.x + p2.w) - Math.max(p1.x, p2.x);
  const oy = Math.min(p1.y + p1.h, p2.y + p2.h) - Math.max(p1.y, p2.y);
  if (ox <= 0 || oy <= 0) return;

  const push = ox / 2 + 0.5;
  if (p1.x + p1.w / 2 < p2.x + p2.w / 2) {
    p1.x -= push;
    p2.x += push;
    if (p1.vx > 0 && !p1.inHitstun) p1.vx *= 0.4;
    if (p2.vx < 0 && !p2.inHitstun) p2.vx *= 0.4;
  } else {
    p1.x += push;
    p2.x -= push;
    if (p1.vx < 0 && !p1.inHitstun) p1.vx *= 0.4;
    if (p2.vx > 0 && !p2.inHitstun) p2.vx *= 0.4;
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
  initPlayers(); // gameMode を参照して CPU を設定
}

// ===== メインループ =====
let lastTime = 0;

function gameLoop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 16.67, 3); // フレーム正規化
  lastTime = timestamp;

  updateScreenShake();
  ctx.clearRect(0, 0, W, H);

  // ===== メニュー状態 =====
  if (gameState === 'menu') {
    drawBackground(ctx);
    drawMenu(ctx);
    // ナビゲーション
    if (menuNavCooldown > 0) menuNavCooldown--;
    if ((keys['ArrowUp'] || keys['KeyW']) && menuNavCooldown === 0) {
      menuCursor = (menuCursor + 1) % 2;
      menuNavCooldown = 12;
    }
    if ((keys['ArrowDown'] || keys['KeyS']) && menuNavCooldown === 0) {
      menuCursor = (menuCursor + 1) % 2;
      menuNavCooldown = 12;
    }
    if (keys['Enter'] || keys['Space']) {
      if (menuNavCooldown === 0) {
        gameMode = menuCursor === 0 ? '2p' : 'cpu';
        resetGame();
        menuNavCooldown = 20;
      }
    }
    requestAnimationFrame(gameLoop);
    return;
  }

  // ワールド描画（スクリーンシェイク適用）
  ctx.save();
  ctx.translate(screenShake.x, screenShake.y);
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
    player1.draw(ctx);
    player2.draw(ctx);
    ctx.restore();
    drawCountdown(ctx);

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
    resolvePlayerCollision(player1, player2);

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
    ctx.restore();
    drawHUD(ctx);

  } else if (gameState === 'result') {
    player1.draw(ctx);
    player2.draw(ctx);
    drawParticles(ctx);
    ctx.restore();
    drawHUD(ctx);
    drawResult(ctx);
    handleRetry();
  }

  requestAnimationFrame(gameLoop);
}

// ===== 起動 =====
initPlayers();
requestAnimationFrame(gameLoop);
