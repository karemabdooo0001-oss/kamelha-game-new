const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// إعداد قاعدة بيانات PostgreSQL لـ Railway
let pool = null;
if (process.env.DATABASE_URL) {
  const isInternal = process.env.DATABASE_URL.includes('railway.internal');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isInternal ? false : { rejectUnauthorized: false }
  });
}

// إنشاء الجداول تلقائياً
async function initDB() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        player_id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100),
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        current_room VARCHAR(20),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS vouchers (
        code VARCHAR(50) PRIMARY KEY,
        type VARCHAR(20) DEFAULT 'single',
        max_devices INT DEFAULT 1,
        duration VARCHAR(30) DEFAULT '1_match',
        price NUMERIC DEFAULT 0,
        devices TEXT[] DEFAULT '{}',
        used_match BOOLEAN DEFAULT false,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS banned_players (
        player_id VARCHAR(50) PRIMARY KEY,
        banned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ تم تهيئة قاعدة بيانات PostgreSQL بنجاح.');
  } catch (err) {
    console.error('⚠️ خطأ في الاتصال بقاعدة البيانات:', err.message);
  }
}
initDB();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ذاكرة الكاش السريعة
const memoryVouchers = new Map();
const bannedSet = new Set();
const rooms = new Map();

// توليد بطاقات اللعبة (62 كارت بالتمام والكمال)
function buildDeck() {
  const deck = [];
  let id = 1;
  const colors = ['#e63946', '#1d3557', '#2a9d8f', '#e76f51']; // 4 ألوان مميزة

  // 1. 40 كارت أرقام (1 إلى 10، كل رقم 4 نسخ)
  for (let num = 1; num <= 10; num++) {
    for (let c = 0; c < 4; c++) {
      deck.push({
        id: `N_${id++}`,
        type: 'number',
        value: num,
        name: `${num}`,
        color: colors[c],
        desc: `رقم ${num}`
      });
    }
  }

  // 2. 22 كارت كوماندز
  // 4 جوكر
  for (let i = 0; i < 4; i++) {
    deck.push({ id: `CMD_${id++}`, type: 'command', cmd: 'joker', name: 'جوكر 🃏', color: '#9b5de5', desc: 'يحل محل أي رقم في تجميعتك.' });
  }
  // 4 اصطاد كارتك
  for (let i = 0; i < 4; i++) {
    deck.push({ id: `CMD_${id++}`, type: 'command', cmd: 'catch', name: 'اصطاد كارتك 🎣', color: '#00bbf9', desc: 'اطلب رقماً أو جوكر من لاعب، إن وجد تأخذه وتعطيه كارت.' });
  }
  // 4 لم كمالتك
  for (let i = 0; i < 4; i++) {
    deck.push({ id: `CMD_${id++}`, type: 'command', cmd: 'take_discard', name: 'لم كمالتك 🧲', color: '#00f5d4', desc: 'خذ أي كارت من الأرض المكشوفة وبدله بكارت من يدك.' });
  }
  // 4 اعكس لفتك
  for (let i = 0; i < 4; i++) {
    deck.push({ id: `CMD_${id++}`, type: 'command', cmd: 'reverse', name: 'اعكس لفتك 🔄', color: '#f15bb5', desc: 'يعكس اتجاه اللعب أو يفوت دور الخصم في المواجهة الثنائية.' });
  }
  // 2 هو كدة
  for (let i = 0; i < 2; i++) {
    deck.push({ id: `CMD_${id++}`, type: 'command', cmd: 'force_discard', name: 'هو كدة 💥', color: '#f3722c', desc: 'يجبر لاعباً على رمي كروته وسحب 4 كروت جديدة.' });
  }
  // 2 رخم عليهم
  for (let i = 0; i < 2; i++) {
    deck.push({ id: `CMD_${id++}`, type: 'command', cmd: 'mischief', name: 'رخم عليهم 🕵️', color: '#43aa8b', desc: 'تجسس وبدل كارت مع الخصم (أو بدل كارت سراً بين لاعبين).' });
  }
  // 2 براحتك
  for (let i = 0; i < 2; i++) {
    deck.push({ id: `CMD_${id++}`, type: 'command', cmd: 'whatever', name: 'براحتك 🎭', color: '#fee440', desc: 'يتحول لأي كارت كوماند ما عدا الجوكر.' });
  }

  // خلط الكروت عشوائياً (Fisher-Yates)
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// التحقق من فوز يد الجولة ("كمّلتها")
function evaluateHand(hand) {
  if (hand.length !== 4) return { valid: false };
  const jokers = hand.filter(c => c.cmd === 'joker').length;
  if (jokers === 4) return { valid: true, points: 5, instantWin: true };

  const numbers = hand.filter(c => c.type === 'number').map(c => c.value);
  const counts = {};
  numbers.forEach(n => counts[n] = (counts[n] || 0) + 1);

  for (const num in counts) {
    if (counts[num] + jokers === 4) {
      return { valid: true, points: jokers > 0 ? 1 : 2, instantWin: false };
    }
  }
  return { valid: false };
}

// مؤقت الأدوار
function startTurnTimer(roomCode, duration = 15) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.timerInterval) clearInterval(room.timerInterval);

  room.timer = duration;
  io.to(roomCode).emit('timer_tick', { time: room.timer, duration });

  room.timerInterval = setInterval(() => {
    room.timer--;
    io.to(roomCode).emit('timer_tick', { time: room.timer, duration });
    if (room.timer <= 0) {
      clearInterval(room.timerInterval);
      handleTurnTimeout(roomCode);
    }
  }, 1000);
}

