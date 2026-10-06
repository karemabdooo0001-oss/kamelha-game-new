// client.js - محرك الواجهة التفاعلية والتحكم
const socket = io();

// 1. مولد المؤثرات الصوتية الفورية (Web Audio API)
class SoundFX {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }
  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
  }
  playTone(freq, type = 'sine', duration = 0.15, gainVal = 0.2) {
    if (this.muted) return;
    this.init();
    if (this.ctx.state === 'suspended') this.ctx.resume();

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
    gain.gain.setValueAtTime(gainVal, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + duration);
  }
  drawCard() { this.playTone(480, 'sine', 0.1, 0.2); }
  discardCard() { this.playTone(280, 'triangle', 0.12, 0.25); }
  command() {
    this.playTone(600, 'square', 0.15, 0.2);
    setTimeout(() => this.playTone(850, 'square', 0.25, 0.2), 120);
  }
  tick() { this.playTone(800, 'sine', 0.05, 0.1); }
  kamelha() {
    [523, 659, 783, 1046].forEach((f, i) => {
      setTimeout(() => this.playTone(f, 'triangle', 0.3, 0.3), i * 140);
    });
  }
  win() {
    [400, 500, 600, 800, 1000].forEach((f, i) => {
      setTimeout(() => this.playTone(f, 'sine', 0.4, 0.4), i * 160);
    });
  }
}
const sfx = new SoundFX();

// 2. حالة العميل المحلية وتوليد الـ Unique Player ID
let playerId = localStorage.getItem('km_player_id');
if (!playerId) {
  playerId = 'WL-' + Math.floor(1000 + Math.random() * 9000);
  localStorage.setItem('km_player_id', playerId);
}

let playerName = localStorage.getItem('km_player_name') || '';
let currentRoomCode = null;
let currentGameState = null;
let selectedCommandTarget = null;
let selectedCommandValue = null;

// فحص رابط الدخول المباشر (?pass=CODE)
const urlParams = new URLSearchParams(window.location.search);
const directPass = urlParams.get('pass');
if (directPass) {
  document.getElementById('voucher-code-input').value = directPass;
}

document.getElementById('player-name-input').value = playerName;

// أحداث الواجهة
document.getElementById('btn-audio-toggle').onclick = () => {
  sfx.muted = !sfx.muted;
  document.getElementById('btn-audio-toggle').textContent = sfx.muted ? '🔇' : '🔊';
};

document.getElementById('btn-submit-auth').onclick = () => {
  const name = document.getElementById('player-name-input').value.trim() || `لاعب-${playerId.slice(-4)}`;
  const voucher = document.getElementById('voucher-code-input').value.trim();
  if (!voucher) return alert('يرجى كتابة كود التذكرة للدخول!');

  localStorage.setItem('km_player_name', name);
  playerName = name;
  socket.emit('auth_player', { playerId, name, voucherCode: voucher });
};

socket.on('auth_result', (res) => {
  if (res.success) {
    document.getElementById('auth-gate').classList.add('hidden');
    document.getElementById('lobby-screen').classList.remove('hidden');
    document.getElementById('lobby-username').textContent = res.name;
    document.getElementById('lobby-userid').textContent = `ID: ${res.playerId}`;
  } else {
    alert(res.message);
  }
});

// إدارة الغرفة
document.getElementById('btn-create-room').onclick = () => socket.emit('create_room');
document.getElementById('btn-join-room').onclick = () => {
  const code = document.getElementById('room-code-input').value.trim();
  if (code) socket.emit('join_room', { roomCode: code });
};

