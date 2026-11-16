# 千人現場即時互動系統 (`live-stage-interact`)

依據《千人現場即時互動系統 — 專案規劃與系統規格書》打造，支援讀取 **Google Sheets** 題庫並與現場 $1,000 \sim 3,000$ 人透過手機即時互動。

## 快速啟動

1. **啟動伺服器**：
   ```bash
   npm start
   ```
2. **開啟三個端點**：
   - **大螢幕端（投影幕按 F11 全螢幕）**：`http://localhost:3000/stage`
   - **控場後台（預設密碼 `2026`）**：`http://localhost:3000/admin`
   - **家長手機端（掃描大螢幕 QR Code）**：`http://<區網IP或網域>:3000/`

> 提示：可複製 `.env.example` 為 `.env`，自訂 `PORT`、`ADMIN_PASSWORD`、`EVENT_TITLE` 與預設 `GOOGLE_SHEET_CSV_URL`。

## 串接 Google Sheets 題庫

1. 建立試算表，欄位依序為：`order, mode, title, subtitle, opt_1, opt_2, opt_3, opt_4, opt_5, correct_opt, explanation, timer_sec`（可直接匯入專案內的 `sample-questions.csv`）。
2. 於 Google 試算表點選 **「檔案 → 共享 → 發布到網路」**，格式選擇 **「逗號分隔值 (.csv)」**，複製產生的連結。
3. 進入 `/admin` 控場後台，貼上該 CSV 連結並點擊 **「同步題庫」** 即可即時載入（伺服器會快取題庫，千人連線不會觸發 Google API 限流）。

## 六大互動模式 (`mode`)

- `BUBBLE`：物理碰撞氣泡圖（彈性碰撞、向心引力、第一名皇冠光暈）
- `SPECTRUM`：理念天平 / 雙向拔河（0~100 傾向滑桿與即時傾斜天平）
- `MYTH`：破除迷思限時競賽（倒數階段隱藏分佈防從眾，揭曉後顯示答對率圓環與解析）
- `QUADRANT`：二維心態落點矩陣（千人粒子飛入、熱力聚合與全場平均重心）
- `TREE`：親師共育之樹（流光飛向樹梢綻放為發光葉片與祝福語）
- `DANMAKU`：滾動彈幕 + 講者聚焦牆（內建敏感詞過濾，後台可一鍵推上大螢幕中央聚焦）

## 大螢幕快捷鍵 (`/stage`)

- `H`：顯示 / 隱藏右上角 QR Code
- `1` ~ `5`：手動微調第 1~5 選項票數（彩排或應急備用）
- `B`：模擬 50 人同時湧入測試
- `F`：切換全螢幕

## 1,500 併發壓力測試

在 `/admin` 切入任一題目並保持「開放作答」後，執行：
```bash
npm run load-test
```
即可模擬 1,500 筆併發投票寫入並驗證零掉票。