function handleTurnTimeout(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.status !== 'playing') return;
  const currentPid = room.players[room.currentTurnIndex]?.playerId;

  // لو معاه كارت مسحوب ولم يلعب، يرميه في المكشوف
  if (room.drawnCard && room.drawnBy === currentPid) {
    room.discardPile.push(room.drawnCard);
    room.drawnCard = null;
    room.drawnBy = null;
  }
  room.pendingAction = null;
  advanceTurn(roomCode);
}

function advanceTurn(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.status !== 'playing') return;

  if (room.timerInterval) clearInterval(room.timerInterval);

  // التحقق هل اكتملت الدورة بعد إعلان "كمّلتها"
  if (room.orbitEndIndex !== undefined && room.orbitEndIndex !== null) {
    if (room.currentTurnIndex === room.orbitEndIndex) {
      endRound(roomCode);
      return;
    }
  }

  // الانتقال للاعب التالي حسب الاتجاه
  let nextIndex = (room.currentTurnIndex + room.direction) % room.players.length;
  if (nextIndex < 0) nextIndex += room.players.length;

  room.currentTurnIndex = nextIndex;
  room.drawnCard = null;
  room.drawnBy = null;
  room.pendingAction = null;

  broadcastGameState(roomCode);
  startTurnTimer(roomCode, 15);
}

function endRound(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.timerInterval) clearInterval(room.timerInterval);
  room.status = 'round_reveal';

  let matchWinner = null;
  // فحص نتائج أيدي اللاعبين
  room.players.forEach(p => {
    if (p.declaredKamelha) {
      const evalRes = evaluateHand(p.hand);
      if (evalRes.valid) {
        p.score += evalRes.points;
      }
    }
    if (p.score >= 5) {
      matchWinner = p;
    }
  });

  // إذا لم يصل أحد لـ 5 نقاط بعد إعلان أحدهم، فحص أصحاب أعلى نقاط
  if (!matchWinner) {
    const highestScorer = [...room.players].sort((a,b) => b.score - a.score)[0];
    if (highestScorer && highestScorer.score >= 5) matchWinner = highestScorer;
  }

  io.to(roomCode).emit('round_ended', {
    players: room.players.map(p => ({
      playerId: p.playerId,
      name: p.name,
      hand: p.hand,
      score: p.score,
      declaredKamelha: p.declaredKamelha
    })),
    matchWinner: matchWinner ? { name: matchWinner.name, playerId: matchWinner.playerId } : null
  });

  if (matchWinner) {
    room.status = 'game_over';
    handleVoucherMatchEnd(room);
    return;
  }

  // بدء الجولة التالية بعد 8 ثوانٍ
  setTimeout(() => {
    if (!rooms.has(roomCode)) return;
    startNextRound(roomCode);
  }, 8000);
}