socket.on('room_joined', ({ roomCode, isHost }) => {
  currentRoomCode = roomCode;
  document.getElementById('lobby-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('hidden');
  document.getElementById('display-room-code').textContent = roomCode;

  if (isHost) {
    const startBtn = document.createElement('button');
    startBtn.id = 'btn-host-start';
    startBtn.className = 'btn primary-btn';
    startBtn.textContent = 'بدء الجولة 🚀';
    startBtn.onclick = () => socket.emit('start_game');
    document.getElementById('turn-actions').prepend(startBtn);
  }
});

document.getElementById('btn-leave-room').onclick = () => location.reload();

// سحب كارت من المقلوب
document.getElementById('draw-deck').onclick = () => {
  if (!isMyTurn() || currentGameState.drawnCard) return;
  sfx.drawCard();
  socket.emit('draw_card');
};

// أخذ الكارت المكشوف
document.getElementById('discard-deck').onclick = () => {
  if (!isMyTurn() || currentGameState.drawnCard) return;
  sfx.drawCard();
  socket.emit('take_discard');
};

// رمي الكارت المسحوب
document.getElementById('btn-discard-drawn').onclick = () => {
  if (!isMyTurn() || !currentGameState.drawnCard) return;
  sfx.discardCard();
  socket.emit('discard_drawn');
};

// ضغط زر "كمّلتها! 👑"
document.getElementById('btn-kamelha').onclick = () => {
  sfx.kamelha();
  socket.emit('declare_kamelha');
};

function isMyTurn() {
  return currentGameState && currentGameState.currentTurnPlayerId === playerId && currentGameState.status === 'playing';
}

// استقبال تحديث حالة اللعبة
socket.on('game_state', (state) => {
  currentGameState = state;
  renderGame(state);
});

function renderGame(state) {
  // إخفاء زر البدء للهوست لو اللعبة شغالة
  const hostStartBtn = document.getElementById('btn-host-start');
  if (hostStartBtn && state.status === 'playing') hostStartBtn.remove();

  // تحديث عداد الكروت المقلوبة
  document.getElementById('deck-counter').textContent = state.deckCount;

  // تحديث الخصوم
  const oppContainer = document.getElementById('opponents-container');
  oppContainer.innerHTML = '';
  state.players.forEach(p => {
    if (p.playerId === playerId) return;
    const div = document.createElement('div');
    div.className = `opponent-card ${p.isCurrentTurn ? 'active-turn' : ''} ${p.immune ? 'immune-lock' : ''}`;
    div.innerHTML = `
      <div class="opp-name">${p.isHost ? '👑 ' : ''}${p.isTopScorer ? '🏆 ' : ''}${p.name}</div>
      <div class="opp-cards-count">🎴 ${p.cardCount} كروت</div>
      <div class="opp-score">نقاط: ${p.score} ${p.immune ? '🔒' : ''}</div>
    `;
    oppContainer.appendChild(div);
  });

  // تحديث الأرض المكشوفة
  const discardSlot = document.getElementById('discard-deck');
  discardSlot.innerHTML = '';
  if (state.discardTop) {
    discardSlot.appendChild(createCardElement(state.discardTop));
  } else {
    discardSlot.innerHTML = '<div class="card-placeholder">الأرض فارغة</div>';
  }
  const labelD = document.createElement('span');
  labelD.className = 'slot-label';
  labelD.textContent = 'الأرض المكشوفة';
  discardSlot.appendChild(labelD);

  // تحديث الكارت المسحوب مؤقتاً
  const drawnSlot = document.getElementById('drawn-slot');
  drawnSlot.innerHTML = '';
  const discardDrawnBtn = document.getElementById('btn-discard-drawn');

  if (state.drawnCard && !state.drawnCard.hidden) {
    drawnSlot.appendChild(createCardElement(state.drawnCard));
    if (isMyTurn()) discardDrawnBtn.classList.remove('hidden');
  } else {
    discardDrawnBtn.classList.add('hidden');
  }

  // تحديث يد اللاعب
  const handContainer = document.getElementById('my-hand');
  handContainer.innerHTML = '';
  state.myHand.forEach((card, index) => {
    const cardEl = createCardElement(card);
    cardEl.onclick = () => {
      // لو سحب كارت، الضغط على كارت باليد يبدله معه
      if (isMyTurn() && state.drawnCard) {
        sfx.discardCard();
        socket.emit('swap_card', { handCardIndex: index });
      }
    };
    handContainer.appendChild(cardEl);
  });

  // تحديث شريط الحالة السفلي
  const statusTag = document.getElementById('player-status-tag');
  if (isMyTurn()) {
    statusTag.textContent = state.drawnCard ? 'اختر كارت من يدك لتبديله، أو اضغط رمي في المكشوف' : 'دورك: اسحب كارت من المقلوب أو خذ المكشوف!';
    statusTag.style.background = '#f59e0b';
    statusTag.style.color = '#000';
  } else {
    const turnPlayer = state.players.find(p => p.isCurrentTurn);
    statusTag.textContent = turnPlayer ? `دور اللاعب: ${turnPlayer.name}` : 'في انتظار بدء اللعب...';
    statusTag.style.background = '#334155';
    statusTag.style.color = '#fff';
  }

  // فحص الكوماند المطلوب تنفيذه
  if (state.pendingAction && state.pendingAction.initiatorId === playerId) {
    showCommandModal(state.pendingAction);
  } else {
    document.getElementById('command-modal').classList.add('hidden');
  }
}

function createCardElement(card) {
  const div = document.createElement('div');
  div.className = `card ${card.type === 'command' ? 'command-card' : ''}`;
  div.style.borderColor = card.color;

  if (card.type === 'number') {
    div.style.color = card.color;
    div.innerHTML = `
      <span>${card.value}</span>
      <div class="card-value-center">${card.value}</div>
      <span style="text-align: left;">${card.value}</span>
    `;
  } else {
    div.innerHTML = `
      <div class="card-name-title" style="color: ${card.color}">${card.name}</div>
      <div class="card-value-center">${card.cmd === 'joker' ? '🃏' : '⚡'}</div>
      <div style="font-size:0.6rem; color: #94a3b8; text-align: center;">${card.cmd}</div>
    `;
  }
  return div;
}

// نافذة تنفيذ وتوجيه الكوماند
function showCommandModal(action) {
  sfx.command();
  const modal = document.getElementById('command-modal');
  const title = document.getElementById('cmd-modal-title');
  const desc = document.getElementById('cmd-modal-desc');
  const targets = document.getElementById('cmd-targets-container');
  const values = document.getElementById('cmd-values-container');

  modal.classList.remove('hidden');
  targets.innerHTML = '';
  values.innerHTML = '';
  values.classList.add('hidden');
  selectedCommandTarget = null;
  selectedCommandValue = null;

  title.textContent = `تفعيل أمر: ${action.cmd}`;

  // تصفية اللاعبين واختيار الهدف (مع استبعاد المحميين بحصانة)
  const eligible = currentGameState.players.filter(p => p.playerId !== playerId && !p.immune);

  eligible.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'target-btn';
    btn.textContent = p.name;
    btn.onclick = () => {
      document.querySelectorAll('.target-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedCommandTarget = p.playerId;
    };
    targets.appendChild(btn);
  });

  if (action.cmd === 'catch') {
    desc.textContent = 'اختر اللاعب والكرت المطلوب صيده:';
    values.classList.remove('hidden');
    for (let i = 1; i <= 10; i++) {
      const vBtn = document.createElement('button');
      vBtn.className = 'val-btn';
      vBtn.textContent = `${i}`;
      vBtn.onclick = () => {
        document.querySelectorAll('.val-btn').forEach(b => b.classList.remove('selected'));
        vBtn.classList.add('selected');
        selectedCommandValue = i;
      };
      values.appendChild(vBtn);
    }
    const jBtn = document.createElement('button');
    jBtn.className = 'val-btn';
    jBtn.textContent = 'جوكر 🃏';
    jBtn.onclick = () => {
      document.querySelectorAll('.val-btn').forEach(b => b.classList.remove('selected'));
      jBtn.classList.add('selected');
      selectedCommandValue = 'joker';
    };
    values.appendChild(jBtn);
  } else if (action.cmd === 'whatever') {
    desc.textContent = 'اختر كارت الكوماند الذي تريده:';
    targets.innerHTML = '';
    const commandsList = [
      { id: 'catch', name: 'اصطاد كارتك 🎣' },
      { id: 'take_discard', name: 'لم كمالتك 🧲' },
      { id: 'reverse', name: 'اعكس لفتك 🔄' },
      { id: 'force_discard', name: 'هو كدة 💥' },
      { id: 'mischief', name: 'رخم عليهم 🕵️' }
    ];
    commandsList.forEach(c => {
      const b = document.createElement('button');
      b.className = 'target-btn';
      b.textContent = c.name;
      b.onclick = () => {
        document.querySelectorAll('.target-btn').forEach(el => el.classList.remove('selected'));
        b.classList.add('selected');
        selectedCommandValue = c.id;
      };
      targets.appendChild(b);
    });
  }
}

