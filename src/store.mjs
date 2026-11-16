const BAD_WORDS = [
  '幹你娘', '靠北', '靠腰', '白痴', '智障', '垃圾', '去死', 'fuck', 'shit', 'bitch', 'asshole',
];

export function filterSensitiveText(input) {
  let text = String(input || '').replace(/[\r\n\t]+/g, ' ').trim();
  for (const w of BAD_WORDS) {
    const re = new RegExp(w, 'gi');
    text = text.replace(re, '***');
  }
  return text;
}

function createQuestionData(q) {
  const counts = {};
  for (const opt of q.options) {
    counts[opt.key] = 0;
  }
  return {
    voters: new Set(),
    totalVotes: 0,
    counts,
    // SPECTRUM
    sumScore: 0,
    // QUADRANT
    sumX: 0,
    sumY: 0,
    points: [],
    // TREE
    blessings: [],
    // DANMAKU
    messages: [],
    spotlightId: null,
    lastDanmakuByUuid: new Map(),
  };
}

export class RoomStore {
  constructor({ eventTitle = '千人現場即時互動系統' } = {}) {
    this.eventTitle = eventTitle;
    this.sheetUrl = '';
    this.sheetSource = '';
    this.allQuestions = [];
    this.groups = [];
    this.activeGroup = '__ALL__';
    this.questions = [];
    this.dataByQId = new Map();

    this.standby = true;
    this.currentQuestionIndex = 0;
    this.status = 'VOTING'; // VOTING | LOCKED | REVEALED
    this.timerEndsAt = 0;
    this.stateVersion = 1;
    this._timerHandle = null;
    this._listeners = new Set();
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify(eventType = 'state') {
    this.stateVersion++;
    for (const fn of this._listeners) {
      try {
        fn(eventType);
      } catch {
        // Ignore listener errors
      }
    }
  }

  setQuestions(questions, source = '', sheetUrl = '') {
    this.allQuestions = questions;
    this.sheetSource = source;
    if (sheetUrl !== undefined) this.sheetUrl = sheetUrl;

    const groupCounts = new Map();
    for (const q of questions) {
      if (!this.dataByQId.has(q.id)) {
        this.dataByQId.set(q.id, createQuestionData(q));
      }
      const g = q.group || '預設題組';
      groupCounts.set(g, (groupCounts.get(g) || 0) + 1);
    }
    this.groups = Array.from(groupCounts.entries()).map(([name, count]) => ({ name, count }));

    if (this.activeGroup !== '__ALL__' && !groupCounts.has(this.activeGroup)) {
      this.activeGroup = '__ALL__';
    }
    this._applyActiveGroup();
    this._notify('questions');
  }

  _applyActiveGroup() {
    if (this.activeGroup === '__ALL__') {
      this.questions = this.allQuestions;
    } else {
      this.questions = this.allQuestions.filter((q) => (q.group || '預設題組') === this.activeGroup);
    }
    if (this.currentQuestionIndex >= this.questions.length) {
      this.currentQuestionIndex = 0;
    }
  }

  setGroup(groupName) {
    const target = groupName || '__ALL__';
    if (target !== '__ALL__' && !this.groups.some((g) => g.name === target)) {
      return false;
    }
    this.activeGroup = target;
    this._applyActiveGroup();
    this.currentQuestionIndex = 0;
    this.status = 'VOTING';
    this._startTimerIfNeeded(this.getCurrentQuestion());
    this._notify('state');
    return true;
  }

  getCurrentQuestion() {
    return this.questions[this.currentQuestionIndex] || null;
  }

  getQuestionData(q) {
    if (!q) return null;
    if (!this.dataByQId.has(q.id)) {
      this.dataByQId.set(q.id, createQuestionData(q));
    }
    return this.dataByQId.get(q.id);
  }

  _clearTimer() {
    if (this._timerHandle) {
      clearTimeout(this._timerHandle);
      this._timerHandle = null;
    }
    this.timerEndsAt = 0;
  }

  _startTimerIfNeeded(q) {
    this._clearTimer();
    if (!q || this.standby || this.status !== 'VOTING' || !q.timerSec || q.timerSec <= 0) {
      return;
    }
    this.timerEndsAt = Date.now() + q.timerSec * 1000;
    this._timerHandle = setTimeout(() => {
      if (this.status === 'VOTING') {
        this.status = 'LOCKED';
        this.timerEndsAt = 0;
        this._notify('state');
      }
    }, q.timerSec * 1000);
  }

  setStandby(val) {
    this.standby = Boolean(val);
    if (this.standby) {
      this._clearTimer();
    } else {
      this.status = 'VOTING';
      this._startTimerIfNeeded(this.getCurrentQuestion());
    }
    this._notify('state');
  }

  goToQuestion(index) {
    if (index < 0 || index >= this.questions.length) return false;
    this.standby = false;
    this.currentQuestionIndex = index;
    this.status = 'VOTING';
    this._startTimerIfNeeded(this.getCurrentQuestion());
    this._notify('state');
    return true;
  }

  setStatus(newStatus) {
    if (!['VOTING', 'LOCKED', 'REVEALED'].includes(newStatus)) return false;
    this.standby = false;
    this.status = newStatus;
    if (newStatus === 'VOTING') {
      this._startTimerIfNeeded(this.getCurrentQuestion());
    } else {
      this._clearTimer();
    }
    this._notify('state');
    return true;
  }

  resetCurrentQuestion() {
    const q = this.getCurrentQuestion();
    if (!q) return false;
    this.dataByQId.set(q.id, createQuestionData(q));
    this.status = 'VOTING';
    this._startTimerIfNeeded(q);
    this._notify('data');
    return true;
  }

  /**
   * Minimal payload sent to 3,000 mobile clients (< 1 KB)
   */
  getMobileState() {
    const q = this.getCurrentQuestion();
    if (!q || this.standby) {
      return {
        v: this.stateVersion,
        standby: true,
        eventTitle: this.eventTitle,
        qIdx: this.currentQuestionIndex,
        qTotal: this.questions.length,
      };
    }
    const base = {
      v: this.stateVersion,
      standby: false,
      eventTitle: this.eventTitle,
      qIdx: this.currentQuestionIndex,
      qTotal: this.questions.length,
      qId: q.id,
      group: q.group || '預設題組',
      mode: q.mode,
      title: q.title,
      subtitle: q.subtitle,
      options: q.options,
      status: this.status,
      timerEndsAt: this.timerEndsAt,
    };
    if (q.mode === 'MYTH' && this.status === 'REVEALED') {
      base.correctOpt = q.correctOpt;
      base.explanation = q.explanation;
    }
    return base;
  }

  /**
   * Full payload for Stage Display & Admin
   */
  getStageState() {
    const q = this.getCurrentQuestion();
    const d = this.getQuestionData(q);
    const mobile = this.getMobileState();
    if (!q || !d) {
      return { ...mobile, stats: null };
    }

    const stats = {
      totalVotes: d.totalVotes,
      counts: d.counts,
      avgSpectrum: d.totalVotes > 0 ? Math.round((d.sumScore / d.totalVotes) * 10) / 10 : 50,
      avgX: d.totalVotes > 0 ? Math.round((d.sumX / d.totalVotes) * 10) / 10 : 50,
      avgY: d.totalVotes > 0 ? Math.round((d.sumY / d.totalVotes) * 10) / 10 : 50,
      recentPoints: d.points.slice(-600),
      recentBlessings: d.blessings.slice(-40),
      messages: d.messages.filter((m) => !m.hidden).slice(-80),
      spotlightId: d.spotlightId,
    };

    return {
      ...mobile,
      correctOpt: q.correctOpt,
      explanation: q.explanation,
      stats,
    };
  }

  getAdminState() {
    const q = this.getCurrentQuestion();
    const d = this.getQuestionData(q);
    return {
      ...this.getStageState(),
      sheetUrl: this.sheetUrl,
      sheetSource: this.sheetSource,
      activeGroup: this.activeGroup,
      groups: this.groups,
      totalAllQuestions: this.allQuestions.length,
      questions: this.questions.map((item, i) => ({
        index: i,
        id: item.id,
        group: item.group || '預設題組',
        order: item.order,
        mode: item.mode,
        title: item.title,
        timerSec: item.timerSec,
      })),
      allMessages: d ? d.messages.slice().reverse() : [],
    };
  }

  /**
   * Submit a vote / interaction from a mobile client (or load test).
   */
  submitVote({ qId, uuid, payload }) {
    const q = this.getCurrentQuestion();
    if (!q || this.standby) {
      return { ok: false, code: 'STANDBY', message: '活動尚未開始或處於待機畫面' };
    }
    if (qId && qId !== q.id) {
      return { ok: false, code: 'STALE_QUESTION', message: '題目已切換，請作答目前題目' };
    }
    if (this.status !== 'VOTING') {
      return { ok: false, code: 'LOCKED', message: '本題已截止作答' };
    }
    const cleanUuid = String(uuid || '').trim().slice(0, 64);
    if (!cleanUuid) {
      return { ok: false, code: 'MISSING_UUID', message: '缺少裝置識別碼' };
    }

    const d = this.getQuestionData(q);

    if (q.mode === 'DANMAKU') {
      const now = Date.now();
      const last = d.lastDanmakuByUuid.get(cleanUuid) || 0;
      if (now - last < 3000) {
        return { ok: false, code: 'RATE_LIMIT', message: '發送太快了，請稍候 3 秒再試' };
      }
      const rawText = String(payload?.text || '').trim();
      if (!rawText) {
        return { ok: false, code: 'EMPTY', message: '請輸入提問內容' };
      }
      const text = filterSensitiveText(rawText).slice(0, 60);
      const tag = String(payload?.tag || '提問').slice(0, 12);
      const msg = {
        id: `m_${now}_${Math.random().toString(36).slice(2, 7)}`,
        tag,
        text,
        ts: now,
        hidden: false,
      };
      d.messages.push(msg);
      if (d.messages.length > 500) d.messages.shift();
      d.totalVotes++;
      d.voters.add(cleanUuid);
      d.lastDanmakuByUuid.set(cleanUuid, now);
      this._notify('danmaku');
      return { ok: true, message: '提問已送出', id: msg.id };
    }

    // Deduplication for all voting / interactive modes
    if (d.voters.has(cleanUuid)) {
      return { ok: false, code: 'DUPLICATE', message: '您已完成本題作答' };
    }

    if (q.mode === 'BUBBLE' || q.mode === 'MYTH') {
      const optKey = String(payload?.optKey || '');
      if (!(optKey in d.counts)) {
        return { ok: false, code: 'INVALID_OPTION', message: '無效的選項' };
      }
      d.voters.add(cleanUuid);
      d.counts[optKey]++;
      d.totalVotes++;
      this._notify('data');
      return { ok: true, message: '作答已送出' };
    }

    if (q.mode === 'SPECTRUM') {
      const score = Number(payload?.score);
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        return { ok: false, code: 'INVALID_SCORE', message: '數值需介於 0 ~ 100' };
      }
      d.voters.add(cleanUuid);
      d.sumScore += score;
      if (score < 50 && q.options[0]) d.counts[q.options[0].key]++;
      else if (q.options[1]) d.counts[q.options[1].key]++;
      d.totalVotes++;
      this._notify('data');
      return { ok: true, message: '傾向已送出' };
    }

    if (q.mode === 'QUADRANT') {
      const x = Number(payload?.x);
      const y = Number(payload?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
        return { ok: false, code: 'INVALID_COORDS', message: '座標需介於 0 ~ 100' };
      }
      d.voters.add(cleanUuid);
      d.sumX += x;
      d.sumY += y;
      d.totalVotes++;
      d.points.push({ x, y });
      if (d.points.length > 3000) d.points.shift();
      this._notify('data');
      return { ok: true, message: '落點已送出' };
    }

    if (q.mode === 'TREE') {
      const rawText = String(payload?.text || '').trim();
      const text = rawText ? filterSensitiveText(rawText).slice(0, 20) : '點亮願景燈火 ✨';
      d.voters.add(cleanUuid);
      d.totalVotes++;
      d.blessings.push({
        id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text,
        ts: Date.now(),
      });
      if (d.blessings.length > 300) d.blessings.shift();
      this._notify('data');
      return { ok: true, message: '已點亮願景燈火！' };
    }

    return { ok: false, code: 'UNSUPPORTED', message: '不支援的題型' };
  }