function startNextRound(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  room.round++;
  room.deck = buildDeck();
  room.discardPile = [];
  room.status = 'playing';
  room.orbitEndIndex = null;
  room.direction = 1;

  // تدوير بداية الجولة لضمان تكافؤ الفرص
  room.startingPlayerIndex = (room.startingPlayerIndex + 1) % room.players.length;
  room.currentTurnIndex = room.startingPlayerIndex;

  // توزيع 4 كروت لكل لاعب مع إزالة الحصانة السابقة
  room.players.forEach(p => {
    p.hand = room.deck.splice(0, 4);
    p.immune = false;
    p.declaredKamelha = false;
  });

  // وضع كارت مكشوف في البداية
  room.discardPile.push(room.deck.pop());

  broadcastGameState(roomCode);
  startTurnTimer(roomCode, 15);
}

async function handleVoucherMatchEnd(room) {
  for (const p of room.players) {
    const v = memoryVouchers.get(p.voucherCode);
    if (v && v.duration === '1_match') {
      v.used_match = true;
      v.status = 'expired';
      if (pool) {
        await pool.query('UPDATE vouchers SET used_match = true, status = $1 WHERE code = $2', ['expired', v.code]);
      }
    }
  }
}

function broadcastGameState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  // تحديد صاحب أعلى سكور لعرض الكأس 🏆
  const maxScore = Math.max(...room.players.map(p => p.score));

  room.players.forEach(player => {
    const safePlayers = room.players.map((p, idx) => ({
      playerId: p.playerId,
      name: p.name,
      cardCount: p.hand.length,
      score: p.score,
      isHost: p.playerId === room.host,
      isCurrentTurn: idx === room.currentTurnIndex,
      immune: p.immune,
      isTopScorer: p.score > 0 && p.score === maxScore,
      hand: p.playerId === player.playerId ? p.hand : null // إخفاء كروت الخصوم
    }));

    io.to(player.socketId).emit('game_state', {
      status: room.status,
      round: room.round,
      currentTurnIndex: room.currentTurnIndex,
      currentTurnPlayerId: room.players[room.currentTurnIndex]?.playerId,
      direction: room.direction,
      deckCount: room.deck.length,
      discardTop: room.discardPile[room.discardPile.length - 1] || null,
      discardPile: room.discardPile,
      drawnCard: room.drawnBy === player.playerId ? room.drawnCard : (room.drawnCard ? { hidden: true } : null),
      players: safePlayers,
      myHand: player.hand,
      pendingAction: room.pendingAction
    });
  });
}