document.getElementById('btn-confirm-command').onclick = () => {
  if (!selectedCommandTarget && currentGameState.pendingAction.cmd !== 'whatever') {
    return alert('يرجى اختيار اللاعب المستهدف!');
  }
  socket.emit('resolve_command', {
    targetPlayerId: selectedCommandTarget,
    requestedValue: selectedCommandValue,
    chosenCommand: selectedCommandValue
  });
  document.getElementById('command-modal').classList.add('hidden');
};

document.getElementById('btn-cancel-command').onclick = () => {
  socket.emit('resolve_command', { cancel: true });
  document.getElementById('command-modal').classList.add('hidden');
};

// استجابة تجسس "رخم عليهم" في اللعب الثنائي
socket.on('mischief_peek', ({ card, targetHandIndex, targetId }) => {
  const wantSwap = confirm(`تجسست على كارت الخصم وهو: [ ${card.name} ]!\nهل تريد تبديله بكارت من يدك؟`);
  let myIdx = 0;
  if (wantSwap) {
    const input = prompt('أدخل رقم الكارت من يدك للتبديل (1 إلى 4):', '1');
    myIdx = Math.max(0, Math.min(3, (parseInt(input) || 1) - 1));
  }
  socket.emit('resolve_mischief_swap', {
    doSwap: wantSwap,
    targetId,
    targetHandIndex,
    myHandIndex: myIdx
  });
});