  setSpotlight(msgId) {
    const q = this.getCurrentQuestion();
    const d = this.getQuestionData(q);
    if (!q || !d) return false;
    d.spotlightId = msgId || null;
    this._notify('data');
    return true;
  }

  toggleHideMessage(msgId, hidden) {
    const q = this.getCurrentQuestion();
    const d = this.getQuestionData(q);
    if (!q || !d) return false;
    const msg = d.messages.find((m) => m.id === msgId);
    if (!msg) return false;
    msg.hidden = Boolean(hidden);
    if (msg.hidden && d.spotlightId === msgId) d.spotlightId = null;
    this._notify('data');
    return true;
  }

  /**
   * Contingency hotkeys (1-5) on Stage: manually adjust votes
   */
  adjustVoteHotkey(optNum, delta = 5) {
    const q = this.getCurrentQuestion();
    const d = this.getQuestionData(q);
    if (!q || !d) return false;
    const key = `opt_${optNum}`;
    if (key in d.counts) {
      d.counts[key] = Math.max(0, d.counts[key] + delta);
      d.totalVotes += delta;
      this._notify('data');
      return true;
    }
    return false;
  }

  /**
   * Rehearsal hotkey (B): simulate burst of 50 virtual participants
   */
  simulateBurst(count = 50) {
    const q = this.getCurrentQuestion();
    if (!q) return false;
    const d = this.getQuestionData(q);
    for (let i = 0; i < count; i++) {
      const fakeId = `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      if (q.mode === 'BUBBLE' || q.mode === 'MYTH') {
        const opts = q.options;
        if (opts.length > 0) {
          const pick = opts[Math.floor(Math.random() * opts.length)].key;
          d.counts[pick]++;
          d.totalVotes++;
        }
      } else if (q.mode === 'SPECTRUM') {
        const score = Math.round(Math.random() * 100);
        d.sumScore += score;
        if (score < 50 && q.options[0]) d.counts[q.options[0].key]++;
        else if (q.options[1]) d.counts[q.options[1].key]++;
        d.totalVotes++;
      } else if (q.mode === 'QUADRANT') {
        const x = Math.round(25 + Math.random() * 55);
        const y = Math.round(30 + Math.random() * 55);
        d.sumX += x;
        d.sumY += y;
        d.totalVotes++;
        d.points.push({ x, y });
      } else if (q.mode === 'TREE') {
        const samples = ['快樂成長！', '孩子加油！', '期待開學', '遇見好老師', '平安健康'];
        d.totalVotes++;
        d.blessings.push({ id: fakeId, text: samples[i % samples.length], ts: Date.now() });
      } else if (q.mode === 'DANMAKU') {
        if (i < 5) {
          const qs = ['請問雙語課程每週幾節？', '校車路線有涵蓋市區嗎？', '社團活動時間怎麼安排？', '請問有晚自習嗎？', '午餐是學校自設廚房嗎？'];
          d.messages.push({ id: fakeId, tag: '課程與教學', text: qs[i % qs.length], ts: Date.now(), hidden: false });
          d.totalVotes++;
        }
      }
    }
    this._notify('data');
    return true;
  }
}