// إدارة السوكت وأحداث اللعبة
io.on('connection', (socket) => {

  // التحقق من صلاحية اللاعب والتذكرة
  socket.on('auth_player', async ({ playerId, name, voucherCode }) => {
    if (bannedSet.has(playerId)) {
      socket.emit('auth_result', { success: false, message: 'هذا الجهاز محظور من اللعب نهائياً.' });
      return;
    }

    let voucher = memoryVouchers.get(voucherCode);
    if (!voucher && pool) {
      const res = await pool.query('SELECT * FROM vouchers WHERE code = $1', [voucherCode]);
      if (res.rows.length) {
        voucher = res.rows[0];
        memoryVouchers.set(voucher.code, voucher);
      }
    }

    if (!voucher) {
      socket.emit('auth_result', { success: false, message: 'رمز التذكرة غير صحيح.' });
      return;
    }

    if (voucher.status === 'expired' || voucher.used_match) {
      socket.emit('auth_result', { success: false, message: 'هذه التذكرة منتهية الصلاحية.' });
      return;
    }

    if (voucher.expires_at && new Date() > new Date(voucher.expires_at)) {
      voucher.status = 'expired';
      socket.emit('auth_result', { success: false, message: 'انتهت مدة صلاحية هذه التذكرة.' });
      return;
    }

    if (!voucher.devices.includes(playerId)) {
      if (voucher.devices.length >= voucher.max_devices) {
        socket.emit('auth_result', { success: false, message: 'تجاوزت هذه التذكرة الحد الأقصى للأجهزة المسموح بها.' });
        return;
      }
      voucher.devices.push(playerId);
      if (pool) {
        await pool.query('UPDATE vouchers SET devices = $1 WHERE code = $2', [voucher.devices, voucher.code]);
      }
    }

    socket.playerId = playerId;
    socket.playerName = name || `لاعب-${playerId.slice(-4)}`;
    socket.voucherCode = voucherCode;

    if (pool) {
      await pool.query(
        'INSERT INTO players (player_id, name, last_seen) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (player_id) DO UPDATE SET name = $2, last_seen = CURRENT_TIMESTAMP',
        [playerId, socket.playerName]
      );
    }

    socket.emit('auth_result', { success: true, playerId, name: socket.playerName });
  });

  // إنشاء غرفة
  socket.on('create_room', () => {
    if (!socket.playerId) return;
    const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms.set(roomCode, {
      code: roomCode,
      host: socket.playerId,
      status: 'waiting',
      players: [{
        socketId: socket.id,
        playerId: socket.playerId,
        name: socket.playerName,
        hand: [],
        score: 0,
        immune: false,
        declaredKamelha: false,
        voucherCode: socket.voucherCode
      }],
      deck: [],
      discardPile: [],
      currentTurnIndex: 0,
      startingPlayerIndex: 0,
      round: 1,
      direction: 1,
      drawnCard: null,
      drawnBy: null,
      timer: 15,
      timerInterval: null,
      pendingAction: null
    });
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.emit('room_joined', { roomCode, isHost: true });
    broadcastGameState(roomCode);
  });

  // الانضمام لغرفة
  socket.on('join_room', ({ roomCode }) => {
    const code = roomCode?.toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit('error_msg', 'الغرفة غير موجودة.');
    if (room.status !== 'waiting') return socket.emit('error_msg', 'اللعبة بدأت بالفعل في هذه الغرفة.');
    if (room.players.length >= 4) return socket.emit('error_msg', 'الغرفة ممتلئة (الحد الأقصى 4 لاعبين).');
    if (room.players.some(p => p.playerId === socket.playerId)) return socket.emit('error_msg', 'أنت موجود بالفعل بالغرفة.');

    room.players.push({
      socketId: socket.id,
      playerId: socket.playerId,
      name: socket.playerName,
      hand: [],
      score: 0,
      immune: false,
      declaredKamelha: false,
      voucherCode: socket.voucherCode
    });

    socket.join(code);
    socket.roomCode = code;
    socket.emit('room_joined', { roomCode: code, isHost: false });
    broadcastGameState(code);
  });

  // بدء اللعبة
  socket.on('start_game', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.playerId) return;
    if (room.players.length < 2) return socket.emit('error_msg', 'يلزم لاعبان على الأقل للبدء.');

    room.status = 'playing';
    room.round = 1;
    room.deck = buildDeck();
    room.discardPile = [];
    room.direction = 1;
    room.currentTurnIndex = 0;
    room.startingPlayerIndex = 0;

    room.players.forEach(p => {
      p.hand = room.deck.splice(0, 4);
      p.score = 0;
      p.immune = false;
      p.declaredKamelha = false;
    });

    room.discardPile.push(room.deck.pop());
    broadcastGameState(room.code);
    startTurnTimer(room.code, 15);
  });

  // سحب كارت من المقلوب
  socket.on('draw_card', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.status !== 'playing') return;
    const player = room.players[room.currentTurnIndex];
    if (player.playerId !== socket.playerId || room.drawnCard) return;

    if (room.deck.length === 0) {
      // إعادة خلط الأرض المكشوفة ما عدا الكارت الأخير
      const top = room.discardPile.pop();
      room.deck = room.discardPile;
      room.discardPile = [top];
      for (let i = room.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]];
      }
    }

    const card = room.deck.pop();
    room.drawnCard = card;
    room.drawnBy = player.playerId;
    room.drawnCardFrom = 'deck';

    broadcastGameState(room.code);
  });

  // أخذ الكارت المكشوف من الأرض
  socket.on('take_discard', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.status !== 'playing') return;
    const player = room.players[room.currentTurnIndex];
    if (player.playerId !== socket.playerId || room.drawnCard || room.discardPile.length === 0) return;

    const card = room.discardPile.pop();
    room.drawnCard = card;
    room.drawnBy = player.playerId;
    room.drawnCardFrom = 'discard';

    broadcastGameState(room.code);
  });

  // تبديل الكارت المسحوب بكارت من اليد
  socket.on('swap_card', ({ handCardIndex }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.status !== 'playing') return;
    const player = room.players[room.currentTurnIndex];
    if (player.playerId !== socket.playerId || !room.drawnCard) return;

    const discardedFromHand = player.hand.splice(handCardIndex, 1, room.drawnCard)[0];
    room.discardPile.push(discardedFromHand);
    room.drawnCard = null;
    room.drawnBy = null;

    advanceTurn(room.code);
  });

  // رمي الكارت المسحوب في الأرض المكشوفة
  socket.on('discard_drawn', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.status !== 'playing') return;
    const player = room.players[room.currentTurnIndex];
    if (player.playerId !== socket.playerId || !room.drawnCard) return;

    const card = room.drawnCard;
    room.discardPile.push(card);
    room.drawnCard = null;
    room.drawnBy = null;

    // تفعيل الكوماند فقط لو كان مسحوباً من المقلوب
    if (room.drawnCardFrom === 'deck' && card.type === 'command' && card.cmd !== 'joker') {
      executeCommand(room, player, card);
    } else {
      advanceTurn(room.code);
    }
  });

  // تنفيذ وتفعيل بطاقات الكوماندز
  function executeCommand(room, player, card) {
    if (card.cmd === 'reverse') {
      if (room.players.length === 2) {
        // في المواجهة الثنائية تعمل كـ Skip ويبقى الدور مع نفس اللاعب
        io.to(room.code).emit('game_alert', `${player.name} استخدم "اعكس لفتك" وتخطى دور الخصم! 🔄`);
        startTurnTimer(room.code, 15);
        broadcastGameState(room.code);
      } else {
        room.direction *= -1;
        io.to(room.code).emit('game_alert', `${player.name} عكس اتجاه اللعب! 🔄`);
        advanceTurn(room.code);
      }
      return;
    }

    // تمديد المؤقت لـ 20 ثانية أثناء توجيه الكوماند
    startTurnTimer(room.code, 20);

    room.pendingAction = {
      cmd: card.cmd,
      initiatorId: player.playerId,
      requiresTarget: true
    };
    broadcastGameState(room.code);
  }

  // رد وتطبيق أمر الكوماند المختار
  socket.on('resolve_command', (data) => {
    const room = rooms.get(socket.roomCode);
    if (!room || !room.pendingAction || room.pendingAction.initiatorId !== socket.playerId) return;

    const { targetPlayerId, requestedValue, secondTargetId, chosenCommand, cancel } = data;
    const player = room.players.find(p => p.playerId === socket.playerId);
    const target = room.players.find(p => p.playerId === targetPlayerId);

    if (cancel) {
      room.pendingAction = null;
      io.to(room.code).emit('game_alert', `${player.name} ألغى تفعيل الأمر.`);
      advanceTurn(room.code);
      return;
    }

    // قفل الحصانة (Immunity Lock): التحقق من عدم استهداف لاعب أعلن كمّلتها
    if (target && target.immune) {
      socket.emit('error_msg', 'هذا اللاعب محمي بحصانة قفل "كمّلتها" 🔒!');
      return;
    }

    const cmd = room.pendingAction.cmd;

    if (cmd === 'catch' && target) {
      // اصطاد كارتك
      const matchIndex = target.hand.findIndex(c =>
        requestedValue === 'joker' ? c.cmd === 'joker' : (c.type === 'number' && c.value == requestedValue)
      );
      if (matchIndex !== -1) {
        const stolen = target.hand.splice(matchIndex, 1)[0];
        const returnCard = player.hand.pop();
        target.hand.push(returnCard);
        player.hand.push(stolen);
        io.to(room.code).emit('game_alert', `نجح ${player.name} في اصطياد كارت من ${target.name}! 🎣`);
      } else {
        io.to(room.code).emit('game_alert', `فشل صيد ${player.name}! الكارت غير موجود مع ${target.name}. ❌`);
      }
    } else if (cmd === 'force_discard' && target) {
      // هو كدة: رمي كل الكروت وسحب 4 جديدة
      room.discardPile.push(...target.hand);
      target.hand = room.deck.splice(0, 4);
      io.to(room.code).emit('game_alert', `${player.name} أجبر ${target.name} على رمي كروته بالكامل وسحب 4 جديدة! 💥`);
    } else if (cmd === 'mischief') {
      // رخم عليهم
      if (room.players.length === 2 && target) {
        const randIndex = Math.floor(Math.random() * target.hand.length);
        const peekCard = target.hand[randIndex];
        socket.emit('mischief_peek', { card: peekCard, targetHandIndex: randIndex, targetId: target.playerId });
        return;
      }

      const t1 = room.players.find(p => p.playerId === targetPlayerId);
      const t2 = room.players.find(p => p.playerId === secondTargetId);
      if (t1 && t2 && !t1.immune && !t2.immune) {
        const idx1 = Math.floor(Math.random() * t1.hand.length);
        const idx2 = Math.floor(Math.random() * t2.hand.length);
        const c1 = t1.hand.splice(idx1, 1)[0];
        const c2 = t2.hand.splice(idx2, 1)[0];
        if (c1 && c2) {
          t1.hand.push(c2);
          t2.hand.push(c1);
        }
        io.to(room.code).emit('game_alert', `${player.name} بدل كارت سراً بين ${t1.name} و ${t2.name}! 🕵️`);
      }
    } else if (cmd === 'whatever' && chosenCommand) {
      // براحتك: يتحول لكوماند آخر
      room.pendingAction.cmd = chosenCommand;
      executeCommand(room, player, { cmd: chosenCommand });
      return;
    }

    room.pendingAction = null;
    advanceTurn(room.code);
  });

  // استكمال تبديل "رخم عليهم" بعد التجسس في اللعب الثنائي
  socket.on('resolve_mischief_swap', ({ doSwap, targetId, targetHandIndex, myHandIndex }) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const player = room.players.find(p => p.playerId === socket.playerId);
    const target = room.players.find(p => p.playerId === targetId);

    if (doSwap && target && player && !target.immune) {
      const targetCard = target.hand.splice(targetHandIndex, 1)[0];
      const myCard = player.hand.splice(myHandIndex, 1)[0];
      if (targetCard && myCard) {
        target.hand.push(myCard);
        player.hand.push(targetCard);
      }
      io.to(room.code).emit('game_alert', `${player.name} قام بتبديل كارت مع ${target.name} بعد التجسس عليه! 🕵️`);
    }
    room.pendingAction = null;
    advanceTurn(room.code);
  });

  // ضغط زر "كمّلتها! 👑"
  socket.on('declare_kamelha', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.status !== 'playing') return;
    const player = room.players.find(p => p.playerId === socket.playerId);
    if (!player || player.declaredKamelha) return;

    const evaluation = evaluateHand(player.hand);
    if (!evaluation.valid) {
      socket.emit('error_msg', 'يدك غير مكتملة بعد (يلزم 4 كروت متطابقة أو جوكر)!');
      return;
    }

    player.declaredKamelha = true;
    player.immune = true; // قفل الحصانة الكاملة 🔒

    io.to(room.code).emit('game_alert', `🔥 ${player.name} صرخ: "كمّلتها! 👑" وقفل على نفسه بحصانة كاملة 🔒! ستكتمل الدورة الحالية.`);

    // إذا لم تكن الدورة قد حددت نهايتها، نحددها بإنهاء الدورة الحالية
    if (room.orbitEndIndex === null || room.orbitEndIndex === undefined) {
      // تنتهي عند وصول الدور للشخص الذي يسبق من أعلن
      let prevIndex = (room.currentTurnIndex - room.direction) % room.players.length;
      if (prevIndex < 0) prevIndex += room.players.length;
      room.orbitEndIndex = prevIndex;
    }
    broadcastGameState(room.code);
  });

  // فصل الاتصال وتطبيق قاعدة (Last Man Standing)
  socket.on('disconnect', () => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.players = room.players.filter(p => p.socketId !== socket.id);
    if (room.players.length === 0) {
      if (room.timerInterval) clearInterval(room.timerInterval);
      rooms.delete(socket.roomCode);
      return;
    }

    if (room.host === socket.playerId) {
      room.host = room.players[0].playerId;
    }

    // قاعدة الفائز الأخير: لو تبقى لاعب واحد أثناء اللعب، يفوز تلقائياً
    if (room.status === 'playing' && room.players.length === 1) {
      if (room.timerInterval) clearInterval(room.timerInterval);
      room.status = 'game_over';
      const winner = room.players[0];
      winner.score += 5;
      io.to(room.code).emit('game_alert', `انسحب جميع اللاعبين! الفائز الأخير هو ${winner.name} 🏆!`);
      io.to(room.code).emit('round_ended', {
        players: room.players,
        matchWinner: { name: winner.name, playerId: winner.playerId }
      });
      handleVoucherMatchEnd(room);
    } else if (room.status === 'playing') {
      if (room.currentTurnIndex >= room.players.length) room.currentTurnIndex = 0;
      broadcastGameState(room.code);
    }
  });

  // لوحة تحكم الأدمن (Master Code: 7788)
  socket.on('admin_auth', (code) => {
    if (code === '7788') {
      socket.isAdmin = true;
      socket.emit('admin_auth_success');
      sendAdminData(socket);
    } else {
      socket.emit('admin_auth_failed');
    }
  });

  socket.on('admin_generate_voucher', async (data) => {
    if (!socket.isAdmin) return;
    const code = 'KM-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    let expiresAt = null;
    const now = new Date();

    if (data.duration === '1_hour') expiresAt = new Date(now.getTime() + 60*60*1000);
    else if (data.duration === '24_hours') expiresAt = new Date(now.getTime() + 24*60*60*1000);
    else if (data.duration === '7_days') expiresAt = new Date(now.getTime() + 7*24*60*60*1000);
    else if (data.duration === '30_days') expiresAt = new Date(now.getTime() + 30*24*60*60*1000);

    const voucher = {
      code,
      type: data.type || 'single',
      max_devices: data.type === 'squad' ? 4 : 1,
      duration: data.duration,
      price: data.price || 0,
      devices: [],
      used_match: false,
      status: 'active',
      created_at: new Date(),
      expires_at: expiresAt
    };

    memoryVouchers.set(code, voucher);
    if (pool) {
      await pool.query(
        'INSERT INTO vouchers (code, type, max_devices, duration, price, devices, status, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [voucher.code, voucher.type, voucher.max_devices, voucher.duration, voucher.price, voucher.devices, voucher.status, voucher.expires_at]
      );
    }
    sendAdminData(socket);
  });

  socket.on('admin_toggle_ban', async ({ playerId }) => {
    if (!socket.isAdmin) return;
    if (bannedSet.has(playerId)) {
      bannedSet.delete(playerId);
      if (pool) await pool.query('DELETE FROM banned_players WHERE player_id = $1', [playerId]);
    } else {
      bannedSet.add(playerId);
      if (pool) await pool.query('INSERT INTO banned_players (player_id) VALUES ($1) ON CONFLICT DO NOTHING', [playerId]);
      // طرد اللاعب إذا كان متصلاً
      for (const [id, s] of io.of('/').sockets) {
        if (s.playerId === playerId) {
          s.emit('force_disconnect', 'تم حظرك من اللعبة بواسطة الإدارة.');
          s.disconnect();
        }
      }
    }
    sendAdminData(socket);
  });
});

async function sendAdminData(socket) {
  let vouchersList = Array.from(memoryVouchers.values());
  let playersList = [];
  let bannedList = Array.from(bannedSet);

  if (pool) {
    try {
      const vRes = await pool.query('SELECT * FROM vouchers ORDER BY created_at DESC LIMIT 50');
      vouchersList = vRes.rows;
      const pRes = await pool.query('SELECT * FROM players ORDER BY last_seen DESC LIMIT 50');
      playersList = pRes.rows;
      const bRes = await pool.query('SELECT player_id FROM banned_players');
      bannedList = bRes.rows.map(r => r.player_id);
    } catch (e) {
      console.error(e.message);
    }
  }

  socket.emit('admin_data', {
    vouchers: vouchersList,
    players: playersList,
    banned: bannedList,
    activeRooms: rooms.size
  });
}

server.listen(PORT, () => {
  console.log(`🚀 خادم كمّلها يعمل بنجاح على المنفذ: ${PORT}`);
});