// المؤقت والتنبيهات
socket.on('timer_tick', ({ time }) => {
  document.getElementById('timer-display').textContent = `⏱️ ${time}`;
  if (time <= 4 && time > 0) sfx.tick();
});

socket.on('game_alert', (msg) => {
  const banner = document.getElementById('game-alert-banner');
  banner.textContent = msg;
  banner.classList.remove('hidden');
  setTimeout(() => banner.classList.add('hidden'), 4500);
});

socket.on('error_msg', (msg) => alert(msg));

// كشف الكروت في نهاية الجولة (8 ثوانٍ)
socket.on('round_ended', ({ players, matchWinner }) => {
  const modal = document.getElementById('round-reveal-modal');
  const container = document.getElementById('reveal-players-container');
  container.innerHTML = '';
  modal.classList.remove('hidden');

  players.forEach(p => {
    const box = document.createElement('div');
    box.className = 'reveal-user-box';
    box.innerHTML = `
      <div style="font-weight:bold; color:var(--accent-gold);">${p.name} (${p.score} نقطة)</div>
      <div style="font-size:0.75rem;">${p.declaredKamelha ? 'أعلن كمّلتها 👑' : ''}</div>
      <div class="mini-cards-row">
        ${p.hand.map(c => `<div class="mini-card" style="border:1px solid ${c.color}">${c.value || c.cmd}</div>`).join('')}
      </div>
    `;
    container.appendChild(box);
  });

  if (matchWinner) {
    setTimeout(() => {
      modal.classList.add('hidden');
      document.getElementById('game-over-modal').classList.remove('hidden');
      document.getElementById('winner-name-text').textContent = `مبروك يا ${matchWinner.name}! 👑`;
      sfx.win();
    }, 4000);
  } else {
    setTimeout(() => modal.classList.add('hidden'), 8000);
  }
});

socket.on('force_disconnect', (msg) => {
  alert(msg);
  location.reload();
});

// دوال النوافذ المساعدة
window.openRulesModal = () => document.getElementById('rules-modal').classList.remove('hidden');
window.closeRulesModal = () => document.getElementById('rules-modal').classList.add('hidden');
window.openShopModal = () => document.getElementById('shop-modal').classList.remove('hidden');
window.closeShopModal = () => document.getElementById('shop-modal').classList.add('hidden');
document.getElementById('btn-open-rules').onclick = window.openRulesModal;
document.getElementById('btn-buy-physical').onclick = window.openShopModal;