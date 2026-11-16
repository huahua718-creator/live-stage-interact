/**
 * Phase 3 高併發壓力測試腳本：模擬 1,500 名家長於短時間內同時送出投票
 * 執行方式：先啟動 npm start，再執行 npm run load-test
 */
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const CONCURRENCY = Number.parseInt(process.env.COUNT || '1500', 10);

async function main() {
  const stateRes = await fetch(`${BASE_URL}/api/state`);
  const state = await stateRes.json();
  if (state.standby) {
    console.error('❌ 目前處於待機畫面，請先至 /admin 切入任一題目並開放作答後再進行壓測！');
    process.exit(1);
  }

  console.log(`🚀 開始對題目 [${state.mode}] ${state.title} 發送 ${CONCURRENCY} 筆併發請求...`);
  const start = performance.now();

  let okCount = 0;
  let failCount = 0;

  // Send in batches of 150 concurrent requests to avoid local Windows ephemeral port exhaustion
  const BATCH = 150;
  for (let offset = 0; offset < CONCURRENCY; offset += BATCH) {
    const batchPromises = [];
    for (let i = 0; i < BATCH && offset + i < CONCURRENCY; i++) {
      const idx = offset + i;
      const uuid = `loadtest_${Date.now()}_${idx}`;
      let payload = {};
      if (state.mode === 'BUBBLE' || state.mode === 'MYTH') {
        const opts = state.options || [];
        payload = { optKey: opts[idx % opts.length].key };
      } else if (state.mode === 'SPECTRUM') {
        payload = { score: idx % 101 };
      } else if (state.mode === 'QUADRANT') {
        payload = { x: (idx * 7) % 101, y: (idx * 13) % 101 };
      } else if (state.mode === 'TREE') {
        payload = { text: `祝福 #${idx}` };
      } else if (state.mode === 'DANMAKU') {
        payload = { tag: '測試提問', text: `壓測提問內容 #${idx}` };
      }

      batchPromises.push(
        fetch(`${BASE_URL}/api/vote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qId: state.qId, uuid, payload }),
        })
          .then((r) => r.json())
          .then((d) => (d.ok ? okCount++ : failCount++))
          .catch(() => failCount++),
      );
    }
    await Promise.all(batchPromises);
  }

  const elapsed = ((performance.now() - start) / 1000).toFixed(2);
  console.log(`✅ 壓測完成！耗時 ${elapsed} 秒`);
  console.log(`   成功寫入：${okCount} 筆｜失敗/拒絕：${failCount} 筆`);
}

main();
